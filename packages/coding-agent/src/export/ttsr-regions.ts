/**
 * Lexical region classification for TTSR match conditions.
 *
 * A raw regex over a stream buffer cannot tell a real `as any` cast from the
 * same three words inside a comment, a string literal, or prose explaining the
 * rule. Conditions can therefore constrain a match to a lexical region kind;
 * this module is what decides which region an offset falls in.
 *
 * Scanning is deliberately lexical, not a parse: it runs on every streamed
 * snapshot, on partially written source, and on languages whose grammar we do
 * not ship. Unknown languages classify as `undefined` (constraint unsatisfiable)
 * rather than guessing.
 */

/**
 * `code`/`comment`/`string` classify source buffers; `prose` and `code` classify
 * markdown-ish streams, where only fenced blocks count as code — an inline
 * `span` is the model talking about a pattern, not writing it.
 */
export type RegionKind = "code" | "comment" | "string" | "prose";

export interface SyntaxRegion {
	start: number;
	end: number;
	kind: RegionKind;
}

export type RegionMode = { kind: "code"; lang: string } | { kind: "prose" };

interface StringSyntax {
	open: string;
	close: string;
	escape: boolean;
}

interface BlockComment {
	open: string;
	close: string;
	nested: boolean;
}

interface LangProfile {
	lineComments: readonly string[];
	blockComments: readonly BlockComment[];
	strings: readonly StringSyntax[];
	/** `'` opens a char literal only when the text looks like one (Rust lifetimes, Go runes). */
	charLiteral: boolean;
	/** Rust-style `r"…"` / `r#"…"#` / `br#"…"#` raw strings. */
	rustRawStrings: boolean;
	/** Python `r`/`b`/`f`/`u` string prefixes plus triple quotes. */
	pythonStrings: boolean;
	/** C# `@"…"` verbatim strings. */
	verbatimStrings: boolean;
	/** JS/TS regex literals, whose contents must not be read as quotes. */
	regexLiterals: boolean;
	/** `#` starts a comment only at a word boundary (shell). */
	wordStartLineComment: boolean;
}

const QUOTES: readonly StringSyntax[] = [
	{ open: '"', close: '"', escape: true },
	{ open: "'", close: "'", escape: true },
];

function profile(overrides: Partial<LangProfile>): LangProfile {
	return {
		lineComments: [],
		blockComments: [],
		strings: QUOTES,
		charLiteral: false,
		rustRawStrings: false,
		pythonStrings: false,
		verbatimStrings: false,
		regexLiterals: false,
		wordStartLineComment: false,
		...overrides,
	};
}

const SLASH_BLOCK: readonly BlockComment[] = [{ open: "/*", close: "*/", nested: false }];

const PROFILES = {
	js: profile({
		lineComments: ["//"],
		blockComments: SLASH_BLOCK,
		strings: [...QUOTES, { open: "`", close: "`", escape: true }],
		regexLiterals: true,
	}),
	rust: profile({
		lineComments: ["//"],
		blockComments: [{ open: "/*", close: "*/", nested: true }],
		strings: [{ open: '"', close: '"', escape: true }],
		charLiteral: true,
		rustRawStrings: true,
	}),
	go: profile({
		lineComments: ["//"],
		blockComments: SLASH_BLOCK,
		strings: [
			{ open: '"', close: '"', escape: true },
			{ open: "`", close: "`", escape: false },
		],
		charLiteral: true,
	}),
	clike: profile({ lineComments: ["//"], blockComments: SLASH_BLOCK, charLiteral: true }),
	csharp: profile({ lineComments: ["//"], blockComments: SLASH_BLOCK, charLiteral: true, verbatimStrings: true }),
	python: profile({ lineComments: ["#"], pythonStrings: true }),
	shell: profile({ lineComments: ["#"], wordStartLineComment: true }),
	ruby: profile({ lineComments: ["#"], blockComments: [{ open: "\n=begin", close: "\n=end", nested: false }] }),
	lua: profile({
		lineComments: ["--"],
		blockComments: [{ open: "--[[", close: "]]", nested: false }],
		strings: [...QUOTES, { open: "[[", close: "]]", escape: false }],
	}),
	sql: profile({ lineComments: ["--"], blockComments: SLASH_BLOCK }),
	hash: profile({ lineComments: ["#"] }),
	css: profile({ blockComments: SLASH_BLOCK }),
	json: profile({ strings: [{ open: '"', close: '"', escape: true }] }),
	jsonc: profile({
		lineComments: ["//"],
		blockComments: SLASH_BLOCK,
		strings: [{ open: '"', close: '"', escape: true }],
	}),
	xml: profile({ blockComments: [{ open: "<!--", close: "-->", nested: false }] }),
} satisfies Record<string, LangProfile>;

const LANG_PROFILES: Readonly<Record<string, LangProfile>> = {
	ts: PROFILES.js,
	tsx: PROFILES.js,
	mts: PROFILES.js,
	cts: PROFILES.js,
	typescript: PROFILES.js,
	js: PROFILES.js,
	jsx: PROFILES.js,
	mjs: PROFILES.js,
	cjs: PROFILES.js,
	javascript: PROFILES.js,
	rs: PROFILES.rust,
	rust: PROFILES.rust,
	go: PROFILES.go,
	golang: PROFILES.go,
	c: PROFILES.clike,
	h: PROFILES.clike,
	cc: PROFILES.clike,
	cpp: PROFILES.clike,
	cxx: PROFILES.clike,
	hpp: PROFILES.clike,
	java: PROFILES.clike,
	kt: PROFILES.clike,
	kts: PROFILES.clike,
	swift: PROFILES.clike,
	scala: PROFILES.clike,
	dart: PROFILES.clike,
	zig: PROFILES.clike,
	php: PROFILES.clike,
	proto: PROFILES.clike,
	hcl: PROFILES.clike,
	tf: PROFILES.clike,
	cs: PROFILES.csharp,
	csharp: PROFILES.csharp,
	py: PROFILES.python,
	pyi: PROFILES.python,
	python: PROFILES.python,
	sh: PROFILES.shell,
	bash: PROFILES.shell,
	zsh: PROFILES.shell,
	fish: PROFILES.shell,
	rb: PROFILES.ruby,
	ruby: PROFILES.ruby,
	lua: PROFILES.lua,
	sql: PROFILES.sql,
	yaml: PROFILES.hash,
	yml: PROFILES.hash,
	toml: PROFILES.hash,
	ini: PROFILES.hash,
	css: PROFILES.css,
	scss: PROFILES.css,
	less: PROFILES.css,
	json: PROFILES.json,
	jsonc: PROFILES.jsonc,
	json5: PROFILES.jsonc,
	html: PROFILES.xml,
	htm: PROFILES.xml,
	xml: PROFILES.xml,
	svg: PROFILES.xml,
	vue: PROFILES.xml,
};

const PROSE_LANGS: Readonly<Record<string, true>> = {
	md: true,
	mdx: true,
	mdc: true,
	markdown: true,
	txt: true,
	text: true,
	rst: true,
};

const IDENT = /[A-Za-z0-9_$]/;
const STRING_PREFIX = /^[a-zA-Z]{0,2}$/;

/** `true` when `lang` has a lexical profile (or is prose); `in:` constraints need one. */
export function canClassify(lang: string | undefined): boolean {
	if (!lang) return false;
	const key = lang.toLowerCase();
	return PROSE_LANGS[key] === true || LANG_PROFILES[key] !== undefined;
}

export function regionModeFor(source: "text" | "thinking" | "tool", lang: string | undefined): RegionMode | undefined {
	if (source !== "tool") return { kind: "prose" };
	if (!lang) return undefined;
	const key = lang.toLowerCase();
	if (PROSE_LANGS[key] === true) return { kind: "prose" };
	return LANG_PROFILES[key] ? { kind: "code", lang: key } : undefined;
}

/**
 * Comment/string (or prose/code) regions covering `text`, or `undefined` when
 * the language has no profile. Returned regions are sorted, non-overlapping,
 * and only cover non-default spans — everything else is `code` (or `prose`).
 */
interface CacheEntry {
	text: string;
	key: string;
	regions: SyntaxRegion[] | undefined;
}

// One streamed snapshot is classified twice (the regex pass and the AST pass each
// build their own context), and a rule set re-enters per rule. Two slots cover
// that without holding buffers alive.
const CACHE_SLOTS = 2;
const cache: CacheEntry[] = [];

export function classifyRegions(text: string, mode: RegionMode): SyntaxRegion[] | undefined {
	const key = mode.kind === "prose" ? "prose" : `code:${mode.lang.toLowerCase()}`;
	for (const entry of cache) {
		if (entry.key === key && entry.text === text) return entry.regions;
	}
	const regions = mode.kind === "prose" ? markdownRegions(text) : classifyCode(text, mode.lang);
	cache.unshift({ text, key, regions });
	if (cache.length > CACHE_SLOTS) cache.length = CACHE_SLOTS;
	return regions;
}

function classifyCode(text: string, lang: string): SyntaxRegion[] | undefined {
	const profile = LANG_PROFILES[lang.toLowerCase()];
	return profile ? codeRegions(text, profile) : undefined;
}

/** Kind of the region fully containing `[start, end)`, or `undefined` when the span straddles kinds. */
export function spanRegionKind(
	regions: readonly SyntaxRegion[],
	start: number,
	end: number,
	fallback: RegionKind,
): RegionKind | undefined {
	let kind: RegionKind | undefined;
	let cursor = start;
	while (cursor < end) {
		const region = regionAt(regions, cursor);
		const currentKind = region?.kind ?? fallback;
		if (kind !== undefined && kind !== currentKind) return undefined;
		kind = currentKind;
		cursor = region ? Math.min(region.end, end) : nextRegionStart(regions, cursor, end);
	}
	return kind ?? fallback;
}

function regionAt(regions: readonly SyntaxRegion[], offset: number): SyntaxRegion | undefined {
	let low = 0;
	let high = regions.length - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const region = regions[mid]!;
		if (offset < region.start) high = mid - 1;
		else if (offset >= region.end) low = mid + 1;
		else return region;
	}
	return undefined;
}

function nextRegionStart(regions: readonly SyntaxRegion[], offset: number, limit: number): number {
	for (const region of regions) {
		if (region.start > offset) return Math.min(region.start, limit);
	}
	return limit;
}

function markdownRegions(text: string): SyntaxRegion[] {
	const regions: SyntaxRegion[] = [];
	let index = 0;
	let fenceStart: number | undefined;
	let fence = "";
	while (index < text.length) {
		const lineEnd = text.indexOf("\n", index);
		const end = lineEnd === -1 ? text.length : lineEnd + 1;
		const line = text.slice(index, end);
		const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
		if (fenceStart === undefined) {
			if (fenceMatch) {
				fence = fenceMatch[1]!;
				fenceStart = index;
			}
		} else if (fenceMatch && fenceMatch[1]!.startsWith(fence[0]!) && fenceMatch[1]!.length >= fence.length) {
			regions.push({ start: fenceStart, end, kind: "code" });
			fenceStart = undefined;
		}
		index = end;
	}
	if (fenceStart !== undefined) regions.push({ start: fenceStart, end: text.length, kind: "code" });
	return regions.sort((a, b) => a.start - b.start);
}

function codeRegions(text: string, lang: LangProfile): SyntaxRegion[] {
	const regions: SyntaxRegion[] = [];
	let index = 0;
	let lastCode = -1;
	while (index < text.length) {
		const blockEnd = scanBlockComment(text, index, lang);
		if (blockEnd !== undefined) {
			regions.push({ start: index, end: blockEnd, kind: "comment" });
			index = blockEnd;
			continue;
		}
		const lineEnd = scanLineComment(text, index, lang);
		if (lineEnd !== undefined) {
			regions.push({ start: index, end: lineEnd, kind: "comment" });
			index = lineEnd;
			continue;
		}
		const stringEnd = scanString(text, index, lang, lastCode);
		if (stringEnd !== undefined) {
			regions.push({ start: index, end: stringEnd, kind: "string" });
			index = stringEnd;
			continue;
		}
		if (!/\s/.test(text[index]!)) lastCode = index;
		index++;
	}
	return regions;
}

function scanBlockComment(text: string, index: number, lang: LangProfile): number | undefined {
	for (const block of lang.blockComments) {
		if (!text.startsWith(block.open, index)) continue;
		let depth = 1;
		let cursor = index + block.open.length;
		while (cursor < text.length && depth > 0) {
			if (block.nested && text.startsWith(block.open, cursor)) {
				depth++;
				cursor += block.open.length;
				continue;
			}
			if (text.startsWith(block.close, cursor)) {
				depth--;
				cursor += block.close.length;
				continue;
			}
			cursor++;
		}
		return depth > 0 ? text.length : cursor;
	}
	return undefined;
}

function scanLineComment(text: string, index: number, lang: LangProfile): number | undefined {
	for (const marker of lang.lineComments) {
		if (!text.startsWith(marker, index)) continue;
		// `a#b` is one shell word, not a comment; `echo a # b` is.
		if (lang.wordStartLineComment && index > 0 && IDENT.test(text[index - 1] ?? "")) continue;
		const newline = text.indexOf("\n", index);
		return newline === -1 ? text.length : newline;
	}
	return undefined;
}

function scanString(text: string, index: number, lang: LangProfile, lastCode: number): number | undefined {
	const char = text[index]!;
	if (lang.pythonStrings) {
		const pythonEnd = scanPythonString(text, index);
		if (pythonEnd !== undefined) return pythonEnd;
	}
	if (lang.rustRawStrings) {
		const rawEnd = scanRustRawString(text, index);
		if (rawEnd !== undefined) return rawEnd;
	}
	if (lang.verbatimStrings && char === "@" && text[index + 1] === '"') {
		let cursor = index + 2;
		while (cursor < text.length) {
			if (text[cursor] === '"') {
				if (text[cursor + 1] === '"') cursor += 2;
				else return cursor + 1;
				continue;
			}
			cursor++;
		}
		return text.length;
	}
	if (lang.regexLiterals && char === "/" && !text.startsWith("//", index) && !text.startsWith("/*", index)) {
		return isRegexLiteralStart(text, lastCode) ? scanRegexLiteral(text, index) : undefined;
	}
	for (const syntax of lang.strings) {
		if (!text.startsWith(syntax.open, index)) continue;
		if (syntax.open === "'" && lang.charLiteral && !isCharLiteral(text, index)) continue;
		return scanQuoted(text, index, syntax);
	}
	return undefined;
}

function scanQuoted(text: string, index: number, syntax: StringSyntax): number {
	let cursor = index + syntax.open.length;
	while (cursor < text.length) {
		if (syntax.escape && text[cursor] === "\\") {
			cursor += 2;
			continue;
		}
		if (text.startsWith(syntax.close, cursor)) return cursor + syntax.close.length;
		cursor++;
	}
	return text.length;
}

function scanPythonString(text: string, index: number): number | undefined {
	let start = index;
	while (start > 0 && IDENT.test(text[start - 1] ?? "")) start--;
	const prefix = text.slice(start, index);
	if (prefix.length > 0) {
		if (!STRING_PREFIX.test(prefix) || !/^[rRbBuUfF]+$/.test(prefix)) return undefined;
		if (start > 0 && IDENT.test(text[start - 1] ?? "")) return undefined;
	}
	const raw = /[rR]/.test(prefix);
	for (const quote of ['"""', "'''", '"', "'"]) {
		if (!text.startsWith(quote, index)) continue;
		return scanQuoted(text, index, { open: quote, close: quote, escape: !raw });
	}
	return undefined;
}

function scanRustRawString(text: string, index: number): number | undefined {
	const match = /^(?:b|c)?r(#*)"/.exec(text.slice(index, index + 16));
	if (!match) return undefined;
	const close = `"${match[1]}`;
	const closeIndex = text.indexOf(close, index + match[0].length);
	return closeIndex === -1 ? text.length : closeIndex + close.length;
}

function isCharLiteral(text: string, index: number): boolean {
	return /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^'\\])'/.test(text.slice(index, index + 12));
}

/** Keywords after which `/` opens a regex literal rather than dividing. */
const REGEX_AFTER_KEYWORD: Readonly<Record<string, true>> = {
	await: true,
	case: true,
	delete: true,
	do: true,
	else: true,
	in: true,
	instanceof: true,
	new: true,
	of: true,
	return: true,
	throw: true,
	typeof: true,
	void: true,
	yield: true,
};

function isRegexLiteralStart(text: string, lastCode: number): boolean {
	if (lastCode < 0) return true;
	const previous = text[lastCode]!;
	if (IDENT.test(previous)) {
		let start = lastCode;
		while (start > 0 && IDENT.test(text[start - 1] ?? "")) start--;
		return REGEX_AFTER_KEYWORD[text.slice(start, lastCode + 1)] === true;
	}
	return previous !== ")" && previous !== "]";
}

function scanRegexLiteral(text: string, index: number): number | undefined {
	let cursor = index + 1;
	let inClass = false;
	while (cursor < text.length) {
		const char = text[cursor]!;
		if (char === "\\") {
			cursor += 2;
			continue;
		}
		if (char === "\n") return undefined;
		if (char === "[") inClass = true;
		else if (char === "]") inClass = false;
		else if (char === "/" && !inClass) return cursor + 1;
		cursor++;
	}
	return undefined;
}
