export interface StreamedKernelFailure {
	toolCallId: string;
	message: string;
	line?: number;
	count?: number;
	expected?: number;
	provenance?: string;
}

export type StreamedCompletionLanguage = "python" | "js";
export type CompletionTier = "smol" | "default" | "slow";

export interface LiteralCompletionArgs {
	prompt: string;
	model: CompletionTier;
	system?: string;
	schema?: Record<string, unknown>;
}

export interface LiteralCompletionCall {
	index: number;
	language: StreamedCompletionLanguage;
	args: LiteralCompletionArgs;
	source: string;
	fingerprint: string;
	start: number;
	end: number;
}

export interface StreamedBashInput {
	command?: string;
	cwd?: string;
	env?: Record<string, string>;
	pty?: boolean;
	async?: boolean;
}

export interface StreamedHeredocCell {
	language: StreamedCompletionLanguage;
	code: string;
	closed: boolean;
}

/** Shared bound for decoding one streamed tool-call JSON payload. */
export const MAX_STREAMED_INPUT_JSON_BYTES = 4 * 1024 * 1024;

/**
 * Maximum cadence for work derived from a streamed tool-call prefix. The
 * observer keeps the latest value and runs it at most once per interval while
 * a stream remains active; callers can force a trailing flush when the call
 * ends or execution is about to claim speculative work.
 */
export const STREAMED_INPUT_OBSERVATION_INTERVAL_MS = 16;

export interface LatestValueSchedulerOptions {
	delayMs?: number;
}

/**
 * Run only the newest value in a burst, with a bounded trailing cadence.
 * `flush()` drains immediately and is deterministic for callers/tests; a
 * queued timer is merely the normal streaming path. Work is never dropped by
 * `flush()` and cancellation only drops values that have not started running.
 */
export class LatestValueScheduler<T> {
	readonly #run: (value: T) => Promise<void> | void;
	readonly #delayMs: number;
	#pending: T | undefined;
	#hasPending = false;
	#timer: NodeJS.Timeout | undefined;
	#running: Promise<void> | undefined;
	#flushPromise: Promise<void> | undefined;

	constructor(run: (value: T) => Promise<void> | void, options: LatestValueSchedulerOptions = {}) {
		this.#run = run;
		this.#delayMs = Math.max(0, Math.floor(options.delayMs ?? STREAMED_INPUT_OBSERVATION_INTERVAL_MS));
	}

	enqueue(value: T): void {
		this.#pending = value;
		this.#hasPending = true;
		if (this.#running || this.#timer !== undefined) return;
		this.#armTimer();
	}

	async flush(): Promise<void> {
		if (this.#flushPromise) return await this.#flushPromise;
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		const flushPromise = this.#runPending(true);
		this.#flushPromise = flushPromise;
		try {
			await flushPromise;
		} finally {
			if (this.#flushPromise === flushPromise) this.#flushPromise = undefined;
		}
	}

	cancel(): void {
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#pending = undefined;
		this.#hasPending = false;
	}

	#armTimer(): void {
		const timer = setTimeout(() => {
			if (this.#timer !== timer) return;
			this.#timer = undefined;
			void this.#runPending(false).catch(() => undefined);
		}, this.#delayMs);
		timer.unref?.();
		this.#timer = timer;
	}

	async #runPending(force: boolean): Promise<void> {
		if (this.#running) {
			await this.#running;
			if (this.#hasPending) {
				if (force) await this.#runPending(true);
				else if (this.#timer === undefined) this.#armTimer();
			}
			return;
		}
		if (!this.#hasPending) return;
		const value = this.#pending as T;
		this.#pending = undefined;
		this.#hasPending = false;
		const running = Promise.resolve().then(() => this.#run(value));
		this.#running = running;
		let failure: unknown;
		try {
			await running;
		} catch (error) {
			failure = error;
		} finally {
			if (this.#running === running) this.#running = undefined;
		}
		if (this.#hasPending) {
			if (force) await this.#runPending(true);
			else if (this.#timer === undefined) this.#armTimer();
		}
		if (failure !== undefined) throw failure;
	}
}

const PY_IDENT_START = /[A-Za-z_]/u;
const PY_IDENT_CONT = /[A-Za-z0-9_]/u;
const JS_IDENT_START = /[A-Za-z_$]/u;
const JS_IDENT_CONT = /[A-Za-z0-9_$]/u;
const CONTROL_WORDS = new Set([
	"if",
	"else",
	"elif",
	"for",
	"while",
	"try",
	"except",
	"finally",
	"catch",
	"switch",
	"case",
	"with",
	"match",
	"function",
	"class",
	"def",
	"lambda",
	"return",
	"yield",
	"break",
	"continue",
	"do",
]);

interface Token {
	kind: "identifier" | "string" | "number" | "punct";
	value: string;
	raw: string;
	start: number;
	end: number;
}
interface LexResult {
	tokens: Token[];
	incomplete: boolean;
	valid: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeString(raw: string): string | undefined {
	if (raw.length < 2) return undefined;
	const quote = raw[0];
	if ((quote !== "'" && quote !== '"') || raw[raw.length - 1] !== quote) return undefined;
	let out = "";
	for (let i = 1; i < raw.length - 1; i++) {
		const ch = raw[i]!;
		if (ch !== "\\") {
			if (ch === "\n" || ch === "\r") return undefined;
			out += ch;
			continue;
		}
		if (i + 1 >= raw.length - 1) return undefined;
		const next = raw[++i]!;
		switch (next) {
			case "n":
				out += "\n";
				break;
			case "r":
				out += "\r";
				break;
			case "t":
				out += "\t";
				break;
			case "b":
				out += "\b";
				break;
			case "f":
				out += "\f";
				break;
			case "v":
				out += "\v";
				break;
			case "0":
				out += "\0";
				break;
			case "\\":
				out += "\\";
				break;
			case "'":
				out += "'";
				break;
			case '"':
				out += '"';
				break;
			case "/":
				out += "/";
				break;
			case "x": {
				const hex = raw.slice(i + 1, i + 3);
				if (!/^[0-9a-fA-F]{2}$/u.test(hex)) return undefined;
				out += String.fromCharCode(Number.parseInt(hex, 16));
				i += 2;
				break;
			}
			case "u": {
				const hex = raw.slice(i + 1, i + 5);
				if (!/^[0-9a-fA-F]{4}$/u.test(hex)) return undefined;
				out += String.fromCharCode(Number.parseInt(hex, 16));
				i += 4;
				break;
			}
			case "\n":
				break;
			default:
				out += next;
		}
	}
	return out;
}

/**
 * Recognize the runner's raw-heredoc header at the first non-indentation character
 * of a physical line. Callers remain responsible for invoking this only while
 * outside strings and comments.
 */
export function isPythonRawHeredocHeader(
	source: string,
	index: number,
	lineStart: number,
	limit = source.length,
): boolean {
	if (index < lineStart || limit < index || !/^[ \t]*$/u.test(source.slice(lineStart, index))) return false;
	const newline = source.indexOf("\n", index);
	const lineEnd = newline < 0 ? Math.min(source.length, limit) : Math.min(newline, limit);
	let line = source.slice(lineStart, lineEnd);
	if (line.endsWith("\r")) line = line.slice(0, -1);
	return /^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*<<[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*$/u.test(line);
}

function lexSource(source: string, language: StreamedCompletionLanguage): LexResult {
	const tokens: Token[] = [];
	let i = 0;
	let lineStart = 0;
	let incomplete = false;
	const isStart = language === "python" ? PY_IDENT_START : JS_IDENT_START;
	const isCont = language === "python" ? PY_IDENT_CONT : JS_IDENT_CONT;
	while (i < source.length) {
		const ch = source[i]!;
		if (/\s/u.test(ch)) {
			if (ch === "\n") lineStart = i + 1;
			i++;
			continue;
		}
		if (language === "python" && isPythonRawHeredocHeader(source, i, lineStart)) {
			// The Python runner replaces the whole block before execution. Stop at
			// its header: the body is raw text, even when its close has not streamed.
			incomplete = true;
			break;
		}
		if (language === "python" && ch === "#") {
			const end = source.indexOf("\n", i);
			i = end < 0 ? source.length : end + 1;
			if (end >= 0) lineStart = i;
			continue;
		}
		if (language === "js" && ch === "/" && source[i + 1] === "/") {
			const end = source.indexOf("\n", i + 2);
			i = end < 0 ? source.length : end + 1;
			continue;
		}
		if (language === "js" && ch === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			if (end < 0) {
				incomplete = true;
				break;
			}
			i = end + 2;
			continue;
		}
		if (language === "python" && (ch === "'" || ch === '"') && source.startsWith(ch.repeat(3), i)) {
			const delimiter = ch.repeat(3);
			i += delimiter.length;
			let closed = false;
			while (i < source.length) {
				const c = source[i]!;
				if (c === "\\") {
					if (source[i + 1] === "\n") lineStart = i + 2;
					i += 2;
					continue;
				}
				if (source.startsWith(delimiter, i)) {
					i += delimiter.length;
					closed = true;
					break;
				}
				if (c === "\n") lineStart = i + 1;
				i++;
			}
			if (!closed) incomplete = true;
			if (!closed) break;
			continue;
		}
		if (ch === "`") {
			return { tokens, incomplete: false, valid: false };
		}
		if (ch === "'" || ch === '"') {
			const start = i;
			const quote = ch;
			i++;
			let closed = false;
			while (i < source.length) {
				const c = source[i]!;
				if (c === "\n" || c === "\r") return { tokens, incomplete: false, valid: false };
				if (c === "\\") {
					if (source[i + 1] === "\n") lineStart = i + 2;
					i += 2;
					continue;
				}
				i++;
				if (c === quote) {
					closed = true;
					break;
				}
			}
			if (!closed) {
				incomplete = true;
				break;
			}
			const raw = source.slice(start, i);
			const value = decodeString(raw);
			if (value === undefined) return { tokens, incomplete: false, valid: false };
			tokens.push({ kind: "string", value, raw, start, end: i });
			continue;
		}
		if (isStart.test(ch)) {
			const start = i++;
			while (i < source.length && isCont.test(source[i]!)) i++;
			const raw = source.slice(start, i);
			tokens.push({ kind: "identifier", value: raw, raw, start, end: i });
			continue;
		}
		if (/[0-9]/u.test(ch) || (ch === "-" && /[0-9]/u.test(source[i + 1] ?? ""))) {
			const start = i++;
			while (i < source.length && /[A-Za-z0-9._+-]/u.test(source[i]!)) i++;
			const raw = source.slice(start, i);
			tokens.push({ kind: "number", value: raw, raw, start, end: i });
			continue;
		}
		tokens.push({ kind: "punct", value: ch, raw: ch, start: i, end: ++i });
	}
	return { tokens, incomplete, valid: true };
}

function decodeJsonStringAt(input: string, start: number): { value: string; end?: number } | undefined {
	if (input[start] !== '"') return undefined;
	let value = "";
	for (let index = start + 1; index < input.length; index++) {
		const char = input[index]!;
		if (char === '"') return { value, end: index };
		if (char !== "\\") {
			if (char.charCodeAt(0) < 0x20) return undefined;
			value += char;
			continue;
		}
		const next = input[index + 1];
		if (next === undefined) return { value };
		index++;
		switch (next) {
			case '"':
			case "\\":
			case "/":
				value += next;
				break;
			case "b":
				value += "\b";
				break;
			case "f":
				value += "\f";
				break;
			case "n":
				value += "\n";
				break;
			case "r":
				value += "\r";
				break;
			case "t":
				value += "\t";
				break;
			case "u": {
				const hex = input.slice(index + 1, index + 5);
				if (hex.length < 4) return { value };
				if (!/^[0-9a-fA-F]{4}$/u.test(hex)) return undefined;
				value += String.fromCharCode(Number.parseInt(hex, 16));
				index += 4;
				break;
			}
			default:
				return undefined;
		}
	}
	return { value };
}
/** Decode only a valid object prefix; never recover keys from nested values or prose. */
function parseRootFields(input: string): Record<string, unknown> | undefined {
	const fields: Record<string, unknown> = Object.create(null);
	let index = 0;
	const skipWhitespace = (): void => {
		while (/[ \t\r\n]/u.test(input[index] ?? "")) index++;
	};
	skipWhitespace();
	if (input[index++] !== "{") return undefined;
	skipWhitespace();
	if (input[index] === "}") return input.slice(index + 1).trim() === "" ? fields : undefined;
	while (index < input.length) {
		const key = decodeJsonStringAt(input, index);
		if (!key) return undefined;
		if (key.end === undefined) return fields;
		if (Object.hasOwn(fields, key.value)) return undefined;
		index = key.end + 1;
		skipWhitespace();
		if (index === input.length) return fields;
		if (input[index++] !== ":") return undefined;
		skipWhitespace();
		if (index === input.length) return fields;
		if (input[index] === '"') {
			const value = decodeJsonStringAt(input, index);
			if (!value) return undefined;
			fields[key.value] = value.value;
			if (value.end === undefined) return fields;
			index = value.end + 1;
		} else {
			const start = index;
			const stack: string[] = [];
			for (; index < input.length; index++) {
				const char = input[index]!;
				if (char === '"') {
					const string = decodeJsonStringAt(input, index);
					if (!string) return undefined;
					if (string.end === undefined) return fields;
					index = string.end;
				} else if (char === "{" || char === "[") {
					stack.push(char);
				} else if (char === "}" || char === "]") {
					if (stack.length === 0) break;
					if (stack.pop() !== (char === "}" ? "{" : "[")) return undefined;
				} else if (char === "," && stack.length === 0) {
					break;
				}
			}
			if (stack.length > 0) return fields;
			try {
				fields[key.value] = JSON.parse(input.slice(start, index));
			} catch {
				return index === input.length ? fields : undefined;
			}
		}
		skipWhitespace();
		if (index === input.length) return fields;
		if (input[index] === "}") return input.slice(index + 1).trim() === "" ? fields : undefined;
		if (input[index++] !== ",") return undefined;
		skipWhitespace();
	}
	return fields;
}

function parsePartialRecord(rawPartialJson: string): StreamedBashInput {
	if (rawPartialJson.length > MAX_STREAMED_INPUT_JSON_BYTES) return {};
	const parsed = parseRootFields(rawPartialJson);
	if (!parsed) return {};
	const env: Record<string, string> = Object.create(null);
	if (isRecord(parsed.env)) {
		for (const [key, value] of Object.entries(parsed.env)) {
			if (typeof value === "string") env[key] = value;
		}
	}
	return {
		command: typeof parsed.command === "string" ? parsed.command : undefined,
		cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
		env: Object.keys(env).length > 0 ? env : undefined,
		pty: typeof parsed.pty === "boolean" ? parsed.pty : undefined,
		async: typeof parsed.async === "boolean" ? parsed.async : undefined,
	};
}

export function parseStreamedBashInput(rawPartialJson: string): StreamedBashInput {
	return parsePartialRecord(rawPartialJson);
}

function readIdentifierAt(text: string, start: number): { value: string; end: number } | undefined {
	const first = text[start];
	if (!first || !PY_IDENT_START.test(first)) return undefined;
	let end = start + 1;
	while (end < text.length && PY_IDENT_CONT.test(text[end]!)) end++;
	return { value: text.slice(start, end), end };
}

function isHorizontalWhitespace(text: string): boolean {
	return /^[ \t]*$/u.test(text);
}

export function parseStandaloneQuotedHeredoc(command: string): StreamedHeredocCell | undefined {
	let i = 0;
	while (i < command.length && /[ \t\r\n]/u.test(command[i]!)) i++;
	const executable = readIdentifierAt(command, i);
	if (!executable || !["python", "python3", "node", "bun"].includes(executable.value)) return undefined;
	i = executable.end;
	while (i < command.length && /[ \t]/u.test(command[i]!)) i++;
	if (command[i] === "-") {
		i++;
		while (i < command.length && /[ \t]/u.test(command[i]!)) i++;
	}
	if (command[i] !== "<" || command[i + 1] !== "<") return undefined;
	i += 2;
	const stripTabs = command[i] === "-";
	if (stripTabs) i++;
	while (i < command.length && /[ \t]/u.test(command[i]!)) i++;
	const quote = command[i];
	if (quote !== "'" && quote !== '"') return undefined;
	i++;
	const delimiterStart = i;
	while (i < command.length && /[A-Za-z0-9_]/u.test(command[i]!)) i++;
	if (i === delimiterStart || command[i] !== quote) return undefined;
	const delimiter = command.slice(delimiterStart, i);
	i++;
	while (i < command.length && /[ \t]/u.test(command[i]!)) i++;
	if (command[i] !== "\n") return undefined;
	const bodyStart = i + 1;
	let cursor = bodyStart;
	let bodyEnd = command.length;
	let closed = false;
	while (cursor <= command.length) {
		const lineEnd = command.indexOf("\n", cursor);
		const end = lineEnd < 0 ? command.length : lineEnd;
		let line = command.slice(cursor, end);
		if (stripTabs) line = line.replace(/^\t+/u, "");
		if (line.startsWith(delimiter) && isHorizontalWhitespace(line.slice(delimiter.length))) {
			bodyEnd = cursor;
			closed = true;
			const suffixStart = lineEnd < 0 ? command.length : lineEnd + 1;
			if (!isHorizontalWhitespace(command.slice(suffixStart))) return undefined;
			break;
		}
		if (lineEnd < 0) break;
		cursor = lineEnd + 1;
	}
	const language: StreamedCompletionLanguage =
		executable.value === "node" || executable.value === "bun" ? "js" : "python";
	const code = command.slice(bodyStart, bodyEnd);
	return code.trim().length > 0 ? { language, code, closed } : undefined;
}

class LiteralCursor {
	index = 0;
	constructor(readonly tokens: Token[]) {}
	peek(): Token | undefined {
		return this.tokens[this.index];
	}
	next(): Token | undefined {
		return this.tokens[this.index++];
	}
	consume(value: string): boolean {
		if (this.peek()?.value !== value) return false;
		this.index++;
		return true;
	}
	atEnd(): boolean {
		return this.index >= this.tokens.length;
	}
}

function parseLiteral(cursor: LiteralCursor): unknown {
	const token = cursor.next();
	if (!token) return undefined;
	if (token.kind === "string") return token.value;
	if (token.kind === "number") {
		if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(token.raw)) return undefined;
		const value = Number(token.raw);
		return Number.isFinite(value) ? value : undefined;
	}
	if (token.kind === "identifier") {
		if (token.value === "true" || token.value === "True") return true;
		if (token.value === "false" || token.value === "False") return false;
		if (token.value === "null" || token.value === "None") return null;
		return undefined;
	}
	if (token.value === "[") {
		const values: unknown[] = [];
		if (cursor.consume("]")) return values;
		while (true) {
			const value = parseLiteral(cursor);
			if (value === undefined && cursor.peek()?.value !== "null") return undefined;
			values.push(value);
			if (cursor.consume("]")) return values;
			if (!cursor.consume(",")) return undefined;
			if (cursor.consume("]")) return values;
		}
	}
	if (token.value === "{") {
		const object: Record<string, unknown> = {};
		if (cursor.consume("}")) return object;
		while (true) {
			const key = cursor.next();
			if (!key || (key.kind !== "string" && key.kind !== "identifier")) return undefined;
			if (!cursor.consume(":")) return undefined;
			const value = parseLiteral(cursor);
			if (value === undefined && cursor.peek()?.value !== "null") return undefined;
			if (Object.hasOwn(object, key.value)) return undefined;
			object[key.value] = value;
			if (cursor.consume("}")) return object;
			if (!cursor.consume(",")) return undefined;
			if (cursor.consume("}")) return object;
		}
	}
	return undefined;
}

function parseLiteralArgs(inner: string, language: StreamedCompletionLanguage): LiteralCompletionArgs | undefined {
	const lexed = lexSource(inner, language);
	if (!lexed.valid || lexed.incomplete) return undefined;
	const cursor = new LiteralCursor(lexed.tokens);
	const prompt = parseLiteral(cursor);
	if (typeof prompt !== "string" || prompt.length === 0) return undefined;
	let model: CompletionTier = "default";
	let system: string | undefined;
	let schema: Record<string, unknown> | undefined;
	const setOption = (key: string, value: unknown): boolean => {
		if (key === "model") {
			if (typeof value !== "string" || !["smol", "default", "slow"].includes(value)) return false;
			model = value as CompletionTier;
			return true;
		}
		if (key === "system") {
			if (value !== null && typeof value !== "string") return false;
			system = value === null ? undefined : value;
			return true;
		}
		if (key === "schema") {
			if (!isRecord(value)) return false;
			schema = value;
			return true;
		}
		return false;
	};
	if (language === "python") {
		while (!cursor.atEnd()) {
			if (!cursor.consume(",")) return undefined;
			const key = cursor.next();
			if (key?.kind !== "identifier" || !cursor.consume("=")) return undefined;
			const value = parseLiteral(cursor);
			if (value === undefined && cursor.peek()?.value !== "null") return undefined;
			if (!setOption(key.value, value)) return undefined;
		}
	} else if (!cursor.atEnd()) {
		if (!cursor.consume(",")) return undefined;
		if (cursor.peek()?.value === "{") {
			const value = parseLiteral(cursor);
			if (!isRecord(value)) return undefined;
			for (const [key, option] of Object.entries(value)) if (!setOption(key, option)) return undefined;
		} else {
			const positional: unknown[] = [];
			while (true) {
				const value = parseLiteral(cursor);
				if (value === undefined && cursor.peek()?.value !== "null") return undefined;
				positional.push(value);
				if (cursor.atEnd()) break;
				if (!cursor.consume(",")) return undefined;
			}
			if (positional.length > 3) return undefined;
			for (const [index, key] of ["model", "system", "schema"].entries()) {
				if (index < positional.length && !setOption(key, positional[index])) return undefined;
			}
		}
	}
	if (!cursor.atEnd()) return undefined;
	return { prompt, model, ...(system !== undefined ? { system } : {}), ...(schema !== undefined ? { schema } : {}) };
}

function callPrefixAllowed(source: string, token: Token, language: StreamedCompletionLanguage): boolean {
	const lineStart = source.lastIndexOf("\n", token.start - 1) + 1;
	const prefix = source.slice(lineStart, token.start);
	if (language === "python") {
		return (
			/^(?:(?:[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)?\s*=\s*)?await\s+)?$/u.test(prefix) ||
			/^(?:[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)?\s*=\s*)?$/u.test(prefix)
		);
	}
	return /^(?:(?:(?:const|let|var)\s+)?[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*)?(?:await\s+)?$/u.test(prefix);
}

function callSuffixAllowed(source: string, end: number, language: StreamedCompletionLanguage): boolean {
	const lineEnd = source.indexOf("\n", end);
	const suffix = source.slice(end, lineEnd < 0 ? source.length : lineEnd).trim();
	if (!suffix) return true;
	if (language === "python") return suffix.startsWith("#");
	if (suffix === ";") return true;
	return suffix.startsWith("//") || (suffix.startsWith("/*") && suffix.endsWith("*/"));
}

function matchingParen(tokens: Token[], openIndex: number): number | undefined {
	let depth = 0;
	for (let i = openIndex; i < tokens.length; i++) {
		const value = tokens[i]!.value;
		if (value === "(") depth++;
		else if (value === ")") {
			depth--;
			if (depth === 0) return i;
			if (depth < 0) return undefined;
		}
	}
	return undefined;
}

export function findLiteralCompletionCalls(
	language: StreamedCompletionLanguage,
	source: string,
): readonly LiteralCompletionCall[] {
	if (source.length > 64 * 1024) return [];
	const lexed = lexSource(source, language);
	if (!lexed.valid) return [];
	const tokens = lexed.tokens;
	const depths: number[] = [];
	let depth = 0;
	for (const token of tokens) {
		depths.push(depth);
		if (token.value === "(" || token.value === "[" || token.value === "{") depth++;
		else if (token.value === ")" || token.value === "]" || token.value === "}") {
			depth--;
			if (depth < 0) return [];
		}
	}
	const completionTokens = tokens
		.map((token, index) => ({ token, index }))
		.filter(item => item.token.kind === "identifier" && item.token.value === "completion");
	if (completionTokens.length === 0) return [];
	const candidates: LiteralCompletionCall[] = [];
	for (const { token, index } of completionTokens) {
		const previous = tokens[index - 1]?.value;
		const next = tokens[index + 1];
		if (previous === "." || previous === "?." || previous === "?" || next?.value !== "(" || depths[index] !== 0)
			continue;
		if (!callPrefixAllowed(source, token, language)) continue;
		const closeIndex = matchingParen(tokens, index + 1);
		if (closeIndex === undefined) continue;
		const close = tokens[closeIndex]!;
		if (!callSuffixAllowed(source, close.end, language)) continue;
		const args = parseLiteralArgs(source.slice(next!.end, close.start), language);
		if (!args) continue;
		const callSource = source.slice(token.start, close.end);
		candidates.push({
			index: candidates.length,
			language,
			args,
			source: callSource,
			fingerprint: JSON.stringify({ language, args }),
			start: token.start,
			end: close.end,
		});
	}
	if (candidates.length !== completionTokens.length) return [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token.kind === "identifier" && CONTROL_WORDS.has(token.value) && depths[index] === 0) return [];
	}
	return candidates;
}

export function findHeredocCompletionCalls(command: string): readonly LiteralCompletionCall[] {
	const cell = parseStandaloneQuotedHeredoc(command);
	return cell ? findLiteralCompletionCalls(cell.language, cell.code) : [];
}

export interface CompletionInvocationIdentity {
	toolCallId: string;
	generation: number;
	invocationId: string;
	fingerprint: string;
}

export function completionInvocationKey(identity: CompletionInvocationIdentity): string {
	return [identity.toolCallId, String(identity.generation), identity.invocationId, identity.fingerprint].join("\0");
}

export function completionInvocationIdForIndex(index: number): string {
	return String(index);
}

export function parseStreamedInputForCompletion(rawPartialJson: string): {
	input: StreamedBashInput;
	calls: readonly LiteralCompletionCall[];
} {
	const input = parsePartialRecord(rawPartialJson);
	return { input, calls: input.command ? findHeredocCompletionCalls(input.command) : [] };
}
