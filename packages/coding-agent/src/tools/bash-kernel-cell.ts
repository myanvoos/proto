export interface BashKernelCell {
	language: "python" | "js";
	code: string;
}

const LANG_BY_CMD: Record<string, "python" | "js"> = {
	python: "python",
	python3: "python",
	node: "js",
	bun: "js",
};

const PASSTHROUGH_BEFORE_STDIN = /^(?:\s|-u|-)*$/;

/**
 * Best-effort detection of a kernel-routed `python`/`node`/`bun` invocation in a bash
 * command, mirroring the routing in crates/pi-builtins kernel_cell.rs: code on
 * stdin (heredoc) or a bare `-c`/`-e CODE` runs in the persistent kernel, while
 * `python file.py`, `-m`, or extra argv run a real interpreter. Display-only —
 * returns the embedded cell so the renderer can render it like an eval
 * cell; returns undefined when the command would spawn a real interpreter or
 * can't be parsed confidently.
 */
export function detectBashKernelCell(command: string): BashKernelCell | undefined {
	return detectHeredocCell(command) ?? detectFlagCell(command);
}

function detectHeredocCell(command: string): BashKernelCell | undefined {
	// `<lang> [flags] <<[-]['"]?DELIM['"]? \n <body> \n DELIM`
	const open = command.match(
		/(?:^|[\n;&|]|&&|\|\|)\s*(python3?|node|bun)\b([^\n]*?)<<(-?)\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\4[^\n]*\n/,
	);
	if (!open) return undefined;
	const language = LANG_BY_CMD[open[1]];
	if (!language) return undefined;
	if (!PASSTHROUGH_BEFORE_STDIN.test(open[2])) return undefined;
	const delimiter = open[5];
	const bodyStart = open.index! + open[0].length;
	const rest = command.slice(bodyStart);
	// The heredoc terminator is the delimiter alone on a line (leading tabs
	// allowed only with `<<-`); take everything up to it as the cell body.
	const closeRe = new RegExp(`\\n${open[3] ? "\\t*" : ""}${delimiter}[ \\t]*(?:\\n|$)`);
	const close = rest.match(closeRe);
	const code = close ? rest.slice(0, close.index) : rest.replace(/\n?$/, "");
	if (code.trim().length === 0) return undefined;
	return { language, code };
}

function detectFlagCell(command: string): BashKernelCell | undefined {
	// `<lang> [flags] (-c|-e) CODE` with nothing meaningful after the code.
	const m = command.match(/(?:^|[\n;&|]|&&|\|\|)\s*(python3?|node|bun)\b((?:\s+-[A-Za-z]+)*)\s+(-c|-e)\s+(.*)$/s);
	if (!m) return undefined;
	const language = LANG_BY_CMD[m[1]];
	if (!language) return undefined;
	const flag = m[3];
	if (language === "python" && flag !== "-c") return undefined;
	if (language === "js" && flag !== "-e") return undefined;
	const parsed = parseFirstShellWord(m[4].trimStart());
	if (!parsed || parsed.word.trim().length === 0) return undefined;
	// Extra argv after the code means the real interpreter runs (argv semantics);
	// only treat it as a cell when the code is the final token.
	if (parsed.rest.trim().length > 0) return undefined;
	return { language, code: parsed.word };
}

/** Parse the first shell word (single/double-quoted or bare) and the remainder. */
function parseFirstShellWord(input: string): { word: string; rest: string } | undefined {
	const quote = input[0];
	if (quote === "'") {
		const end = input.indexOf("'", 1);
		if (end < 0) return undefined;
		return { word: input.slice(1, end), rest: input.slice(end + 1) };
	}
	if (quote === '"') {
		let word = "";
		let i = 1;
		while (i < input.length) {
			const ch = input[i];
			if (ch === "\\" && i + 1 < input.length) {
				const next = input[i + 1];
				word += '"$`\\'.includes(next) ? next : `\\${next}`;
				i += 2;
				continue;
			}
			if (ch === '"') return { word, rest: input.slice(i + 1) };
			word += ch;
			i += 1;
		}
		return undefined;
	}
	const match = input.match(/^\S+/);
	if (!match) return undefined;
	return { word: match[0], rest: input.slice(match[0].length) };
}
