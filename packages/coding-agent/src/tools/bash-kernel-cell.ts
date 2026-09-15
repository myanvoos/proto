export interface BashKernelCell {
	language: "python" | "js";
	code: string;
}

/** A kernel cell plus the offsets of its raw code region (heredoc body or `-c` word) inside the command. */
export interface BashKernelCellSpan extends BashKernelCell {
	start: number;
	end: number;
}

const LANG_BY_CMD: Record<string, "python" | "js"> = {
	python: "python",
	python3: "python",
	node: "js",
	bun: "js",
};

const PASSTHROUGH_BEFORE_STDIN: Record<"python" | "js", RegExp> = {
	python: /^(?:\s|-u|-)*$/,
	js: /^(?:\s|-)*$/,
};

const FLAGS_BEFORE_CODE: Record<"python" | "js", RegExp> = {
	python: /^(?:\s+-u)*$/,
	js: /^$/,
};

const CODE_FLAG: Record<"python" | "js", string> = { python: "-c", js: "-e" };

// Assignment and wrapper tokens the shell absorbs before the interpreter that
// still route the invocation to a kernel cell: `FOO=1 BAR='a b' timeout 5
// python -c ...` executes the cell (env-prefix builtins and the timeout/nohup/
// time/command/builtin wrappers dispatch the interpreter builtin). `env` and
// `sudo` are deliberately absent — they exec a real interpreter.
const CELL_PREFIX_SOURCE =
	String.raw`(?:(?:[A-Za-z_][A-Za-z0-9_]*\+?=(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s;&|<>()"'])+)\s+)*` +
	String.raw`(?:(?:command|builtin|nohup|time|timeout)(?:\s+\S+)*\s+)*`;

const ANCHOR_SOURCE = String.raw`(?:^|[\n;&|({])`;

interface CellMatch {
	cell: BashKernelCellSpan;
	mixed: boolean;
	/** Command range the match owns (heredoc: open line through delimiter line); later matches inside it are body text. */
	consumedEnd: number;
}

/**
 * Find the first kernel cell embedded in a bash command. The renderer uses
 * this to keep kernel status/diff/JSON affordances for a command that also
 * contains ordinary shell syntax; it must not be used to execute the shell.
 */
export function detectBashKernelCell(command: string): BashKernelCell | undefined {
	const first = collectCellMatches(command)[0];
	return first ? { language: first.cell.language, code: first.cell.code } : undefined;
}

/** Whether the detected cell has shell source outside the interpreter call. */
export function isBashKernelCellMixed(command: string): boolean {
	return collectCellMatches(command)[0]?.mixed === true;
}

/** Every kernel cell in the command with its raw code span, in source order. */
export function findBashKernelCells(command: string): BashKernelCellSpan[] {
	return collectCellMatches(command).map(match => match.cell);
}

function collectCellMatches(command: string): CellMatch[] {
	const matches = findHeredocCells(command);
	for (const flag of findFlagCells(command)) {
		// A `-c` word inside a heredoc body is interpreter input, not a shell call.
		if (matches.some(heredoc => flag.cell.start >= heredoc.cell.start && flag.cell.start < heredoc.consumedEnd)) {
			continue;
		}
		matches.push(flag);
	}
	return matches.sort((a, b) => a.cell.start - b.cell.start);
}

function findHeredocCells(command: string): CellMatch[] {
	const openRe = new RegExp(
		String.raw`${ANCHOR_SOURCE}\s*(${CELL_PREFIX_SOURCE})(\\?)(python3?|node|bun)\b([^\n]*?)<<(-?)\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\6([^\n]*)\n`,
		"g",
	);
	const matches: CellMatch[] = [];
	let open: RegExpExecArray | null = openRe.exec(command);
	while (open) {
		const openIndex = open.index;
		// Retry just past this anchor on rejection so a later interpreter call on
		// the same line (or a later line the lazy match swallowed) still gets seen.
		openRe.lastIndex = openIndex + 1;
		const language = LANG_BY_CMD[open[3]!];
		const accepted =
			language !== undefined && PASSTHROUGH_BEFORE_STDIN[language].test(open[4]!) && isShellContinuation(open[8]!);
		if (accepted) {
			const dash = open[5] === "-";
			const delimiter = open[7]!;
			const bodyStart = openIndex + open[0].length;
			const rest = command.slice(bodyStart);
			// An empty heredoc body closes on the very first line, so the body may
			// start at `^` rather than after a newline.
			const closeRe = new RegExp(String.raw`(?:^|\n)${dash ? "\t*" : ""}${delimiter}[ \t]*\r?(?:\n|$)`);
			const close = rest.match(closeRe);
			const rawBody = close ? rest.slice(0, close.index) : rest.replace(/\n?$/, "");
			const code = dash ? rawBody.replace(/^\t+/gm, "") : rawBody;
			// A closed heredoc consumes the newline after its delimiter. Anything
			// after that newline is another shell command, not an interpreter arg.
			const consumedEnd = close ? bodyStart + close.index! + close[0].length : command.length;
			if (code.trim().length > 0) {
				const suffix = command.slice(consumedEnd);
				const prefixIsShell = command.slice(0, openIndex).trim().length > 0;
				const mixed =
					prefixIsShell || open[1]!.length > 0 || open[8]!.trim().length > 0 || suffix.trim().length > 0;
				matches.push({
					cell: { language, code, start: bodyStart, end: bodyStart + rawBody.length },
					mixed,
					consumedEnd,
				});
				// Leave the delimiter line's newline in place: it anchors the next call.
				openRe.lastIndex = Math.max(openRe.lastIndex, consumedEnd - 1);
			}
		}
		open = openRe.exec(command);
	}
	return matches;
}

function findFlagCells(command: string): CellMatch[] {
	const openRe = new RegExp(
		String.raw`${ANCHOR_SOURCE}\s*(${CELL_PREFIX_SOURCE})(\\?)(python3?|node|bun)\b((?:\s+-[A-Za-z]+)*)\s+(-c|-e)\s+`,
		"g",
	);
	const matches: CellMatch[] = [];
	let open: RegExpExecArray | null = openRe.exec(command);
	while (open) {
		const openIndex = open.index;
		openRe.lastIndex = openIndex + 1;
		const language = LANG_BY_CMD[open[3]!];
		if (language && open[5] === CODE_FLAG[language] && FLAGS_BEFORE_CODE[language].test(open[4]!)) {
			const wordStart = openIndex + open[0].length;
			const parsed = parseFirstShellWord(command.slice(wordStart));
			if (parsed && parsed.word.trim().length > 0 && isShellContinuation(parsed.rest)) {
				const wordEnd = command.length - parsed.rest.length;
				const prefixIsShell = command.slice(0, openIndex).trim().length > 0;
				const mixed = prefixIsShell || open[1]!.length > 0 || parsed.rest.trim().length > 0;
				matches.push({
					cell: { language, code: parsed.word, start: wordStart, end: wordEnd },
					mixed,
					consumedEnd: wordEnd,
				});
				openRe.lastIndex = Math.max(openRe.lastIndex, wordEnd);
			}
		}
		open = openRe.exec(command);
	}
	return matches;
}

/**
 * A shell separator/redirection (or the closing `)`/`}` of a subshell or brace
 * group) after the code word makes the remainder shell syntax. Plain words are
 * deliberately rejected: `python -c 'x' extra` is a real interpreter
 * invocation, not a kernel cell.
 */
function isShellContinuation(input: string): boolean {
	if (/^[ \t]*\\?\r?\n/u.test(input)) return true;
	const trimmed = input.trimStart();
	if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed === "\\") return true;
	return /^(?:&&|\|\||[|;&)}]|\d*>{1,2}|\d*<{1,3}|&>>?|\d+>&\d+)/u.test(trimmed);
}

const ANSI_C_SIMPLE: Record<string, string> = {
	a: "\x07",
	b: "\b",
	e: "\x1b",
	E: "\x1b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
	"\\": "\\",
	"'": "'",
	'"': '"',
	"?": "?",
};

/** Bash `$'...'` ANSI-C quoting: escapes the shell strips before the argv reaches the interpreter. */
function ansiCUnescape(body: string): string {
	let out = "";
	for (let i = 0; i < body.length; i++) {
		const ch = body[i]!;
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		const next = body[i + 1];
		if (next === undefined) {
			out += ch;
			break;
		}
		i += 1;
		if (next === "x") {
			const hex = /^[\da-fA-F]{1,2}/u.exec(body.slice(i + 1, i + 3))?.[0];
			if (hex) {
				out += String.fromCharCode(Number.parseInt(hex, 16));
				i += hex.length;
				continue;
			}
			out += "x";
			continue;
		}
		if (next === "u" || next === "U") {
			const width = next === "u" ? 4 : 8;
			const hex = new RegExp(String.raw`^[\da-fA-F]{${width}}`, "u").exec(body.slice(i + 1, i + 1 + width))?.[0];
			if (hex) {
				out += String.fromCodePoint(Number.parseInt(hex, 16));
				i += width;
				continue;
			}
			out += next;
			continue;
		}
		if (/[0-7]/.test(next)) {
			const oct = /^[0-7]{1,3}/u.exec(body.slice(i, i + 3))?.[0] ?? next;
			out += String.fromCharCode(Number.parseInt(oct, 8));
			i += oct.length - 1;
			continue;
		}
		if (next === "c") {
			const ctrl = body[i + 1];
			if (ctrl !== undefined) {
				out += String.fromCharCode(ctrl.toUpperCase().charCodeAt(0) & 0x1f);
				i += 1;
				continue;
			}
			out += next;
			continue;
		}
		out += ANSI_C_SIMPLE[next] ?? next;
	}
	return out;
}

/**
 * Shell word extraction matching what word-splitting hands the interpreter:
 * quoted segments concatenate into one argv word, `$'...'` unescapes ANSI-C
 * sequences, and backslashes escape the next character. `$` and backticks
 * inside double quotes stay raw (the kernel receives them expanded).
 */
function parseFirstShellWord(input: string): { word: string; rest: string } | undefined {
	let word = "";
	let i = 0;
	while (i < input.length) {
		const ch = input[i]!;
		if (ch === "'") {
			const end = input.indexOf("'", i + 1);
			if (end < 0) return undefined;
			word += input.slice(i + 1, end);
			i = end + 1;
			continue;
		}
		if (ch === '"') {
			let j = i + 1;
			while (j < input.length) {
				const next = input[j]!;
				if (next === "\\" && j + 1 < input.length) {
					const escaped = input[j + 1]!;
					word += '"$`\\'.includes(escaped) ? escaped : `\\${escaped}`;
					j += 2;
					continue;
				}
				if (next === '"') break;
				word += next;
				j += 1;
			}
			if (j >= input.length) return undefined;
			i = j + 1;
			continue;
		}
		if (ch === "$" && input[i + 1] === "'") {
			let j = i + 2;
			let body = "";
			while (j < input.length) {
				const next = input[j]!;
				if (next === "\\" && j + 1 < input.length) {
					body += input.slice(j, j + 2);
					j += 2;
					continue;
				}
				if (next === "'") break;
				body += next;
				j += 1;
			}
			if (j >= input.length) return undefined;
			word += ansiCUnescape(body);
			i = j + 1;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= input.length) {
				word += "\\";
				i += 1;
				continue;
			}
			word += input[i + 1]!;
			i += 2;
			continue;
		}
		if (ch === "(") return undefined;
		if (ch === ")" || ch === "}" || /\s/.test(ch) || ";|&<>".includes(ch)) break;
		word += ch;
		i += 1;
	}
	return { word, rest: input.slice(i) };
}
