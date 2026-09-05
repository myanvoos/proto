import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseJavaScript } from "@babel/parser";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { ToolSession } from "../tools";
import { type BashKernelCell, detectBashKernelCell } from "../tools/bash-kernel-cell";
import type { StreamedKernelFailure as StreamedKernelFailureContract } from "./speculation";
import { parseStandaloneQuotedHeredoc, parseStreamedBashInput } from "./speculation";

/** Languages understood by the assertion preflight. */
export type PreflightKernelLanguage = "python" | "js";

/** A regular-file snapshot used to prove that a failed observation was not stale. */
export interface PreflightFileObservation {
	path: string;
	device: string;
	inode: string;
	size: number;
	mtimeNs: string;
	ctimeNs: string;
}

/** A failure found without executing a source-local streamed cell. */
export interface AssertionPreflightFailure {
	toolCallId?: string;
	message: string;
	language?: PreflightKernelLanguage;
	line?: number;
	column?: number;
	count?: number;
	expected?: number;
	path?: string;
	provenance?: readonly PreflightFileObservation[];
}

/** Structural contract consumed by BashTool's streamed guard, with private diagnostics for tests/callers. */
type StreamedPreflightResult = StreamedKernelFailureContract & {
	language?: PreflightKernelLanguage;
	column?: number;
	path?: string;
	fileObservations?: readonly PreflightFileObservation[];
};

export interface PreflightKernelSourceOptions {
	/** The kernel's effective absolute cwd. Relative literals are read only with this explicit absolute base. */
	cwd?: string;
	signal?: AbortSignal;
	language?: PreflightKernelLanguage | "py" | "javascript";
	/** Maximum source bytes inspected. A failing assertion before this limit still wins. */
	maxSourceBytes?: number;
	/** Maximum bytes read from one regular file. */
	maxFileBytes?: number;
}

export interface StreamedInputPreflightOptions extends PreflightKernelSourceOptions {
	session?: Pick<ToolSession, "cwd">;
	/** Stable caller/session identity used to isolate the bounded streamed-result cache. */
	sessionKey?: object | string;
}

const DEFAULT_MAX_SOURCE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LITERAL_CHARS = 64 * 1024;
const MAX_STATEMENTS = 4096;
const MAX_STREAMED_FAILURES = 256;
const MAX_STREAMED_FAILURE_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_STREAMED_FAILURE_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_PARTIAL_JSON_BYTES = 4 * 1024 * 1024;
const MAX_COUNT_WORK = 16 * 1024 * 1024;

const PATH_CONSTRUCTOR = Symbol("preflight pathlib.Path");
const PATH_MODULE = Symbol("preflight pathlib module");
const BUILTINS_MODULE = Symbol("preflight builtins module");
const OPEN_FUNCTION = Symbol("preflight builtins.open");
const FS_MODULE = Symbol("preflight node:fs module");
const READ_FILE_SYNC = Symbol("preflight readFileSync");
const ASSERT_FUNCTION = Symbol("preflight node:assert function");

type SafeValue =
	| string
	| number
	| boolean
	| null
	| typeof PATH_CONSTRUCTOR
	| typeof PATH_MODULE
	| typeof BUILTINS_MODULE
	| typeof OPEN_FUNCTION
	| typeof FS_MODULE
	| typeof READ_FILE_SYNC
	| typeof ASSERT_FUNCTION
	| { kind: "path"; raw: string };

interface InternalObservation {
	public: PreflightFileObservation;
	stamp: FileStamp;
}

interface FileStamp {
	device: string;
	inode: string;
	size: number;
	mtimeNs: string;
	ctimeNs: string;
}

interface ReadResult {
	text: string;
	observation: InternalObservation;
}

interface Statement {
	text: string;
	startLine: number;
}

interface CachedFailure {
	toolCallId: string;
	failure: StreamedPreflightResult;
	provenance: readonly PreflightFileObservation[];
	sourcePrefix: string;
	cwd: string | undefined;
}

function stringStorageBytes(value: string | undefined): number {
	if (value === undefined) return 0;
	// V8/Bun may store ASCII strings compactly, but UTF-16 is the conservative
	// upper bound for the JS source and metadata retained by this cache.
	return Math.max(Buffer.byteLength(value, "utf8"), value.length * 2);
}

function cachedFailureSize(value: CachedFailure, key: string): number {
	const failure = value.failure;
	let size = 256 + stringStorageBytes(key) + stringStorageBytes(value.toolCallId);
	size += stringStorageBytes(value.sourcePrefix) + stringStorageBytes(value.cwd);
	size +=
		stringStorageBytes(failure.message) + stringStorageBytes(failure.path) + stringStorageBytes(failure.provenance);
	for (const observation of value.provenance) {
		size +=
			128 +
			stringStorageBytes(observation.path) +
			stringStorageBytes(observation.device) +
			stringStorageBytes(observation.inode) +
			stringStorageBytes(observation.mtimeNs) +
			stringStorageBytes(observation.ctimeNs);
	}
	return Math.max(1, size);
}

const streamedFailures = new LRUCache<string, CachedFailure>({
	max: MAX_STREAMED_FAILURES,
	maxSize: MAX_STREAMED_FAILURE_CACHE_BYTES,
	maxEntrySize: MAX_STREAMED_FAILURE_ENTRY_BYTES,
	sizeCalculation: cachedFailureSize,
});
const sessionCacheTokens = new WeakMap<object, string>();
let nextSessionCacheToken = 0;

function sessionCacheIdentity(options: StreamedInputPreflightOptions): string | undefined {
	const key = options.sessionKey ?? options.session;
	if (typeof key === "string") return `string:${key}`;
	if (!key || typeof key !== "object") return undefined;
	let token = sessionCacheTokens.get(key);
	if (!token) {
		token = `object:${++nextSessionCacheToken}`;
		sessionCacheTokens.set(key, token);
	}
	return token;
}

function streamedCacheKey(toolCallId: string, identity: string | undefined): string | undefined {
	return identity === undefined ? undefined : JSON.stringify([identity, toolCallId]);
}

/**
 * Forget an id's cached preflight result.  Callers should use this after a
 * streamed tool call completes or is discarded; the bounded cache is only a
 * fallback for callers that cannot observe completion.
 */
export function resetStreamedAssertionPreflight(toolCallId?: string): void {
	if (toolCallId === undefined) streamedFailures.clear();
	else {
		for (const key of streamedFailures.keys()) {
			if (streamedFailures.peek(key)?.toolCallId === toolCallId) streamedFailures.delete(key);
		}
	}
}

/** Internal cache telemetry used by focused regression tests and diagnostics. */
export function streamedAssertionPreflightCacheStats(): {
	entries: number;
	bytes: number;
	maxBytes: number;
} {
	return {
		entries: streamedFailures.size,
		bytes: streamedFailures.calculatedSize,
		maxBytes: MAX_STREAMED_FAILURE_CACHE_BYTES,
	};
}

/**
 * Inspect a partial bash tool JSON payload.  This function is deliberately
 * fail-open: malformed/incomplete JSON, unknown shell forms, unsafe code,
 * unavailable files, and stale observations all return undefined.
 */
export async function preflightStreamedInput(
	toolCallId: string,
	rawPartialJson: string,
	options: StreamedInputPreflightOptions = {},
): Promise<StreamedPreflightResult | undefined> {
	try {
		if (options.signal?.aborted || typeof rawPartialJson !== "string" || rawPartialJson.length === 0)
			return undefined;
		// The shared decoder owns partial JSON semantics. Cap its input before
		// calling it so an unrelated, already-large argument cannot turn each
		// streamed update into unbounded parser work.
		const boundedRaw = rawPartialJson.slice(0, MAX_PARTIAL_JSON_BYTES);
		const streamedInput = parseStreamedBashInput(boundedRaw);
		if (typeof streamedInput.command !== "string" || streamedInput.command.length === 0) return undefined;
		const cell = detectPartialKernelCell(streamedInput.command);
		if (!cell || cell.code.length === 0) return undefined;

		let cwd = options.cwd ?? options.session?.cwd;
		if (options.cwd === undefined && streamedInput.cwd && streamedInput.cwd.length > 0) {
			cwd = resolveStreamedCwd(streamedInput.cwd, options.session?.cwd);
		}
		const cacheKey = streamedCacheKey(toolCallId, sessionCacheIdentity(options));
		const cached = cacheKey === undefined ? undefined : streamedFailures.get(cacheKey);
		if (cacheKey !== undefined && cached && cached.cwd === cwd && cell.code.startsWith(cached.sourcePrefix)) {
			if (await observationsCurrent(cached.provenance, options.signal)) return { ...cached.failure };
			streamedFailures.delete(cacheKey);
		}

		const failure = await preflightKernelSource(cell.code, {
			...options,
			cwd,
			language: cell.language,
		});
		if (!failure) return undefined;
		const provenance = failure.provenance ?? [];
		const withId: StreamedPreflightResult = {
			...failure,
			toolCallId,
			provenance: failure.path,
			fileObservations: provenance,
		};
		if (cacheKey !== undefined)
			streamedFailures.set(cacheKey, {
				toolCallId,
				failure: withId,
				provenance,
				// A failure is only emitted before the source limit, so retaining this
				// prefix is bounded even if later chunks contain a huge replacement.
				sourcePrefix: cell.code.slice(0, Math.min(cell.code.length, DEFAULT_MAX_SOURCE_BYTES)),
				cwd,
			});
		return withId;
	} catch {
		return undefined;
	}
}

/**
 * Safely evaluate the small, source-local assertion subset.  No Python or JS
 * source is executed; parsing and a literal-only interpreter are used.  The
 * supported Python path is:
 *
 *   from pathlib import Path
 *   p = Path("literal")
 *   text = p.read_text()
 *   old = "literal"
 *   new = "literal"
 *   assert text.count(old) == 1
 *
 * `new` is tracked as a literal but otherwise intentionally unused.  Bare
 * inherited names, prior-cell values, arbitrary calls/imports, control-flow,
 * writes, dynamic paths, and non-regular/oversize files are unknown and do
 * not produce a failure.  The JS subset is the analogous explicit
 * `node:fs`/`readFileSync` + `split(...).length - 1` + `console.assert` form.
 */
export async function preflightKernelSource(
	source: string,
	options: PreflightKernelSourceOptions = {},
): Promise<AssertionPreflightFailure | undefined> {
	try {
		if (options.signal?.aborted || typeof source !== "string" || source.length === 0) return undefined;
		const language = normalizeLanguage(options.language);
		if (!language) return undefined;
		const cwd = options.cwd;
		const limits = {
			maxSourceBytes: clampLimit(options.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES),
			maxFileBytes: clampLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1),
		};
		if (language === "python") return await evaluatePython(source, cwd, limits, options.signal);
		return await evaluateJavaScript(source, cwd, limits, options.signal);
	} catch {
		return undefined;
	}
}

function normalizeLanguage(language: PreflightKernelSourceOptions["language"]): PreflightKernelLanguage | undefined {
	if (language === undefined || language === "python" || language === "py") return "python";
	if (language === "js" || language === "javascript") return "js";
	return undefined;
}

function clampLimit(value: number | undefined, fallback: number, minimum = 1024): number {
	if (!Number.isFinite(value) || value === undefined) return fallback;
	return Math.max(minimum, Math.min(Math.floor(value), fallback));
}

function resolveStreamedCwd(rawCwd: string, sessionCwd: string | undefined): string | undefined {
	if (rawCwd.includes("\0") || rawCwd.includes("://") || rawCwd.startsWith("~")) return undefined;
	if (path.isAbsolute(rawCwd)) return path.normalize(rawCwd);
	if (!sessionCwd || !path.isAbsolute(sessionCwd) || sessionCwd.includes("\0") || sessionCwd.includes("://"))
		return undefined;
	return path.resolve(sessionCwd, rawCwd);
}

function detectPartialKernelCell(command: string): BashKernelCell | undefined {
	const sharedHeredoc = parseStandaloneQuotedHeredoc(command);
	if (sharedHeredoc) return { language: sharedHeredoc.language, code: sharedHeredoc.code };
	const complete = detectBashKernelCell(command);
	if (complete) return complete;
	// detectBashKernelCell intentionally requires a closed shell word for -c/-e.
	// During streaming, an otherwise safe quoted word is commonly incomplete.
	const match = command.match(
		/(?:^|[\n;&|]|&&|\|\|)\s*(python3?|node|bun)\b((?:\s+-[A-Za-z]+)*)\s+(-c|-e)\s+([\s\S]*)$/u,
	);
	if (!match) return undefined;
	const language: PreflightKernelLanguage = match[1] === "node" || match[1] === "bun" ? "js" : "python";
	if ((language === "python" && match[3] !== "-c") || (language === "js" && match[3] !== "-e")) return undefined;
	const parsed = parsePartialShellWord(match[4]!.trimStart());
	if (!parsed || parsed.word.trim().length === 0) return undefined;
	if (parsed.complete && parsed.rest.trim().length > 0) return undefined;
	return { language, code: parsed.word };
}

interface PartialShellWord {
	word: string;
	rest: string;
	complete: boolean;
}

function parsePartialShellWord(input: string): PartialShellWord | undefined {
	const quote = input[0];
	if (quote === "'") {
		const end = input.indexOf("'", 1);
		if (end < 0) return { word: input.slice(1), rest: "", complete: false };
		return { word: input.slice(1, end), rest: input.slice(end + 1), complete: true };
	}
	if (quote === '"') {
		let word = "";
		for (let index = 1; index < input.length; index += 1) {
			const char = input[index]!;
			if (char === "\\") {
				const next = input[index + 1];
				if (next === undefined) return { word: `${word}\\`, rest: "", complete: false };
				word += '"$`\\'.includes(next) ? next : `\\${next}`;
				index += 1;
				continue;
			}
			if (char === '"') return { word, rest: input.slice(index + 1), complete: true };
			word += char;
		}
		return { word, rest: "", complete: false };
	}
	const end = input.search(/\s/u);
	if (end < 0) return { word: input, rest: "", complete: false };
	return { word: input.slice(0, end), rest: input.slice(end), complete: true };
}

function scanPythonStatements(source: string, maxSourceBytes: number): Statement[] {
	const limit = Math.min(source.length, maxSourceBytes);
	const truncated = limit < source.length;
	const statements: Statement[] = [];
	let start = 0;
	let startLine = 1;
	let line = 1;
	let quote: "'" | '"' | undefined;
	let triple = false;
	let comment = false;
	const brackets: string[] = [];
	for (let index = 0; index < limit; index += 1) {
		const char = source[index]!;
		if (comment) {
			if (char === "\n") {
				comment = false;
				if (quote === undefined && brackets.length === 0) {
					pushStatement(statements, source.slice(start, index), startLine);
					start = index + 1;
					startLine = line + 1;
				}
				line += 1;
			}
			continue;
		}
		if (quote !== undefined) {
			if (triple) {
				if (source.startsWith(quote.repeat(3), index)) {
					quote = undefined;
					triple = false;
					index += 2;
					continue;
				}
				if (char === "\n") line += 1;
				if (char === "\\") index += 1;
				continue;
			}
			if (char === "\\") {
				if (source[index + 1] === "\n") return statements;
				index += 1;
				continue;
			}
			if (char === quote) {
				quote = undefined;
				continue;
			}
			if (char === "\n") return statements;
			continue;
		}
		if (char === "#") {
			comment = true;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			triple = source.startsWith(char.repeat(3), index);
			if (triple) index += 2;
			continue;
		}
		if (char === "(" || char === "[" || char === "{") {
			brackets.push(char);
			continue;
		}
		if (char === ")" || char === "]" || char === "}") {
			const expected = char === ")" ? "(" : char === "]" ? "[" : "{";
			if (brackets.at(-1) !== expected) return statements;
			brackets.pop();
			continue;
		}
		if (brackets.length === 0 && (char === "\n" || char === ";")) {
			pushStatement(statements, source.slice(start, index), startLine);
			start = index + 1;
			startLine = char === "\n" ? line + 1 : line;
			if (char === "\n") line += 1;
		}
	}
	if (quote !== undefined || brackets.length > 0 || truncated) return statements;
	pushStatement(statements, source.slice(start, limit), startLine);
	return statements;
}

function scanJavaScriptStatements(source: string, maxSourceBytes: number): Statement[] {
	const limit = Math.min(source.length, maxSourceBytes);
	const truncated = limit < source.length;
	const statements: Statement[] = [];
	let start = 0;
	let startLine = 1;
	let line = 1;
	let quote: "'" | '"' | "`" | undefined;
	let comment: "line" | "block" | undefined;
	const brackets: string[] = [];
	for (let index = 0; index < limit; index += 1) {
		const char = source[index]!;
		const next = source[index + 1];
		if (comment === "line") {
			if (char === "\n") {
				comment = undefined;
				if (brackets.length === 0) {
					pushStatement(statements, source.slice(start, index), startLine);
					start = index + 1;
					startLine = line + 1;
				}
				line += 1;
			}
			continue;
		}
		if (comment === "block") {
			if (char === "*" && next === "/") {
				comment = undefined;
				index += 1;
			} else if (char === "\n") line += 1;
			continue;
		}
		if (quote !== undefined) {
			if (char === "\\") {
				if (next === "\n") line += 1;
				index += 1;
				continue;
			}
			if (char === quote) quote = undefined;
			else if (char === "\n" && quote !== "`") return statements;
			else if (char === "\n") line += 1;
			continue;
		}
		if (char === "/" && next === "/") {
			comment = "line";
			index += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			comment = "block";
			index += 1;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			continue;
		}
		if (char === "(" || char === "[" || char === "{") {
			brackets.push(char);
			continue;
		}
		if (char === ")" || char === "]" || char === "}") {
			const expected = char === ")" ? "(" : char === "]" ? "[" : "{";
			if (brackets.at(-1) !== expected) return statements;
			brackets.pop();
			continue;
		}
		if (brackets.length === 0 && (char === ";" || char === "\n")) {
			pushStatement(statements, source.slice(start, index), startLine);
			start = index + 1;
			startLine = char === "\n" ? line + 1 : line;
			if (char === "\n") line += 1;
		}
	}
	if (quote !== undefined || comment === "block" || brackets.length > 0 || truncated) return statements;
	pushStatement(statements, source.slice(start, limit), startLine);
	return statements;
}

function pushStatement(statements: Statement[], text: string, startLine: number): void {
	if (statements.length >= MAX_STATEMENTS) return;
	if (text.trim().length > 0) statements.push({ text, startLine });
}

function stripPythonComment(statement: string): string {
	let quote: "'" | '"' | undefined;
	let triple = false;
	for (let index = 0; index < statement.length; index += 1) {
		const char = statement[index]!;
		if (quote !== undefined) {
			if (char === "\\") {
				index += 1;
				continue;
			}
			if (triple && statement.startsWith(quote.repeat(3), index)) {
				quote = undefined;
				triple = false;
				index += 2;
			} else if (!triple && char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			triple = statement.startsWith(char.repeat(3), index);
			if (triple) index += 2;
		} else if (char === "#") return statement.slice(0, index);
	}
	return statement;
}

async function evaluatePython(
	source: string,
	cwd: string | undefined,
	limits: { maxSourceBytes: number; maxFileBytes: number },
	signal: AbortSignal | undefined,
): Promise<AssertionPreflightFailure | undefined> {
	const statements = scanPythonStatements(source, limits.maxSourceBytes);
	const values = new Map<string, SafeValue>();
	const observations = new Map<string, InternalObservation>();
	for (const statement of statements) {
		if (signal?.aborted) return undefined;
		const withoutComment = stripPythonComment(statement.text);
		const trimmed = withoutComment.trim();
		if (trimmed.length === 0) continue;
		if (/^\s/u.test(withoutComment)) return undefined;
		if (/^from\s+pathlib\s+import\s+Path(?:\s+as\s+([A-Za-z_]\w*))?$/u.test(trimmed)) {
			const alias = /^from\s+pathlib\s+import\s+Path(?:\s+as\s+([A-Za-z_]\w*))?$/u.exec(trimmed)?.[1] ?? "Path";
			values.set(alias, PATH_CONSTRUCTOR);
			continue;
		}
		const pathlibImport = /^import\s+pathlib(?:\s+as\s+([A-Za-z_]\w*))?$/u.exec(trimmed);
		if (pathlibImport) {
			values.set(pathlibImport[1] ?? "pathlib", PATH_MODULE);
			continue;
		}
		const builtinsImport = /^import\s+builtins(?:\s+as\s+([A-Za-z_]\w*))?$/u.exec(trimmed);
		if (builtinsImport) {
			values.set(builtinsImport[1] ?? "builtins", BUILTINS_MODULE);
			continue;
		}
		const builtinOpenImport = /^from\s+builtins\s+import\s+open(?:\s+as\s+([A-Za-z_]\w*))?$/u.exec(trimmed);
		if (builtinOpenImport) {
			values.set(builtinOpenImport[1] ?? "open", OPEN_FUNCTION);
			continue;
		}
		if (/^(?:import|from)\b/u.test(trimmed)) return undefined;
		if (/^assert\b/u.test(trimmed)) {
			const failure = await evaluatePythonAssert(
				trimmed.slice(6).trim(),
				statement.startLine,
				values,
				observations,
				signal,
			);
			if (failure) return failure;
			if (!isKnownPythonAssert(trimmed.slice(6).trim(), values)) return undefined;
			continue;
		}
		const assignment = /^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/u.exec(trimmed);
		if (!assignment) return undefined;
		const value = await evaluatePythonValue(assignment[2]!, values, cwd, limits, signal);
		if (value === undefined) return undefined;
		if (isReadResult(value)) observations.set(value.observation.public.path, value.observation);
		values.set(assignment[1]!, isReadResult(value) ? value.text : value);
	}
	return undefined;
}

function isReadResult(value: unknown): value is ReadResult {
	return !!value && typeof value === "object" && "text" in value && "observation" in value;
}

function isKnownPythonAssert(expression: string, values: Map<string, SafeValue>): boolean {
	const comparison = splitTopLevelOperator(expression, "==");
	if (!comparison) return false;
	const call = /^([A-Za-z_]\w*)\s*\.\s*count\s*\(([\s\S]*)\)$/u.exec(comparison.left.trim());
	if (!call) return false;
	const receiver = values.get(call[1]!);
	if (typeof receiver !== "string") return false;
	const needle = parsePythonLiteralOrName(call[2]!.trim(), values);
	const expected = parsePythonLiteralOrName(comparison.right.trim(), values);
	return typeof needle === "string" && typeof expected === "number" && Number.isSafeInteger(expected);
}

async function evaluatePythonAssert(
	expression: string,
	line: number,
	values: Map<string, SafeValue>,
	observations: Map<string, InternalObservation>,
	signal: AbortSignal | undefined,
): Promise<AssertionPreflightFailure | undefined> {
	const condition = splitTopLevelComma(expression)?.[0]?.trim() ?? expression.trim();
	const comparison = splitTopLevelOperator(condition, "==");
	if (!comparison) return undefined;
	const call = /^([A-Za-z_]\w*)\s*\.\s*count\s*\(([\s\S]*)\)$/u.exec(comparison.left.trim());
	if (!call) return undefined;
	const haystack = values.get(call[1]!);
	const needle = parsePythonLiteralOrName(call[2]!.trim(), values);
	const expected = parsePythonLiteralOrName(comparison.right.trim(), values);
	if (
		typeof haystack !== "string" ||
		typeof needle !== "string" ||
		typeof expected !== "number" ||
		!Number.isSafeInteger(expected)
	) {
		return undefined;
	}
	const actual = countOccurrences(haystack, needle, signal);
	if (actual === undefined || actual === expected) return undefined;
	const provenance = [...observations.values()].map(value => value.public);
	if (!(await observationsCurrent(provenance, signal))) return undefined;
	return {
		message: `Kernel assertion preflight failed at line ${line}: text.count(old) == ${expected} is false (count=${actual}, expected=${expected}).`,
		language: "python",
		line,
		column: 1,
		count: actual,
		expected,
		path: provenance[0]?.path,
		provenance,
	};
}

async function evaluatePythonValue(
	expression: string,
	values: Map<string, SafeValue>,
	cwd: string | undefined,
	limits: { maxSourceBytes: number; maxFileBytes: number },
	signal: AbortSignal | undefined,
): Promise<SafeValue | ReadResult | undefined> {
	const literal = parsePythonLiteralOrName(expression.trim(), values);
	if (literal !== undefined) return literal;
	const pathValue = parsePythonPathExpression(expression.trim(), values);
	if (pathValue) return pathValue;
	const pathRead = parsePythonReadExpression(expression.trim(), values);
	if (!pathRead) return undefined;
	const result = await readLiteralFile(pathRead.rawPath, cwd, limits.maxFileBytes, signal);
	return result;
}

interface PythonPathRead {
	rawPath: string;
}

function parsePythonPathExpression(expression: string, values: Map<string, SafeValue>): SafeValue | undefined {
	const direct = /^([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/u.exec(expression);
	const qualified = /^([A-Za-z_]\w*)\s*\.\s*Path\s*\(([\s\S]*)\)$/u.exec(expression);
	const name = direct?.[1] ?? qualified?.[1];
	const argumentText = direct?.[2] ?? qualified?.[2];
	if (!name || argumentText === undefined) return undefined;
	const constructorValue = values.get(name);
	if (qualified ? constructorValue !== PATH_MODULE : constructorValue !== PATH_CONSTRUCTOR) return undefined;
	const args = splitTopLevelComma(argumentText);
	if (args?.length !== 1) return undefined;
	const rawPath = parsePythonLiteralOrName(args[0]!.trim(), values);
	if (typeof rawPath !== "string" || rawPath.length > MAX_LITERAL_CHARS || rawPath.includes("\0")) return undefined;
	return { kind: "path", raw: rawPath };
}

function parsePythonReadExpression(expression: string, values: Map<string, SafeValue>): PythonPathRead | undefined {
	const method = /^(.*?)\.\s*read_text\s*\(([\s\S]*)\)$/u.exec(expression);
	if (method) {
		if (!validPythonReadTextArgs(method[2]!)) return undefined;
		const receiver = method[1]!.trim();
		const direct = /^([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/u.exec(receiver);
		const qualified = /^([A-Za-z_]\w*)\s*\.\s*Path\s*\(([\s\S]*)\)$/u.exec(receiver);
		let argumentText: string | undefined;
		if (direct) {
			if (values.get(direct[1]!) !== PATH_CONSTRUCTOR) return undefined;
			argumentText = direct[2];
		} else if (qualified) {
			if (values.get(qualified[1]!) !== PATH_MODULE) return undefined;
			argumentText = qualified[2];
		} else {
			const receiverValue = values.get(receiver);
			if (
				!receiverValue ||
				typeof receiverValue !== "object" ||
				!("kind" in receiverValue) ||
				receiverValue.kind !== "path"
			)
				return undefined;
			return { rawPath: receiverValue.raw };
		}
		const args = splitTopLevelComma(argumentText);
		if (args?.length !== 1) return undefined;
		const rawPath = parsePythonLiteralOrName(args[0]!.trim(), values);
		return typeof rawPath === "string" && rawPath.length <= MAX_LITERAL_CHARS ? { rawPath } : undefined;
	}

	const open = /^(.*?)\.\s*read\s*\(([\s\S]*)\)$/u.exec(expression);
	if (!open) return undefined;
	const receiver = open[1]!.trim();
	const call = /^([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/u.exec(receiver);
	const qualified = /^([A-Za-z_]\w*)\s*\.\s*open\s*\(([\s\S]*)\)$/u.exec(receiver);
	if (!call && !qualified) return undefined;
	if (call && values.get(call[1]!) !== OPEN_FUNCTION) return undefined;
	if (qualified && values.get(qualified[1]!) !== BUILTINS_MODULE) return undefined;
	const argumentText = call?.[2] ?? qualified?.[2];
	if (argumentText === undefined) return undefined;
	const args = splitTopLevelComma(argumentText);
	if (!args || args.length < 1 || args.length > 3) return undefined;
	const rawPath = parsePythonLiteralOrName(args[0]!.trim(), values);
	if (typeof rawPath !== "string" || rawPath.length > MAX_LITERAL_CHARS || rawPath.includes("\0")) return undefined;
	if (args.length >= 2) {
		const mode = parsePythonLiteralOrName(args[1]!.trim(), values);
		if (mode !== "r" && mode !== "rt") return undefined;
	}
	if (args.length === 3) {
		const encoding = /^encoding\s*=\s*([\s\S]+)$/u.exec(args[2]!.trim());
		if (!encoding) return undefined;
		const value = parsePythonString(encoding[1]!.trim());
		if (value !== "utf-8" && value !== "utf8") return undefined;
	}
	return { rawPath };
}

function validPythonReadTextArgs(args: string): boolean {
	if (args.trim().length === 0) return true;
	const pieces = splitTopLevelComma(args);
	if (pieces?.length !== 1) return false;
	const match = /^encoding\s*=\s*([\s\S]+)$/u.exec(pieces[0]!.trim());
	if (!match) return false;
	return parsePythonString(match[1]!.trim()) === "utf-8" || parsePythonString(match[1]!.trim()) === "utf8";
}

function parsePythonLiteralOrName(expression: string, values: Map<string, SafeValue>): SafeValue | undefined {
	const stringValue = parsePythonString(expression);
	if (stringValue !== undefined) return stringValue;
	if (/^(?:True|False)$/u.test(expression)) return expression === "True";
	if (expression === "None") return null;
	if (/^[+-]?\d(?:_?\d)*$/u.test(expression)) {
		const number = Number(expression.replaceAll("_", ""));
		if (Number.isSafeInteger(number)) return number;
	}
	if (/^[A-Za-z_]\w*$/u.test(expression)) return values.get(expression);
	return undefined;
}

function parsePythonString(expression: string): string | undefined {
	const match = /^(?:(r|u|ur|ru|b|br|rb))?('''|"""|'|")([\s\S]*)$/iu.exec(expression);
	if (!match) return undefined;
	const prefix = (match[1] ?? "").toLowerCase();
	if (prefix.includes("b") || prefix.includes("f")) return undefined;
	const delimiter = match[2]!;
	const body = match[3]!;
	if (body.length > MAX_LITERAL_CHARS * 2) return undefined;
	if (!body.endsWith(delimiter)) return undefined;
	const content = body.slice(0, -delimiter.length);
	if (content.length > MAX_LITERAL_CHARS) return undefined;
	if (prefix.includes("r")) return decodeRawPythonString(content, delimiter[0]!);
	return decodePythonEscapes(content);
}

function decodeRawPythonString(content: string, quote: string): string | undefined {
	for (let index = 0; index < content.length; index += 1) {
		if (content[index] === "\\" && content[index + 1] === quote) index += 1;
	}
	if (content.endsWith("\\")) return undefined;
	return content.replaceAll(`\\${quote}`, quote);
}

function decodePythonEscapes(content: string): string | undefined {
	let result = "";
	for (let index = 0; index < content.length; index += 1) {
		const char = content[index]!;
		if (char !== "\\") {
			result += char;
			continue;
		}
		const next = content[index + 1];
		if (next === undefined) return undefined;
		index += 1;
		switch (next) {
			case "\\":
			case "'":
			case '"':
				result += next;
				break;
			case "a":
				result += "\x07";
				break;
			case "b":
				result += "\b";
				break;
			case "f":
				result += "\f";
				break;
			case "n":
				result += "\n";
				break;
			case "r":
				result += "\r";
				break;
			case "t":
				result += "\t";
				break;
			case "v":
				result += "\v";
				break;
			case "\n":
				break;
			case "x": {
				const hex = content.slice(index + 1, index + 3);
				if (!/^[0-9A-Fa-f]{2}$/u.test(hex)) return undefined;
				result += String.fromCharCode(Number.parseInt(hex, 16));
				index += 2;
				break;
			}
			case "u":
			case "U": {
				const width = next === "u" ? 4 : 8;
				const hex = content.slice(index + 1, index + 1 + width);
				if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`, "u").test(hex)) return undefined;
				const codePoint = Number.parseInt(hex, 16);
				if (codePoint > 0x10ffff) return undefined;
				result += String.fromCodePoint(codePoint);
				index += width;
				break;
			}
			default:
				if (/[0-7]/u.test(next)) {
					const octal = (next + content.slice(index + 1, index + 3)).match(/^[0-7]{1,3}/u)?.[0];
					if (!octal) return undefined;
					result += String.fromCharCode(Number.parseInt(octal, 8));
					index += octal.length - 1;
				} else {
					// Python preserves unknown escapes (with a warning). Preserving
					// them here is safer than silently changing the needle.
					result += `\\${next}`;
				}
		}
	}
	return result;
}

function splitTopLevelComma(input: string): string[] | undefined {
	const pieces: string[] = [];
	let start = 0;
	let quote: "'" | '"' | undefined;
	let triple = false;
	const brackets: string[] = [];
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index]!;
		if (quote !== undefined) {
			if (char === "\\") {
				index += 1;
				continue;
			}
			if (triple && input.startsWith(quote.repeat(3), index)) {
				quote = undefined;
				triple = false;
				index += 2;
			} else if (!triple && char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			triple = input.startsWith(char.repeat(3), index);
			if (triple) index += 2;
		} else if (char === "(" || char === "[" || char === "{") brackets.push(char);
		else if (char === ")" || char === "]" || char === "}") {
			const expected = char === ")" ? "(" : char === "]" ? "[" : "{";
			if (brackets.at(-1) !== expected) return undefined;
			brackets.pop();
		} else if (char === "," && brackets.length === 0) {
			pieces.push(input.slice(start, index));
			start = index + 1;
		}
	}
	if (quote !== undefined || brackets.length > 0) return undefined;
	pieces.push(input.slice(start));
	return pieces;
}

function splitTopLevelOperator(input: string, operator: string): { left: string; right: string } | undefined {
	let quote: "'" | '"' | undefined;
	let triple = false;
	const brackets: string[] = [];
	for (let index = 0; index <= input.length - operator.length; index += 1) {
		const char = input[index]!;
		if (quote !== undefined) {
			if (char === "\\") {
				index += 1;
				continue;
			}
			if (triple && input.startsWith(quote.repeat(3), index)) {
				quote = undefined;
				triple = false;
				index += 2;
			} else if (!triple && char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			triple = input.startsWith(char.repeat(3), index);
			if (triple) index += 2;
			continue;
		}
		if (char === "(" || char === "[" || char === "{") brackets.push(char);
		else if (char === ")" || char === "]" || char === "}") {
			const expected = char === ")" ? "(" : char === "]" ? "[" : "{";
			if (brackets.at(-1) !== expected) return undefined;
			brackets.pop();
		} else if (brackets.length === 0 && input.startsWith(operator, index)) {
			return { left: input.slice(0, index), right: input.slice(index + operator.length) };
		}
	}
	return undefined;
}

function countOccurrences(haystack: string, needle: string, signal: AbortSignal | undefined): number | undefined {
	if (needle.length === 0) return haystack.length + 1;
	let count = 0;
	let position = 0;
	let work = 0;
	while (position <= haystack.length - needle.length) {
		if (signal?.aborted) return undefined;
		if (work++ > MAX_COUNT_WORK) return undefined;
		const found = haystack.indexOf(needle, position);
		if (found < 0) break;
		count += 1;
		position = found + needle.length;
	}
	return count;
}

async function readLiteralFile(
	rawPath: string,
	cwd: string | undefined,
	maxFileBytes: number,
	signal: AbortSignal | undefined,
): Promise<ReadResult | undefined> {
	if (signal?.aborted || rawPath.length === 0 || rawPath.length > MAX_LITERAL_CHARS || rawPath.includes("\0"))
		return undefined;
	const absolute = resolveLiteralPath(rawPath, cwd);
	if (!absolute) return undefined;
	const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
	const nonBlock = (constants as typeof constants & { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
	let handle: fs.FileHandle | undefined;
	try {
		const pathStat = await fs.lstat(absolute, { bigint: true });
		if (!pathStat.isFile() || Number(pathStat.size) > maxFileBytes) return undefined;
		handle = await fs.open(absolute, constants.O_RDONLY | noFollow | nonBlock);
		const initial = await handle.stat({ bigint: true });
		if (!initial.isFile() || !sameStamp(statsStamp(pathStat), statsStamp(initial))) return undefined;
		const chunks: Uint8Array[] = [];
		let total = 0;
		let position = 0;
		while (true) {
			if (signal?.aborted) return undefined;
			const chunk = new Uint8Array(Math.min(64 * 1024, maxFileBytes - total + 1));
			if (chunk.length <= 0) return undefined;
			const read = await handle.read(chunk, 0, chunk.length, position);
			if (read.bytesRead === 0) break;
			const piece = chunk.subarray(0, read.bytesRead);
			chunks.push(piece);
			total += read.bytesRead;
			position += read.bytesRead;
			if (total > maxFileBytes) return undefined;
		}
		const final = await handle.stat({ bigint: true });
		const finalPath = await fs.lstat(absolute, { bigint: true });
		if (
			!final.isFile() ||
			!finalPath.isFile() ||
			!sameStamp(statsStamp(initial), statsStamp(final)) ||
			!sameStamp(statsStamp(pathStat), statsStamp(finalPath))
		)
			return undefined;
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		if (bytes.includes(0)) return undefined;
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			return undefined;
		}
		const stamp = statsStamp(final);
		return {
			text,
			observation: {
				stamp,
				public: { path: absolute, ...stamp },
			},
		};
	} catch {
		return undefined;
	} finally {
		try {
			await handle?.close();
		} catch {}
	}
}

function resolveLiteralPath(rawPath: string, cwd: string | undefined): string | undefined {
	if (rawPath.includes("://") || rawPath.startsWith("~")) return undefined;
	if (path.isAbsolute(rawPath)) return path.normalize(rawPath);
	// Never fall back to the evaluator process cwd: callers must provide the
	// kernel's explicit absolute cwd before a relative literal is read.
	if (!cwd || !path.isAbsolute(cwd) || cwd.includes("\0") || cwd.includes("://")) return undefined;
	return path.resolve(cwd, rawPath);
}

function statsStamp(stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): FileStamp {
	return {
		device: stat.dev.toString(),
		inode: stat.ino.toString(),
		size: Number(stat.size),
		mtimeNs: stat.mtimeNs.toString(),
		ctimeNs: stat.ctimeNs.toString(),
	};
}

function sameStamp(left: FileStamp, right: FileStamp): boolean {
	return (
		left.device === right.device &&
		left.inode === right.inode &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

async function observationsCurrent(
	observations: readonly PreflightFileObservation[],
	signal: AbortSignal | undefined,
): Promise<boolean> {
	for (const observation of observations) {
		if (signal?.aborted) return false;
		try {
			const stat = await fs.lstat(observation.path, { bigint: true });
			if (!stat.isFile() || !sameStamp(observation, statsStamp(stat))) return false;
		} catch {
			return false;
		}
	}
	return true;
}

function parseJsStatement(statement: string): Record<string, unknown> | undefined {
	try {
		const file = parseJavaScript(statement, { sourceType: "unambiguous", errorRecovery: false });
		const body = file.program.body as unknown[];
		if (body.length !== 1 || !body[0] || typeof body[0] !== "object") return undefined;
		return body[0] as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

async function evaluateJavaScript(
	source: string,
	cwd: string | undefined,
	limits: { maxSourceBytes: number; maxFileBytes: number },
	signal: AbortSignal | undefined,
): Promise<AssertionPreflightFailure | undefined> {
	const statements = scanJavaScriptStatements(source, limits.maxSourceBytes);
	const values = new Map<string, SafeValue>();
	const observations = new Map<string, InternalObservation>();
	for (const statement of statements) {
		if (signal?.aborted) return undefined;
		const node = parseJsStatement(statement.text);
		if (!node) return undefined;
		const type = node.type;
		if (type === "EmptyStatement") continue;
		if (type === "ImportDeclaration") {
			if (!applySafeJsImport(node, values)) return undefined;
			continue;
		}
		if (type === "VariableDeclaration") {
			const declarations = Array.isArray(node.declarations) ? node.declarations : [];
			if (declarations.length !== 1) return undefined;
			const declaration = declarations[0] as Record<string, unknown>;
			const value = await evaluateJsValue(declaration.init, values, cwd, limits, signal);
			if (value === undefined) return undefined;
			if (!applyJsBinding(declaration.id, value, values)) return undefined;
			if (isReadResult(value)) observations.set(value.observation.public.path, value.observation);
			continue;
		}
		if (type === "ExpressionStatement") {
			const failure = await evaluateJsAssertion(node.expression, statement.startLine, values, observations, signal);
			if (failure) return failure;
			if (!isKnownJsAssertion(node.expression, values)) return undefined;
			continue;
		}
		return undefined;
	}
	return undefined;
}

function applySafeJsImport(node: Record<string, unknown>, values: Map<string, SafeValue>): boolean {
	const source = node.source;
	if (!source || typeof source !== "object" || (source as Record<string, unknown>).type !== "StringLiteral")
		return false;
	const moduleName = (source as Record<string, unknown>).value;
	if (
		moduleName !== "node:fs" &&
		moduleName !== "fs" &&
		moduleName !== "node:assert/strict" &&
		moduleName !== "assert"
	)
		return false;
	const specifiers = Array.isArray(node.specifiers) ? node.specifiers : [];
	for (const item of specifiers) {
		if (!item || typeof item !== "object") return false;
		const specifier = item as Record<string, unknown>;
		const local = specifier.local;
		if (!local || typeof local !== "object" || typeof (local as Record<string, unknown>).name !== "string")
			return false;
		const localName = (local as Record<string, unknown>).name as string;
		if (moduleName === "node:assert/strict" || moduleName === "assert") values.set(localName, ASSERT_FUNCTION);
		else if (specifier.type === "ImportNamespaceSpecifier" || specifier.type === "ImportDefaultSpecifier")
			values.set(localName, FS_MODULE);
		else if (specifier.type === "ImportSpecifier") {
			const imported = specifier.imported;
			if (!imported || typeof imported !== "object" || (imported as Record<string, unknown>).name !== "readFileSync")
				return false;
			values.set(localName, READ_FILE_SYNC);
		} else return false;
	}
	return true;
}

function applyJsBinding(id: unknown, value: SafeValue | ReadResult, values: Map<string, SafeValue>): boolean {
	if (!id || typeof id !== "object") return false;
	const binding = id as Record<string, unknown>;
	if (binding.type === "Identifier" && typeof binding.name === "string") {
		values.set(binding.name, isReadResult(value) ? value.text : value);
		return true;
	}
	if (binding.type !== "ObjectPattern" || !valueEquals(value, FS_MODULE)) return false;
	const properties = Array.isArray(binding.properties) ? binding.properties : [];
	if (properties.length !== 1) return false;
	const property = properties[0];
	if (!property || typeof property !== "object") return false;
	const record = property as Record<string, unknown>;
	const key = record.key;
	const target = record.value;
	if (!key || typeof key !== "object" || (key as Record<string, unknown>).name !== "readFileSync") return false;
	if (!target || typeof target !== "object" || typeof (target as Record<string, unknown>).name !== "string")
		return false;
	values.set((target as Record<string, unknown>).name as string, READ_FILE_SYNC);
	return true;
}

async function evaluateJsValue(
	node: unknown,
	values: Map<string, SafeValue>,
	cwd: string | undefined,
	limits: { maxSourceBytes: number; maxFileBytes: number },
	signal: AbortSignal | undefined,
): Promise<SafeValue | ReadResult | undefined> {
	if (!node || typeof node !== "object") return undefined;
	const expression = node as Record<string, unknown>;
	switch (expression.type) {
		case "StringLiteral":
			return typeof expression.value === "string" && expression.value.length <= MAX_LITERAL_CHARS
				? expression.value
				: undefined;
		case "NumericLiteral":
			return typeof expression.value === "number" && Number.isSafeInteger(expression.value)
				? expression.value
				: undefined;
		case "BooleanLiteral":
			return expression.value === true || expression.value === false ? expression.value : undefined;
		case "NullLiteral":
			return null;
		case "Identifier":
			return typeof expression.name === "string" ? values.get(expression.name) : undefined;
		case "CallExpression": {
			const callee = expression.callee;
			const args = Array.isArray(expression.arguments) ? expression.arguments : [];
			if (isIdentifier(callee, "require") && args.length === 1) {
				const name = literalJsString(args[0]);
				if (name === "node:fs" || name === "fs") return FS_MODULE;
				if (name === "node:assert/strict" || name === "assert") return ASSERT_FUNCTION;
			}
			const readCall = jsReadFileCall(callee, args, values);
			if (!readCall) return undefined;
			return await readLiteralFile(readCall.rawPath, cwd, limits.maxFileBytes, signal);
		}
		default:
			return undefined;
	}
}

function jsReadFileCall(
	callee: unknown,
	args: unknown[],
	values: Map<string, SafeValue>,
): { rawPath: string } | undefined {
	let isRead = false;
	if (isIdentifier(callee, undefined) && values.get(callee.name as string) === READ_FILE_SYNC) isRead = true;
	if (callee && typeof callee === "object") {
		const member = callee as Record<string, unknown>;
		if (
			member.type === "MemberExpression" &&
			member.computed !== true &&
			isIdentifier(member.object, undefined) &&
			isIdentifier(member.property, "readFileSync")
		) {
			const objectName = (member.object as Record<string, unknown>).name;
			isRead = values.get(objectName as string) === FS_MODULE;
		}
	}
	if (!isRead || args.length < 1 || args.length > 2) return undefined;
	const rawPath = literalJsString(args[0]);
	if (rawPath === undefined) return undefined;
	if (args.length === 2 && literalJsString(args[1]) !== "utf8" && literalJsString(args[1]) !== "utf-8")
		return undefined;
	return { rawPath };
}

function evaluateJsCountExpression(
	node: unknown,
	values: Map<string, SafeValue>,
): { haystack: string; needle: string; adjustment: number } | undefined {
	if (!node || typeof node !== "object") return undefined;
	const expression = node as Record<string, unknown>;
	if (
		expression.type === "MemberExpression" &&
		expression.computed !== true &&
		isIdentifier(expression.property, "length")
	) {
		const call = expression.object;
		if (!call || typeof call !== "object") return undefined;
		const callNode = call as Record<string, unknown>;
		if (callNode.type !== "CallExpression" || !Array.isArray(callNode.arguments) || callNode.arguments.length !== 1)
			return undefined;
		const callee = callNode.callee;
		if (!callee || typeof callee !== "object") return undefined;
		const member = callee as Record<string, unknown>;
		if (member.type !== "MemberExpression" || member.computed === true || !isIdentifier(member.property, "split"))
			return undefined;
		const receiver = member.object;
		if (!receiver || typeof receiver !== "object" || (receiver as Record<string, unknown>).type !== "Identifier")
			return undefined;
		const haystack = values.get((receiver as Record<string, unknown>).name as string);
		const needle = literalJsStringOrName(callNode.arguments[0], values);
		if (typeof haystack !== "string" || needle === undefined) return undefined;
		return { haystack, needle, adjustment: 0 };
	}
	if (expression.type !== "BinaryExpression" || (expression.operator !== "-" && expression.operator !== "+"))
		return undefined;
	const right = expression.right;
	if (
		!right ||
		typeof right !== "object" ||
		(right as Record<string, unknown>).type !== "NumericLiteral" ||
		(right as Record<string, unknown>).value !== 1
	)
		return undefined;
	const nested = evaluateJsCountExpression(expression.left, values);
	if (!nested) return undefined;
	return { ...nested, adjustment: nested.adjustment + (expression.operator === "-" ? -1 : 1) };
}

function isKnownJsAssertion(node: unknown, values: Map<string, SafeValue>): boolean {
	const condition = jsAssertionCondition(node, values);
	if (!condition) return false;
	const count = evaluateJsCountExpression(condition.left, values);
	return !!count && typeof literalJsNumber(condition.right) === "number";
}

async function evaluateJsAssertion(
	node: unknown,
	line: number,
	values: Map<string, SafeValue>,
	observations: Map<string, InternalObservation>,
	signal: AbortSignal | undefined,
): Promise<AssertionPreflightFailure | undefined> {
	const condition = jsAssertionCondition(node, values);
	if (!condition) return undefined;
	const count = evaluateJsCountExpression(condition.left, values);
	const expected = literalJsNumber(condition.right);
	if (!count || expected === undefined || !Number.isSafeInteger(expected)) return undefined;
	const actualBase = countOccurrences(count.haystack, count.needle, signal);
	if (actualBase === undefined) return undefined;
	// `split(needle).length` is one greater than the non-overlapping count.
	const actual = actualBase + 1 + count.adjustment;
	if (actual === expected) return undefined;
	const provenance = [...observations.values()].map(value => value.public);
	if (!(await observationsCurrent(provenance, signal))) return undefined;
	return {
		message: `Kernel assertion preflight failed at line ${line}: streamed count expression is false (count=${actual}, expected=${expected}).`,
		language: "js",
		line,
		column: 1,
		count: actual,
		expected,
		path: provenance[0]?.path,
		provenance,
	};
}

function jsAssertionCondition(
	node: unknown,
	values: Map<string, SafeValue>,
): { left: unknown; right: unknown } | undefined {
	if (!node || typeof node !== "object") return undefined;
	const expression = node as Record<string, unknown>;
	if (expression.type !== "CallExpression" || !Array.isArray(expression.arguments) || expression.arguments.length < 1)
		return undefined;
	const callee = expression.callee;
	let trusted = false;
	if (callee && typeof callee === "object") {
		const member = callee as Record<string, unknown>;
		if (
			member.type === "MemberExpression" &&
			member.computed !== true &&
			isIdentifier(member.object, "console") &&
			isIdentifier(member.property, "assert")
		)
			trusted = true;
		if (isIdentifier(callee, undefined) && values.get(callee.name as string) === ASSERT_FUNCTION) trusted = true;
	}
	if (!trusted) return undefined;
	const condition = expression.arguments[0];
	if (!condition || typeof condition !== "object") return undefined;
	const comparison = condition as Record<string, unknown>;
	if (comparison.type !== "BinaryExpression" || (comparison.operator !== "===" && comparison.operator !== "=="))
		return undefined;
	return { left: comparison.left, right: comparison.right };
}

function isIdentifier(node: unknown, name: string | undefined): node is Record<string, unknown> {
	if (!node || typeof node !== "object") return false;
	const record = node as Record<string, unknown>;
	return record.type === "Identifier" && (name === undefined || record.name === name);
}

function literalJsString(node: unknown): string | undefined {
	if (!node || typeof node !== "object") return undefined;
	const record = node as Record<string, unknown>;
	return record.type === "StringLiteral" &&
		typeof record.value === "string" &&
		record.value.length <= MAX_LITERAL_CHARS
		? record.value
		: undefined;
}

function literalJsStringOrName(node: unknown, values: Map<string, SafeValue>): string | undefined {
	const literal = literalJsString(node);
	if (literal !== undefined) return literal;
	if (isIdentifier(node, undefined)) {
		const value = values.get((node as Record<string, unknown>).name as string);
		return typeof value === "string" ? value : undefined;
	}
	return undefined;
}

function literalJsNumber(node: unknown): number | undefined {
	if (!node || typeof node !== "object") return undefined;
	const record = node as Record<string, unknown>;
	return record.type === "NumericLiteral" && typeof record.value === "number" && Number.isSafeInteger(record.value)
		? record.value
		: undefined;
}

function valueEquals(left: unknown, right: unknown): boolean {
	return left === right;
}

export const preflightStreamedBashInput = preflightStreamedInput;
