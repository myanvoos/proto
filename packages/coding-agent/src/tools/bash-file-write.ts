import { findBashKernelCells } from "./bash-kernel-cell";

export interface BashFileWriteSpan {
	path: string;
	code: string;
	start: number;
	end: number;
}

interface HeredocOpener {
	start: number;
	delimiter: string;
	dash: boolean;
}

interface FileWriteCandidate extends HeredocOpener {
	path: string;
}

const SHELL_BOUNDARY = String.raw`(?:^|(?:&&|\|\||[;|])[ \t]*)`;
const SHELL_WORD = String.raw`(?:'[^']*'|"[^"]*"|[^\s;&|<>]+)`;
const HEREDOC = String.raw`(?<here><<-?(?:[ \t]*(?:'[^']*'|"[^"]*"|[^\s;&|<>]+)))`;

/** Find source bodies written by the supported cat/tee heredoc forms. */
export function findBashFileWrites(command: string): BashFileWriteSpan[] {
	const kernelCells = findBashKernelCells(command);
	const writes: BashFileWriteSpan[] = [];
	let kernelIndex = 0;

	let lineStart = 0;
	while (lineStart <= command.length) {
		const newline = command.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? command.length : newline;
		const line = command.slice(lineStart, lineEnd);
		const candidates = new Map(findCandidates(line, lineStart).map(candidate => [candidate.start, candidate]));
		const openers = findHeredocOpeners(line, lineStart);

		if (openers.length > 0) {
			let bodyStart = newline === -1 ? command.length : newline + 1;
			for (const opener of openers) {
				const body = readHeredocBody(command, bodyStart, opener.delimiter, opener.dash);
				const candidate = candidates.get(opener.start);
				if (candidate) {
					const span = {
						path: candidate.path,
						code: body.code,
						start: bodyStart,
						end: bodyStart + body.rawLength,
					};
					while (kernelIndex < kernelCells.length && kernelCells[kernelIndex]!.end <= span.start) kernelIndex++;
					const kernel = kernelCells[kernelIndex];
					if (!kernel || kernel.start >= span.end) writes.push(span);
				}
				bodyStart = body.end;
			}
			lineStart = bodyStart;
			continue;
		}

		if (newline === -1) break;
		lineStart = newline + 1;
	}

	return writes.sort((a, b) => a.start - b.start);
}

function findCandidates(line: string, offset: number): FileWriteCandidate[] {
	const candidates: FileWriteCandidate[] = [];

	const beforeHeredoc = new RegExp(
		String.raw`${SHELL_BOUNDARY}cat[ \t]+(?:>|>>|>\|)[ \t]*(${SHELL_WORD})[ \t]+${HEREDOC}`,
		"gu",
	);
	for (const match of line.matchAll(beforeHeredoc)) {
		const here = match.groups?.here;
		if (!here) continue;
		const hereOffset = match[0].indexOf(here);
		const delimiter = parseHeredocToken(here);
		if (delimiter) {
			candidates.push({
				path: match[1]!,
				start: offset + match.index! + hereOffset,
				delimiter: delimiter.value,
				dash: delimiter.dash,
			});
		}
	}

	const afterHeredoc = new RegExp(
		String.raw`${SHELL_BOUNDARY}cat[ \t]+${HEREDOC}[ \t]+(?:>|>>|>\|)[ \t]*(${SHELL_WORD})`,
		"gu",
	);
	for (const match of line.matchAll(afterHeredoc)) {
		const here = match.groups?.here;
		if (!here) continue;
		const hereOffset = match[0].indexOf(here);
		const delimiter = parseHeredocToken(here);
		if (delimiter) {
			candidates.push({
				path: match[2]!,
				start: offset + match.index! + hereOffset,
				delimiter: delimiter.value,
				dash: delimiter.dash,
			});
		}
	}

	const tee = new RegExp(
		String.raw`${SHELL_BOUNDARY}tee[ \t]+(?:(?:-a|--)[ \t]+)?(${SHELL_WORD})[ \t]+${HEREDOC}`,
		"gu",
	);
	for (const match of line.matchAll(tee)) {
		const here = match.groups?.here;
		if (!here) continue;
		const hereOffset = match[0].indexOf(here);
		const delimiter = parseHeredocToken(here);
		if (delimiter) {
			candidates.push({
				path: match[1]!,
				start: offset + match.index! + hereOffset,
				delimiter: delimiter.value,
				dash: delimiter.dash,
			});
		}
	}

	return candidates;
}

function findHeredocOpeners(line: string, offset: number): HeredocOpener[] {
	const openers: HeredocOpener[] = [];
	const openerRe = new RegExp(`(?<!<)${HEREDOC}`, "gu");
	for (const match of line.matchAll(openerRe)) {
		const here = match.groups?.here;
		if (!here) continue;
		const delimiter = parseHeredocToken(here);
		if (delimiter) {
			openers.push({
				start: offset + match.index!,
				delimiter: delimiter.value,
				dash: delimiter.dash,
			});
		}
	}
	return openers;
}

function parseHeredocToken(token: string): { value: string; dash: boolean } | undefined {
	const dash = token.startsWith("<<-");
	const value = token.slice(dash ? 3 : 2).trimStart();
	if (value.length === 0) return undefined;
	if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
		return { value: value.slice(1, -1), dash };
	}
	return { value, dash };
}

function readHeredocBody(
	command: string,
	bodyStart: number,
	delimiter: string,
	dash: boolean,
): { code: string; end: number; rawLength: number } {
	const rest = command.slice(bodyStart);
	const closeRe = new RegExp(
		String.raw`(?:^|\n)${dash ? "\\t*" : ""}${escapeRegExp(delimiter)}[ \t]*\r?(?:\n|$)`,
		"u",
	);
	const close = closeRe.exec(rest);
	const rawBody = close ? rest.slice(0, close.index) : rest.replace(/\n?$/u, "");
	return {
		code: dash ? rawBody.replace(/^\t+/gmu, "") : rawBody,
		end: close ? bodyStart + close.index + close[0].length : command.length,
		rawLength: rawBody.length,
	};
}

/**
 * The written path as a plain filesystem path: shell quoting removed and
 * separators normalized, so callers can read its extension or match it against
 * repo paths.
 */
export function normalizeBashWritePath(writePath: string): string {
	return writePath
		.replace(/^(?:'([^']*)'|"([^"]*)")$/u, (_, single: string | undefined, double: string | undefined) => {
			return single ?? double ?? writePath;
		})
		.replaceAll("\\", "/");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
