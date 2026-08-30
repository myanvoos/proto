import type { Theme } from "../../modes/theme/theme";
import { truncateToWidth } from "../render-utils";

export interface PyAstNode {
	kind: string;
	name?: string;
	detail?: string;
	doc?: string;
	notes?: string[];
	questions?: string[];
	rawString?: string;
	line: number;
	children: PyAstNode[];
}

const NOTE_PREFIX = "#@";
const NOTE_QUESTION_PREFIX = "#@?";

function isNoteLine(text: string): { question: boolean; text: string } | null {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith(NOTE_PREFIX)) return null;
	const question = trimmed.startsWith(NOTE_QUESTION_PREFIX);
	const body = trimmed.slice(question ? NOTE_QUESTION_PREFIX.length : NOTE_PREFIX.length);
	return { question, text: body.trim() };
}

interface Token {
	type: "name" | "number" | "string" | "op";
	value: string;
}

interface LogicalLine {
	indent: number;
	text: string;
	line: number;
}

const OPS3 = ["**=", "//=", ">>=", "<<=", "..."];
const OPS2 = [
	"**",
	"//",
	"==",
	"!=",
	"<=",
	">=",
	":=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"@=",
	"->",
	"<<",
	">>",
];
const QUOTES = "\"'";
const PREFIX_CHARS = "rRbBuUfF";
const COMPOUND_KINDS = new Set([
	"def",
	"class",
	"if",
	"elif",
	"else",
	"for",
	"while",
	"try",
	"except",
	"finally",
	"with",
	"match",
	"case",
	"async def",
	"async for",
	"async with",
]);
const KEYWORD_SIMPLE = new Set([
	"return",
	"raise",
	"assert",
	"del",
	"global",
	"nonlocal",
	"pass",
	"break",
	"continue",
	"import",
	"from",
]);
const AUG_OPS = new Set(["+=", "-=", "*=", "/=", "%=", "**=", "//=", "&=", "|=", "^=", "@=", ">>=", "<<="]);

const isNameStart = (ch: string) => /[A-Za-z_]/.test(ch);
const isNameChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);

function countIndent(line: string): number {
	let col = 0;
	for (const ch of line) {
		if (ch === " ") col += 1;
		else if (ch === "\t") col += 4 - (col % 4);
		else break;
	}
	return col;
}

function scanString(text: string, i: number): { token: Token; end: number } | null {
	let start = i;
	while (start < text.length && PREFIX_CHARS.includes(text[start])) start++;
	if (start >= text.length) return null;
	if (start > i && (start - i > 2 || !QUOTES.includes(text[start]))) return null;
	if (start === i && !QUOTES.includes(text[start])) return null;
	const quote = text[start];
	const triple = text.startsWith(quote.repeat(3), start);
	const endQuote = triple ? quote.repeat(3) : quote;
	let j = start + (triple ? 3 : 1);
	while (j < text.length) {
		if (text[j] === "\\") {
			j += 2;
			continue;
		}
		if (text.startsWith(endQuote, j)) {
			return { token: { type: "string", value: text.slice(i, j + endQuote.length) }, end: j + endQuote.length };
		}
		j++;
	}
	return { token: { type: "string", value: text.slice(i) }, end: text.length };
}

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === " " || ch === "\t") {
			i++;
			continue;
		}
		const str = scanString(text, i);
		if (str) {
			tokens.push(str.token);
			i = str.end;
			continue;
		}
		if (isNameStart(ch)) {
			let j = i + 1;
			while (j < text.length && isNameChar(text[j])) j++;
			tokens.push({ type: "name", value: text.slice(i, j) });
			i = j;
			continue;
		}
		if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
			let j = i + 1;
			while (j < text.length && /[0-9a-fA-FxXoO_.]/.test(text[j])) j++;
			if ((text[j] === "e" || text[j] === "E") && /[0-9+-]/.test(text[j + 1] ?? "")) {
				j += 2;
				while (j < text.length && /[0-9]/.test(text[j])) j++;
			}
			tokens.push({ type: "number", value: text.slice(i, j) });
			i = j;
			continue;
		}
		const three = text.slice(i, i + 3);
		if (OPS3.includes(three)) {
			tokens.push({ type: "op", value: three });
			i += 3;
			continue;
		}
		const two = text.slice(i, i + 2);
		if (OPS2.includes(two)) {
			tokens.push({ type: "op", value: two });
			i += 2;
			continue;
		}
		tokens.push({ type: "op", value: ch });
		i++;
	}
	return tokens;
}

function depthDelta(token: Token): number {
	if (token.type !== "op") return 0;
	if ("([{".includes(token.value)) return 1;
	if (")]}".includes(token.value)) return -1;
	return 0;
}

function isOp(token: Token | undefined, value: string): boolean {
	return token?.type === "op" && token.value === value;
}

function isName(token: Token | undefined, value?: string): boolean {
	if (token?.type !== "name") return false;
	return value === undefined || token.value === value;
}

function scanTripleInToken(raw: string): string | null {
	const prefixMatch = raw.match(/^[rRbBuUfF]*/);
	const body = raw.slice(prefixMatch ? prefixMatch[0].length : 0);
	for (const q of ['"""', "'''"]) {
		if (body.startsWith(q) && body.indexOf(q, q.length) === -1) return q;
	}
	return null;
}

function assembleLogicalLines(source: string): LogicalLine[] {
	const physical = source.split(/\r?\n/);
	const out: LogicalLine[] = [];
	let text = "";
	let indent = 0;
	let line = 0;
	let open = false;
	let triple: string | null = null;

	const flush = () => {
		const trimmed = text.trim();
		if (trimmed.length > 0) out.push({ indent, text: trimmed, line: line || 1 });
		text = "";
		open = false;
	};

	for (let idx = 0; idx < physical.length; idx++) {
		let rest = physical[idx];
		const lineNo = idx + 1;

		if (triple) {
			const end = rest.indexOf(triple);
			if (end === -1) {
				text += `\n${rest}`;
				continue;
			}
			text += `\n${rest.slice(0, end + triple.length)}`;
			rest = rest.slice(end + triple.length);
			triple = null;
			if (rest.trim().length === 0) {
				if (open) flush();
				continue;
			}
		}

		if (!open) {
			indent = countIndent(rest);
			line = lineNo;
			rest = rest.slice(countIndentLead(rest));
			if (rest.startsWith(NOTE_PREFIX)) {
				out.push({ indent, text: rest.trim(), line: lineNo });
				continue;
			}
		} else {
			rest = rest.trim();
			if (rest.length === 0) continue;
			text += " ";
		}

		let i = 0;
		let scan = "";
		while (i < rest.length) {
			const str = scanString(rest, i);
			if (str) {
				scan += str.token.value;
				i = str.end;
				const tripleOpen = scanTripleInToken(str.token.value);
				if (tripleOpen) {
					triple = tripleOpen;
					break;
				}
				continue;
			}
			const ch = rest[i];
			if (ch === "#") break;
			scan += ch;
			i++;
		}
		text += scan;

		if (triple) {
			open = true;
			continue;
		}
		const body = stripCommentTail(rest);
		const continued = bracketDepth(text) > 0 || /\\\s*$/.test(body);
		if (continued) {
			open = true;
			continue;
		}
		flush();
	}
	if (open || text.length > 0) flush();
	return out;
}

function countIndentLead(line: string): number {
	let i = 0;
	while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
	return i;
}

function stripCommentTail(text: string): string {
	let i = 0;
	while (i < text.length) {
		const str = scanString(text, i);
		if (str) {
			i = str.end;
			continue;
		}
		if (text[i] === "#") return text.slice(0, i);
		i++;
	}
	return text;
}

function bracketDepth(text: string): number {
	let depth = 0;
	for (const token of tokenize(stripCommentTail(text))) depth += depthDelta(token);
	return depth;
}

interface HeaderMatch {
	kind: string;
	rest: Token[];
	colonIndex: number;
}

function matchHeader(tokens: Token[]): HeaderMatch | null {
	if (tokens.length === 0) return null;
	let kind: string | null = null;
	let start = 0;
	if (isName(tokens[0], "async") && isName(tokens[1]) && ["def", "for", "with"].includes(tokens[1].value)) {
		kind = `async ${tokens[1].value}`;
		start = 2;
	} else if (tokens[0].type === "name" && COMPOUND_KINDS.has(tokens[0].value)) {
		kind = tokens[0].value;
		start = 1;
	}
	if (!kind) return null;
	let depth = 0;
	let colonIndex = -1;
	for (let i = start; i < tokens.length; i++) {
		depth += depthDelta(tokens[i]);
		if (depth === 0 && isOp(tokens[i], ":")) {
			colonIndex = i;
			break;
		}
	}
	if (colonIndex === -1) return null;
	if ((kind === "match" || kind === "case") && isOp(tokens[start], "(")) {
		let d = 0;
		let close = -1;
		for (let i = start; i < tokens.length; i++) {
			d += depthDelta(tokens[i]);
			if (d === 0) {
				close = i;
				break;
			}
		}
		if (close !== -1 && close + 1 === colonIndex) return null;
	}
	return { kind, rest: tokens.slice(start, colonIndex), colonIndex };
}

function isClause(kind: string): boolean {
	return kind === "elif" || kind === "else" || kind === "except" || kind === "finally" || kind === "case";
}

function clauseReceptive(parentKind: string, clauseKind: string): boolean {
	if (clauseKind === "elif") return parentKind === "if";
	if (clauseKind === "else") return parentKind === "if" || parentKind === "for" || parentKind === "while";
	if (clauseKind === "except" || clauseKind === "finally") return parentKind === "try";
	if (clauseKind === "case") return parentKind === "match";
	return false;
}

function node(kind: string, line: number, name?: string, detail?: string): PyAstNode {
	return { kind, name, detail, line, children: [] };
}

function joinTokens(tokens: Token[]): string {
	let out = "";
	for (const t of tokens) {
		const v = t.value;
		if (out.length === 0) {
			out = v;
			continue;
		}
		const prev = out[out.length - 1];
		const noSpaceBefore =
			")]},:".includes(v) || v === "." || prev === "*" || ((v === "(" || v === "[") && /[A-Za-z0-9_)\]]/.test(prev));
		const noSpaceAfter = "([.*".includes(prev);
		if (noSpaceBefore || noSpaceAfter) out += v;
		else out += ` ${v}`;
	}
	return out;
}

function renderTokens(tokens: Token[]): string {
	return joinTokens(tokens);
}

function summarize(tokens: Token[], limit = 96): string {
	if (tokens.length === 0) return "";
	try {
		return cap(parseExpr(tokens, { i: 0 }), limit);
	} catch {
		return cap(joinTokens(tokens), limit);
	}
}

function cap(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= limit) return flat;
	return `${flat.slice(0, limit - 1).trimEnd()}…`;
}

function parseExpr(tokens: Token[], pos: { i: number }): string {
	if (isName(peek(tokens, pos), "lambda")) return parseLambda(tokens, pos);
	let value = parseOr(tokens, pos);
	if (isOp(peek(tokens, pos), ",")) {
		const parts = [value];
		while (isOp(peek(tokens, pos), ",")) {
			pos.i++;
			parts.push(parseOr(tokens, pos));
		}
		value = parts.join(", ");
	}
	if (isName(peek(tokens, pos), "if")) {
		pos.i++;
		const cond = parseOr(tokens, pos);
		let out = `${value} if ${cond}`;
		if (isName(peek(tokens, pos), "else")) {
			pos.i++;
			out += ` else ${parseExpr(tokens, pos)}`;
		}
		return out;
	}
	return value;
}

function peek(tokens: Token[], pos: { i: number }): Token | undefined {
	return tokens[pos.i];
}

function parseLambda(tokens: Token[], pos: { i: number }): string {
	pos.i++;
	const params: string[] = [];
	while (pos.i < tokens.length && !isOp(peek(tokens, pos), ":")) {
		params.push(tokens[pos.i].value);
		pos.i++;
	}
	if (isOp(peek(tokens, pos), ":")) pos.i++;
	const body = parseExpr(tokens, pos);
	return `λ(${params.join(" ")}) → ${body}`;
}

function parseOr(tokens: Token[], pos: { i: number }): string {
	let left = parseUnaryChain(tokens, pos);
	for (;;) {
		const t = peek(tokens, pos);
		if (!t) break;
		if (t.type === "name" && (t.value === "and" || t.value === "or" || t.value === "in" || t.value === "is")) {
			let op = t.value;
			pos.i++;
			if (op === "is" && isName(peek(tokens, pos), "not")) {
				op = "is not";
				pos.i++;
			} else if (op === "not" && isName(peek(tokens, pos), "in")) {
				op = "not in";
				pos.i++;
			}
			left = `${left} ${op} ${parseUnaryChain(tokens, pos)}`;
			continue;
		}
		if (t.type === "op" && !")]},".includes(t.value) && t.value !== ":" && t.value !== "=") {
			pos.i++;
			left = `${left} ${t.value} ${parseUnaryChain(tokens, pos)}`;
			continue;
		}
		break;
	}
	return left;
}

function parseUnaryChain(tokens: Token[], pos: { i: number }): string {
	const prefixes: string[] = [];
	for (;;) {
		const t = peek(tokens, pos);
		if (
			t &&
			((t.type === "op" && ["-", "+", "~"].includes(t.value)) ||
				(t.type === "name" && (t.value === "not" || t.value === "await")))
		) {
			prefixes.push(t.value === "await" ? "await " : t.value);
			pos.i++;
			continue;
		}
		break;
	}
	const value = parsePostfix(tokens, pos);
	if (prefixes.length === 0) return value;
	const glue = prefixes[prefixes.length - 1].endsWith(" ") ? "" : " ";
	return `${prefixes.join(" ")}${glue}${value}`;
}

function parsePostfix(tokens: Token[], pos: { i: number }): string {
	const t = peek(tokens, pos);
	if (!t) return "";
	if (t.type === "name") {
		if (t.value === "True" || t.value === "False" || t.value === "None") {
			pos.i++;
			return t.value;
		}
		pos.i++;
		return nameTrailers(tokens, pos, t.value);
	}
	if (t.type === "string") {
		pos.i++;
		return literalString(t.value);
	}
	if (t.type === "number") {
		pos.i++;
		return t.value;
	}
	if (t.type === "op") {
		if (t.value === "(") return bracketAtom(tokens, pos, "(", ")");
		if (t.value === "[") return bracketAtom(tokens, pos, "[", "]");
		if (t.value === "{") return bracketAtom(tokens, pos, "{", "}");
	}
	pos.i++;
	return t.value;
}

function literalString(value: string): string {
	const prefixMatch = value.match(/^[rRbBuUfF]*/);
	const prefix = prefixMatch ? prefixMatch[0] : "";
	const body = value.slice(prefix.length);
	const quote = body.startsWith('"""') || body.startsWith("'''") ? body.slice(0, 3) : body.slice(0, 1);
	let inner = body.slice(quote.length);
	if (inner.endsWith(quote) && inner.length >= quote.length) {
		inner = inner.slice(0, inner.length - quote.length);
	}
	const newlineIndex = inner.indexOf("\n");
	if (newlineIndex >= 0) {
		const lineCount = inner.split("\n").length;
		const first = inner.slice(0, newlineIndex);
		const head = first.length > 44 ? `${first.slice(0, 43)}…` : first;
		return `${prefix}${quote}${head}…+${lineCount - 1} lines${quote}`;
	}
	if (inner.length > 72) {
		inner = `${inner.slice(0, 71)}…`;
	}
	return `${prefix}${quote}${inner}${quote}`;
}

function nameTrailers(tokens: Token[], pos: { i: number }, base: string): string {
	let out = base;
	for (;;) {
		const t = peek(tokens, pos);
		if (!t) break;
		if (t.type === "op" && t.value === ".") {
			const next = tokens[pos.i + 1];
			if (next?.type === "name") {
				out += `.${next.value}`;
				pos.i += 2;
				continue;
			}
			break;
		}
		if (t.type === "op" && t.value === "(") {
			out = `${out}(${callArgs(tokens, pos)})`;
			continue;
		}
		if (t.type === "op" && t.value === "[") {
			const inner = bracketTokens(tokens, pos, "]");
			out = `${out}[${summarizeSubscript(inner)}]`;
			continue;
		}
		break;
	}
	return out;
}

function bracketTokens(tokens: Token[], pos: { i: number }, close: string): Token[] {
	const inner: Token[] = [];
	let depth = 0;
	pos.i++;
	while (pos.i < tokens.length) {
		const t = tokens[pos.i];
		if (depth === 0 && t.type === "op" && t.value === close) {
			pos.i++;
			return inner;
		}
		depth += depthDelta(t);
		inner.push(t);
		pos.i++;
	}
	return inner;
}

function callArgs(tokens: Token[], pos: { i: number }): string {
	const inner = bracketTokens(tokens, pos, ")");
	const parts = splitTop(inner, ",");
	const rendered = parts.slice(0, 3).map(part => renderArg(part));
	const extra = parts.length - rendered.length;
	if (extra > 0) rendered.push(`…+${extra}`);
	return rendered.join(", ");
}

function depthUpTo(tokens: Token[], index: number): number {
	let depth = 0;
	for (let i = 0; i < index; i++) depth += depthDelta(tokens[i]);
	return depth;
}

function splitNameOp(tokens: Token[], word: string): [Token[], Token[]] | null {
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].type === "name" && tokens[i].value === word && depthUpTo(tokens, i) === 0) {
			return [tokens.slice(0, i), tokens.slice(i + 1)];
		}
	}
	return null;
}

function summarizeElement(part: Token[]): string {
	if (
		part.some(
			(tok, i) => (isOp(tok, ":") || (tok.type === "name" && tok.value === "for")) && depthUpTo(part, i) === 0,
		)
	) {
		return cap(joinTokens(part), 36);
	}
	return summarize(part, 32);
}

function summarizeSubscript(inner: Token[]): string {
	const parts = splitTop(inner, ",").filter(part => part.length > 0);
	const rendered = parts.slice(0, 3).map(part => {
		if (part.some((tok, i) => isOp(tok, ":") && depthUpTo(part, i) === 0)) {
			return cap(joinTokens(part), 40).replace(/:\s+/g, ":");
		}
		return summarize(part, 40);
	});
	const extra = parts.length - rendered.length;
	if (extra > 0) rendered.push(`…+${extra}`);
	return rendered.join(", ");
}

function renderArg(tokens: Token[]): string {
	if (tokens.some((t, i) => t.type === "name" && t.value === "for" && depthUpTo(tokens, i) === 0)) {
		return cap(joinTokens(tokens), 48);
	}
	for (let i = 0; i < tokens.length; i++) {
		if (isOp(tokens[i], "**") || isOp(tokens[i], "*")) return joinTokens(tokens);
		if (isOp(tokens[i], "=") && i > 0 && tokens[i - 1].type === "name" && !isOp(tokens[i - 1], "=")) {
			return `${tokens[i - 1].value}=${summarize(tokens.slice(i + 1), 40)}`;
		}
	}
	return summarize(tokens, 40);
}

function bracketAtom(tokens: Token[], pos: { i: number }, open: string, close: string): string {
	const inner = bracketTokens(tokens, pos, close);
	if (inner.length === 0) return `${open}${close}`;
	const parts = splitTop(inner, ",");
	const isSingle = parts.length === 1;
	const hasFor = inner.some(t => t.type === "name" && t.value === "for");
	if (open === "(" && isSingle && !hasFor) {
		return `(${summarize(inner, 48)})`;
	}
	if (isSingle && hasFor) {
		return `${open}${cap(joinTokens(inner), 48)}${close}`;
	}
	const rendered = parts.slice(0, 3).map(part => summarizeElement(part));
	const extra = parts.length - rendered.length;
	if (extra > 0) rendered.push(`…+${extra}`);
	return `${open}${rendered.join(", ")}${close}`;
}

function splitTop(tokens: Token[], sep: string): Token[][] {
	const parts: Token[][] = [];
	let current: Token[] = [];
	let depth = 0;
	for (const t of tokens) {
		if (depth === 0 && t.type === "op" && t.value === sep) {
			parts.push(current);
			current = [];
			continue;
		}
		depth += depthDelta(t);
		current.push(t);
	}
	parts.push(current);
	return parts;
}

interface AssignScan {
	assign: number;
	augment: number;
}

function scanAssign(tokens: Token[]): AssignScan {
	let depth = 0;
	let augment = 0;
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		depth += depthDelta(t);
		if (depth !== 0) continue;
		if (isOp(t, "=")) {
			const prev = tokens[i - 1];
			if (
				isOp(prev, ":") ||
				isOp(prev, "=") ||
				isOp(prev, "!") ||
				isOp(prev, "<") ||
				isOp(prev, ">") ||
				isOp(prev, "+") ||
				isOp(prev, "-") ||
				isOp(prev, "*") ||
				isOp(prev, "/")
			)
				continue;
			return { assign: i, augment: 0 };
		}
		if (t.type === "op" && AUG_OPS.has(t.value)) augment = i;
	}
	if (augment > 0) return { assign: -1, augment };
	return { assign: 0, augment: 0 };
}

function buildSimpleNode(text: string, line: number): PyAstNode | null {
	const tokens = tokenize(text);
	if (tokens.length === 0) return null;
	const first = tokens[0];
	if (first.type === "name" && KEYWORD_SIMPLE.has(first.value)) {
		const rest = tokens.slice(1);
		switch (first.value) {
			case "import":
				return buildImport(rest, line, false);
			case "from":
				return buildImport(rest, line, true);
			case "return":
				return node("return", line, undefined, summarize(rest));
			case "raise": {
				const cause = splitNameOp(rest, "from");
				const detail = cause ? `${summarize(cause[0], 56)} from ${joinTokens(cause[1])}` : summarize(rest);
				return node("raise", line, undefined, detail);
			}
			case "assert": {
				const parts = splitTop(rest, ",")
					.map(part => summarize(part, 48))
					.filter(p => p.length > 0);
				return node("assert", line, undefined, parts.join(", "));
			}
			case "del":
				return node("del", line, undefined, summarize(rest));
			case "global":
			case "nonlocal":
				return node(first.value, line, undefined, renderTokens(rest));
			default:
				return node(first.value, line);
		}
	}
	const scan = scanAssign(tokens);
	if (scan.augment > 0) {
		const target = summarize(tokens.slice(0, scan.augment), 40);
		const value = summarize(tokens.slice(scan.augment + 1), 56);
		return node(tokens[scan.augment].value, line, target, value);
	}
	if (scan.assign > 0) {
		const targets = splitTop(tokens.slice(0, scan.assign), ",").map(part => summarize(part, 40));
		const value = summarize(tokens.slice(scan.assign + 1), 64);
		return node("assign", line, targets.join(", "), value);
	}
	if (tokens.length >= 3 && isOp(tokens[1], ":")) {
		const eqIndex = tokens.findIndex((t, i) => i > 1 && isOp(t, "=") && !isOp(tokens[i - 1], "="));
		const typeEnd = eqIndex > 0 ? eqIndex : tokens.length;
		const typeSummary = summarize(tokens.slice(2, typeEnd), 40);
		const value = eqIndex > 0 ? summarize(tokens.slice(eqIndex + 1), 48) : "";
		return node("assign", line, tokens[0].value, value ? `${typeSummary} ← ${value}` : typeSummary);
	}
	const exprNode = node("expr", line, undefined, summarize(tokens, 80));
	if (tokens.length === 1 && tokens[0].type === "string") {
		exprNode.rawString = tokens[0].value;
	}
	return exprNode;
}

function buildImport(rest: Token[], line: number, fromForm: boolean): PyAstNode {
	if (!fromForm) {
		const detail = rest.length > 1 ? joinTokens(rest) : undefined;
		const name = detail ? undefined : rest[0]?.value;
		return node("import", line, name, detail);
	}
	const importIndex = rest.findIndex(t => t.type === "name" && t.value === "import");
	const module = rest
		.slice(0, importIndex)
		.map(t => t.value)
		.join("");
	const names = importIndex >= 0 ? rest.slice(importIndex + 1) : [];
	return node("from-import", line, module, cap(joinTokens(names), 56));
}

function summarizeParam(tokens: Token[]): string {
	const colon = tokens.findIndex(t => isOp(t, ":"));
	if (colon <= 0) return summarize(tokens, 32);
	const name = renderTokens(tokens.slice(0, colon)).replace(/\s+/g, "");
	const ann = summarize(tokens.slice(colon + 1), 24);
	return `${name}: ${ann}`;
}

function buildHeaderNode(match: HeaderMatch, tokens: Token[], line: number, decorators: string[]): PyAstNode {
	const rest = match.rest;
	let result: PyAstNode;
	switch (match.kind) {
		case "def":
		case "async def": {
			const name = rest[0]?.type === "name" ? rest[0].value : "";
			const paren = rest.findIndex(t => t.type === "op" && t.value === "(");
			let label = name;
			let detail: string | undefined;
			if (paren >= 0) {
				const absParen = match.colonIndex - rest.length + paren;
				posHolder.i = absParen;
				const inner = bracketTokens(tokens, posHolder, ")");
				const params = splitTop(inner, ",").map(part => summarizeParam(part));
				label = `${name}(${params.join(", ")})`;
				const arrow = tokens.findIndex(t => t.type === "op" && t.value === "->");
				if (arrow >= 0 && arrow < match.colonIndex) {
					detail = `→ ${summarize(tokens.slice(arrow + 1, match.colonIndex), 40)}`;
				}
			}
			result = node(match.kind, line, label, detail);
			break;
		}
		case "class": {
			const name = rest[0]?.type === "name" ? rest[0].value : "";
			const paren = rest.findIndex(t => t.type === "op" && t.value === "(");
			let label = name;
			if (paren >= 0) {
				label = `${name}(${summarize(rest.slice(paren + 1, rest.length - 1), 48)})`;
			}
			result = node("class", line, label);
			break;
		}
		case "for": {
			const inIndex = rest.findIndex((t, i) => t.type === "name" && t.value === "in" && depthUpTo(rest, i) === 0);
			const target = inIndex >= 0 ? cap(joinTokens(rest.slice(0, inIndex)), 40) : summarize(rest, 40);
			const iter = inIndex >= 0 ? summarize(rest.slice(inIndex + 1), 48) : "";
			result = node("for", line, target, iter);
			break;
		}
		case "with": {
			const parts = splitTop(rest, ",").map(part => {
				const binding = splitNameOp(part, "as");
				if (binding) return `${summarize(binding[0], 40)} as ${joinTokens(binding[1])}`;
				return summarize(part, 48);
			});
			result = node("with", line, undefined, parts.join(", "));
			break;
		}
		case "except": {
			const binding = splitNameOp(rest, "as");
			const detail = binding ? `${summarize(binding[0], 48)} as ${joinTokens(binding[1])}` : summarize(rest, 64);
			result = node("except", line, undefined, detail);
			break;
		}
		default: {
			result = node(match.kind, line, undefined, summarize(rest, 64));
		}
	}
	if (decorators.length > 0) {
		result.detail = result.detail ? `${decorators.join(" ")} ${result.detail}` : decorators.join(" ");
	}
	return result;
}

const posHolder = { i: 0 };

function parsePyOutline(source: string): PyAstNode | null {
	let lines: LogicalLine[];
	try {
		lines = assembleLogicalLines(source);
	} catch (error) {
		console.error("OUTLINE_THROW", error);
		return null;
	}
	if (lines.length === 0) return null;
	const root = node("Module", 1);
	const stack: Array<{ node: PyAstNode; indent: number }> = [{ node: root, indent: -1 }];
	let decorators: string[] = [];
	let pendingNotes: string[] = [];
	let pendingQuestions: string[] = [];

	const attachNotes = (target: PyAstNode) => {
		if (pendingNotes.length > 0) target.notes = [...(target.notes ?? []), ...pendingNotes];
		if (pendingQuestions.length > 0) target.questions = [...(target.questions ?? []), ...pendingQuestions];
		pendingNotes = [];
		pendingQuestions = [];
	};

	for (const ll of lines) {
		const note = isNoteLine(ll.text);
		if (note) {
			if (note.question) pendingQuestions.push(note.text);
			else pendingNotes.push(note.text);
			continue;
		}
		const tokens = tokenize(ll.text);
		const header = matchHeader(tokens);
		if (header && isClause(header.kind)) {
			let targetIndex = -1;
			for (let i = stack.length - 1; i >= 1; i--) {
				const frame = stack[i];
				if (frame.indent > ll.indent) continue;
				if (frame.indent < ll.indent) break;
				if (clauseReceptive(frame.node.kind, header.kind)) {
					targetIndex = i;
					break;
				}
			}
			if (targetIndex >= 0) {
				const target = stack[targetIndex];
				const clauseNode = buildHeaderNode(header, tokens, ll.line, decorators);
				decorators = [];
				attachNotes(clauseNode);
				target.node.children.push(clauseNode);
				stack.splice(targetIndex + 1);
				stack.push({ node: clauseNode, indent: ll.indent });
				continue;
			}
		}
		while (stack.length > 1 && ll.indent <= stack[stack.length - 1].indent) stack.pop();
		const parent = stack[stack.length - 1].node;
		if (header) {
			const headerNode = buildHeaderNode(header, tokens, ll.line, decorators);
			decorators = [];
			attachNotes(headerNode);
			parent.children.push(headerNode);
			stack.push({ node: headerNode, indent: ll.indent });
			continue;
		}
		if (tokens[0]?.type === "op" && tokens[0].value === "@") {
			decorators.push(summarize(tokens.slice(1), 48));
			continue;
		}
		if (decorators.length > 0) decorators = [];
		for (const stmt of splitTopLevelText(ll.text)) {
			const stmtNode = buildSimpleNode(stmt, ll.line);
			if (stmtNode) {
				attachNotes(stmtNode);
				parent.children.push(stmtNode);
			}
		}
	}
	attachNotes(root);
	extractDocstrings(root);
	return root;
}

function extractDocstrings(tree: PyAstNode): void {
	for (const child of tree.children) {
		if ((child.kind === "def" || child.kind === "async def" || child.kind === "class") && child.children.length > 0) {
			const first = child.children[0];
			const doc = firstDocLine(first);
			if (doc) {
				child.doc = doc;
				child.children.shift();
			}
		}
		extractDocstrings(child);
	}
}

function firstDocLine(child: PyAstNode): string | null {
	if (child.kind !== "expr") return null;
	const source = child.rawString ?? child.detail;
	if (!source) return null;
	const match = source.match(/^("""|'''|"|')(.*?)$/s);
	if (!match) return null;
	const body = match[2].replace(/("""|'''|"|')\s*$/, "");
	const firstLine = body.split("\n")[0]?.trim() ?? "";
	return firstLine.length > 0 ? firstLine : null;
}

function splitTopLevelText(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	let i = 0;
	while (i < text.length) {
		const str = scanString(text, i);
		if (str) {
			current += str.token.value;
			i = str.end;
			continue;
		}
		const ch = text[i];
		if ("([{".includes(ch)) depth++;
		if (")]}".includes(ch)) depth--;
		if (ch === ";" && depth === 0) {
			parts.push(current);
			current = "";
			i++;
			continue;
		}
		current += ch;
		i++;
	}
	if (current.trim().length > 0) parts.push(current);
	return parts.map(p => p.trim()).filter(p => p.length > 0);
}

const outlineMemo = new Map<string, PyAstNode | null>();

function parseMemoized(source: string): PyAstNode | null {
	const hit = outlineMemo.get(source);
	if (hit !== undefined) return hit;
	const result = parsePyOutline(source);
	if (outlineMemo.size > 8) outlineMemo.clear();
	outlineMemo.set(source, result);
	return result;
}

function countLeaves(children: PyAstNode[]): number {
	let count = 0;
	for (const child of children) {
		count += 1 + countLeaves(child.children);
	}
	return count;
}

export function renderPythonAstLines(source: string, theme: Theme, width: number): string[] | null {
	const root = parseMemoized(source);
	if (!root || root.children.length === 0) return null;
	const total = countLeaves(root.children);
	const lines: string[] = [`${theme.fg("dim", "Module")} ${theme.fg("dim", `· ${total} nodes`)}`];
	const walk = (children: PyAstNode[], prefix: string) => {
		children.forEach((child, index) => {
			const last = index === children.length - 1;
			const connector = `${prefix}${last ? "└─ " : "├─ "}`;
			for (const note of child.notes ?? []) {
				lines.push(formatNoteLine(note, connector, theme, width, "accent"));
			}
			for (const question of child.questions ?? []) {
				lines.push(formatNoteLine(question, connector, theme, width, "warning"));
			}
			lines.push(formatAstLine(child, connector, theme, width));
			if (child.children.length > 0) {
				walk(child.children, `${prefix}${last ? "   " : "│  "}`);
			}
		});
	};
	walk(root.children, "");
	return lines;
}

function formatNoteLine(
	note: string,
	connector: string,
	theme: Theme,
	width: number,
	color: "accent" | "warning",
): string {
	const body = truncateToWidth(note, Math.max(24, width - connector.length - 8));
	return `${connector}${theme.fg(color, `▌ ${body}`)}`;
}

const HEADER_KINDS = new Set([
	"def",
	"async def",
	"class",
	"if",
	"elif",
	"else",
	"for",
	"while",
	"try",
	"except",
	"finally",
	"with",
	"match",
	"case",
	"async for",
	"async with",
]);

function isAugKind(kind: string): boolean {
	return AUG_OPS.has(kind);
}

function formatAstLine(child: PyAstNode, connector: string, theme: Theme, width: number): string {
	const name = child.name && child.name.length > 0 ? child.name : "";
	const detail = child.detail && child.detail.length > 0 ? child.detail : "";
	let core: string;
	if (child.kind === "assign") {
		core = detail
			? `${theme.fg("toolTitle", name)} ${theme.fg("dim", "←")} ${theme.fg("toolOutput", detail)}`
			: theme.fg("toolTitle", name);
	} else if (isAugKind(child.kind)) {
		core = `${theme.fg("toolTitle", name)} ${theme.fg("dim", child.kind)} ${theme.fg("toolOutput", detail)}`;
	} else if (child.kind === "expr") {
		core = theme.fg("toolOutput", detail);
	} else {
		const parts: string[] = [theme.fg("dim", child.kind)];
		if (name.length > 0) parts.push(theme.fg("toolTitle", name));
		if (detail.length > 0) parts.push(theme.fg("toolOutput", detail));
		core = parts.join(" ");
	}
	if (child.doc && child.doc.length > 0) {
		core += ` ${theme.fg("dim", `— ${child.doc}`)}`;
	}
	let line = `${connector}${core}`;
	if (HEADER_KINDS.has(child.kind)) {
		line += theme.fg("dim", ` ·L${child.line}`);
	}
	const bodyWidth = Math.max(24, width - connector.length - 8);
	return truncateToWidth(line, bodyWidth);
}
