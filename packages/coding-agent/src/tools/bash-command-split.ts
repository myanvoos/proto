/**
 * Splits a single shell command string into one segment per top-level
 * subcommand, for multi-line command display.
 *
 * The scanner is quote-aware and never splits inside single or double
 * quotes, backslash escapes, heredoc bodies, or fd duplications (`2>&1`,
 * `&>`). Splits happen on `&&`, `||`, `;`, `|`, a lone `&` (background),
 * and newlines; each segment records the operator that followed it.
 */
export interface ShellCommandSegment {
	/** Trimmed command text, ready for display. */
	raw: string;
	/** Operator that introduced this segment: `&&`, `||`, `;`, `|`, `&`, `\n`, `\r`; `""` for the first. */
	separator: string;
}

interface HeredocDelimiter {
	delimiter: string;
	stripTabs: boolean;
}

const SHELL_WRAPPER = /^\s*(?:sh|bash|zsh|cmd(?:\.exe)?)\s+(?:\/c|-[A-Za-z]*c)\s+/;

/** Unwrap `bash -lc "inner"` / `sh -c 'inner'` / `cmd /c inner` style wrappers. */
export function stripShellWrapper(command: string): string {
	if (typeof command !== "string") return "";
	const match = SHELL_WRAPPER.exec(command);
	if (!match) return command.trim();
	let inner = command.substring(match[0].length).trim();
	if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
		inner = inner.substring(1, inner.length - 1);
	}
	return inner;
}

/**
 * Find heredoc openers (`<<[-]DELIM`) on one source line, outside quotes.
 * Several heredocs may be declared on one line; bodies arrive in order.
 */
function findHeredocDelimiters(line: string): HeredocDelimiter[] {
	const delimiters: HeredocDelimiter[] = [];
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length - 1; i++) {
		const ch = line[i];
		if (ch === "\\" && !inSingle) {
			i++;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle || inDouble || ch !== "<" || line[i + 1] !== "<" || line[i + 2] === "<") continue;
		let cursor = i + 2;
		const stripTabs = line[cursor] === "-";
		if (stripTabs) cursor++;
		while (line[cursor] === " " || line[cursor] === "\t") cursor++;
		const start = cursor;
		const quote = line[cursor] === "'" || line[cursor] === '"' ? line[cursor] : "";
		if (quote) {
			cursor++;
			while (cursor < line.length && line[cursor] !== quote) cursor++;
			if (line[cursor] === quote) cursor++;
		} else {
			while (cursor < line.length && !/[\s;&|<>]/.test(line[cursor])) cursor++;
		}
		const rawDelimiter = line.slice(start, cursor);
		const delimiter = unquote(rawDelimiter);
		if (delimiter) delimiters.push({ delimiter, stripTabs });
		i = cursor - 1;
	}
	return delimiters;
}

function unquote(token: string): string {
	let out = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < token.length; i++) {
		const ch = token[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else out += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < token.length) {
			const next = token[i + 1];
			if (inDouble && next !== "$" && next !== "`" && next !== '"' && next !== "\\") {
				out += ch;
				i++;
				continue;
			}
			out += next;
			i++;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = !inDouble;
			continue;
		}
		out += ch;
	}
	return out;
}

const IS_BLANK_LINE_SEPARATOR: Record<string, true> = { "\n": true, "\r": true };

/**
 * Split `command` into top-level segments. Heredoc bodies stay attached to
 * the segment that opened them and are never split.
 */
export function splitShellCommands(command: string): ShellCommandSegment[] {
	const text = stripShellWrapper(command);
	const segments: ShellCommandSegment[] = [];
	let buffer = "";
	let separator = "";
	let inSingle = false;
	let inDouble = false;
	const pendingHeredocs: HeredocDelimiter[] = [];

	function flush(flushChar: string): void {
		const raw = buffer.trim();
		if (raw) segments.push({ raw, separator });
		buffer = "";
		if (raw || !IS_BLANK_LINE_SEPARATOR[flushChar]) separator = flushChar;
	}

	for (const line of text.split(/(?<=\n)/)) {
		if (pendingHeredocs.length > 0) {
			buffer += line;
			const body = line.endsWith("\n") ? line.slice(0, -1).replace(/\r$/, "") : line;
			const active = pendingHeredocs[0];
			const comparable = active.stripTabs ? body.replace(/^\t+/, "") : body;
			if (comparable === active.delimiter) {
				pendingHeredocs.shift();
				// The closing delimiter line ends the segment it belongs to.
				if (pendingHeredocs.length === 0) flush("\n");
			}
			continue;
		}
		pendingHeredocs.push(...findHeredocDelimiters(line));
		scanLine(line);
	}
	flush("");
	return segments;

	function scanLine(line: string): void {
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			const next = line[i + 1];
			if (ch === "\\" && !inSingle && i < line.length - 1) {
				buffer += ch + next;
				i++;
				continue;
			}
			if (ch === "'" && !inDouble) inSingle = !inSingle;
			else if (ch === '"' && !inSingle) inDouble = !inDouble;
			if (inSingle || inDouble) {
				buffer += ch;
				continue;
			}
			if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
				flush(ch + next);
				i++;
				continue;
			}
			if (ch === "\n" || ch === "\r") {
				// A heredoc opener line's newline stays in the segment: the
				// body that follows belongs to this command, not the next one.
				if (pendingHeredocs.length > 0) buffer += ch;
				else flush(ch);
				continue;
			}
			if (ch === ";" || ch === "|") {
				flush(ch);
				continue;
			}
			if (ch === "&") {
				if (next === ">") buffer += ch;
				else if (/\d>$/.test(buffer.slice(-2))) buffer += ch;
				else if (next !== "&") flush(ch);
				else buffer += ch;
				continue;
			}
			buffer += ch;
		}
	}
}
