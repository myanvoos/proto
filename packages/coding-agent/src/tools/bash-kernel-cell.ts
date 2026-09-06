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

const PASSTHROUGH_BEFORE_STDIN: Record<"python" | "js", RegExp> = {
	python: /^(?:\s|-u|-)*$/,
	js: /^(?:\s|-)*$/,
};

const FLAGS_BEFORE_CODE: Record<"python" | "js", RegExp> = {
	python: /^(?:\s+-u)*$/,
	js: /^$/,
};

const CODE_FLAG: Record<"python" | "js", string> = { python: "-c", js: "-e" };

export function detectBashKernelCell(command: string): BashKernelCell | undefined {
	return detectHeredocCell(command) ?? detectFlagCell(command);
}

function detectHeredocCell(command: string): BashKernelCell | undefined {
	const open = command.match(
		/(?:^|[\n;&|]|&&|\|\|)\s*(python3?|node|bun)\b([^\n]*?)<<(-?)\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\4[^\n]*\n/,
	);
	if (!open) return undefined;
	const language = LANG_BY_CMD[open[1]];
	if (!language) return undefined;
	if (!PASSTHROUGH_BEFORE_STDIN[language].test(open[2])) return undefined;
	const delimiter = open[5];
	const bodyStart = open.index! + open[0].length;
	const rest = command.slice(bodyStart);
	const closeRe = new RegExp(`\\n${open[3] ? "\\t*" : ""}${delimiter}[ \\t]*(?:\\n|$)`);
	const close = rest.match(closeRe);
	const code = close ? rest.slice(0, close.index) : rest.replace(/\n?$/, "");
	if (code.trim().length === 0) return undefined;
	return { language, code };
}

function detectFlagCell(command: string): BashKernelCell | undefined {
	const m = command.match(/(?:^|[\n;&|]|&&|\|\|)\s*(python3?|node|bun)\b((?:\s+-[A-Za-z]+)*)\s+(-c|-e)\s+(.*)$/s);
	if (!m) return undefined;
	const language = LANG_BY_CMD[m[1]];
	if (!language) return undefined;
	if (m[3] !== CODE_FLAG[language] || !FLAGS_BEFORE_CODE[language].test(m[2])) return undefined;
	const parsed = parseFirstShellWord(m[4].trimStart());
	if (!parsed || parsed.word.trim().length === 0) return undefined;
	if (parsed.rest.trim().length > 0) return undefined;
	return { language, code: parsed.word };
}

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
