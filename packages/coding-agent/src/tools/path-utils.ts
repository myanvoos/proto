import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { glob } from "@oh-my-pi/pi-natives";
import { hasFsCode, isEnoent, isEnotdir } from "@oh-my-pi/pi-utils";
import { detectLanguageId } from "../utils/lang-from-path";
import { ToolAbortError, ToolError } from "./tool-errors";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

const RANGE_CHUNK_SRC = String.raw`L?\d+(?:(?:[-+]|\.\.)L?\d+|-|\.\.)?`;
const RANGE_LIST_SRC = `${RANGE_CHUNK_SRC}(?:,${RANGE_CHUNK_SRC})*`;
const FILE_LINE_RANGE_RE = new RegExp(`^(?:${RANGE_LIST_SRC}|raw|conflicts)$`, "i");
const FILE_LINE_RANGE_ONLY_RE = new RegExp(`^${RANGE_LIST_SRC}$`, "i");
const FILE_RAW_ONLY_RE = /^raw$/i;

const INTERNAL_URL_SELECTOR_PART_RE = new RegExp(
	String.raw`^(?:raw|conflicts|${RANGE_LIST_SRC}|-\d+(?:[-+]\d+)?)$`,
	"i",
);

const INTERNAL_SCHEMES_WITH_SELECTORS: Record<string, true> = {
	agent: true,
	artifact: true,
	issue: true,
	history: true,
	local: true,
	memory: true,
	proto: true,
	pr: true,
	rule: true,
	security: true,
	skill: true,
	ssh: true,
	vault: true,
};

const OPAQUE_RESOURCE_SCHEMES: ReadonlySet<string> = new Set(["mcp"]);
const INTERNAL_URL_SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
const NARROW_NO_BREAK_SPACE = "\u202F";
const TOP_LEVEL_INTERNAL_URL_PREFIXES = [
	"agent://",
	"artifact://",
	"skill://",
	"rule://",
	"local://",
	"fleet://",
	"mcp://",
	"ssh://",
	"vault://",
] as const;

function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	return filePath.replace(/'/g, "\u2019");
}

function tryShellEscapedPath(filePath: string): string {
	if (!filePath.includes("\\") || !filePath.includes("/")) return filePath;
	return filePath.replace(/\\([ \t"'(){}[\]])/g, "$1");
}

function fileExists(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function normalizeAtPrefix(filePath: string): string {
	if (!filePath.startsWith("@")) return filePath;

	const withoutAt = filePath.slice(1);

	if (
		withoutAt.startsWith("/") ||
		withoutAt === "~" ||
		withoutAt.startsWith("~/") ||
		withoutAt.startsWith("agent://") ||
		withoutAt.startsWith("artifact://") ||
		withoutAt.startsWith("skill://") ||
		withoutAt.startsWith("rule://") ||
		withoutAt.startsWith("local:") ||
		withoutAt.startsWith("mcp://")
	) {
		return withoutAt;
	}

	return filePath;
}

function stripFileUrl(filePath: string): string {
	if (!filePath.toLowerCase().startsWith("file://")) return filePath;

	try {
		return url.fileURLToPath(filePath);
	} catch {
		return filePath;
	}
}

export function expandTilde(filePath: string, home?: string): string {
	const h = home ?? os.homedir();
	if (filePath === "~") return h;
	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
		return h + filePath.slice(1);
	}
	if (filePath.startsWith("~")) {
		return path.join(h, filePath.slice(1));
	}
	return filePath;
}

export function expandPath(filePath: string): string {
	const deColoned = /^:(?=[/\\~]|\.\.?[/\\]|[A-Za-z]:)/.test(filePath) ? filePath.slice(1) : filePath;
	const normalized = stripFileUrl(normalizeUnicodeSpaces(normalizeAtPrefix(deColoned)));
	return expandTilde(normalized);
}

export interface LineRange {
	startLine: number;
	endLine: number | undefined;
}

const LINE_RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;

export function parseLineRangeChunk(sel: string): LineRange | null {
	const lineMatch = LINE_RANGE_CHUNK_RE.exec(sel);
	if (!lineMatch) return null;
	const rawStart = Number.parseInt(lineMatch[1]!, 10);
	if (rawStart < 1) {
		throw new ToolError("Line selector 0 is invalid; lines are 1-indexed. Use :1.");
	}

	const sep = lineMatch[2] === ".." ? "-" : lineMatch[2];
	const rhs = lineMatch[3] ? Number.parseInt(lineMatch[3], 10) : undefined;
	let rawEnd: number | undefined;
	if (sep === "+") {
		if (rhs === undefined || rhs < 1) {
			throw new ToolError(`Invalid range ${rawStart}+${rhs ?? 0}: count must be >= 1.`);
		}
		rawEnd = rawStart + rhs - 1;
	} else if (sep === "-") {
		if (rhs !== undefined) {
			if (rhs < rawStart) {
				throw new ToolError(`Invalid range ${rawStart}-${rhs}: end must be >= start.`);
			}
			rawEnd = rhs;
		}
	}
	return { startLine: rawStart, endLine: rawEnd };
}

export function parseLineRanges(sel: string): [LineRange, ...LineRange[]] | null {
	const chunks = sel.split(",");
	const parsed: LineRange[] = [];
	for (const chunk of chunks) {
		const range = parseLineRangeChunk(chunk);
		if (!range) return null;
		parsed.push(range);
	}
	if (parsed.length === 0) return null;
	parsed.sort((a, b) => a.startLine - b.startLine);

	const merged: LineRange[] = [parsed[0]];
	for (let i = 1; i < parsed.length; i++) {
		const current = parsed[i];
		const last = merged[merged.length - 1];

		if (last.endLine === undefined) continue;

		if (current.startLine <= last.endLine + 1) {
			if (current.endLine === undefined || current.endLine > last.endLine) {
				merged[merged.length - 1] = { startLine: last.startLine, endLine: current.endLine };
			}
			continue;
		}
		merged.push(current);
	}
	return merged as [LineRange, ...LineRange[]];
}

export function selectorLineRanges(sel: string | undefined): [LineRange, ...LineRange[]] | undefined {
	if (!sel) return undefined;
	for (const chunk of sel.split(":")) {
		const lower = chunk.toLowerCase();
		if (lower === "raw" || lower === "conflicts") continue;
		const ranges = parseLineRanges(chunk);
		if (ranges) return ranges;
	}
	return undefined;
}

export function splitPathAndSel(rawPath: string): { path: string; sel?: string } {
	const colon = rawPath.lastIndexOf(":");
	if (colon <= 0) return { path: rawPath };

	const candidate = rawPath.slice(colon + 1);
	if (!FILE_LINE_RANGE_RE.test(candidate)) return { path: rawPath };

	let basePath = rawPath.slice(0, colon);
	let sel = candidate;

	const innerColon = basePath.lastIndexOf(":");
	if (innerColon > 0) {
		const innerCandidate = basePath.slice(innerColon + 1);
		const innerIsRaw = FILE_RAW_ONLY_RE.test(innerCandidate);
		const outerIsRaw = FILE_RAW_ONLY_RE.test(candidate);
		const innerIsRange = FILE_LINE_RANGE_ONLY_RE.test(innerCandidate);
		const outerIsRange = FILE_LINE_RANGE_ONLY_RE.test(candidate);
		if ((innerIsRaw && outerIsRange) || (innerIsRange && outerIsRaw)) {
			sel = `${innerCandidate}:${candidate}`;
			basePath = basePath.slice(0, innerColon);
		}
	}

	return { path: basePath, sel };
}

export async function probeLiteralPathExists(filePath: string, cwd: string): Promise<"exists" | "missing" | "unknown"> {
	const resolved = resolveReadPath(filePath, cwd);
	try {
		await fs.promises.lstat(resolved);
		return "exists";
	} catch (err) {
		if (isEnoent(err) || isEnotdir(err) || hasFsCode(err, "ENAMETOOLONG")) return "missing";
		return "unknown";
	}
}

export async function splitPathAndSelPreferringLiteral(
	rawPath: string,
	cwd: string,
): Promise<{ path: string; sel?: string }> {
	const strict = splitPathAndSel(rawPath);
	if (strict.sel === undefined) return strict;
	const probe = await probeLiteralPathExists(rawPath, cwd);
	return probe === "missing" ? strict : { path: rawPath };
}

export function splitInternalUrlSel(rawPath: string): { path: string; sel?: string } {
	const schemeMatch = rawPath.match(INTERNAL_URL_SCHEME_RE);
	if (!schemeMatch) return { path: rawPath };
	const scheme = schemeMatch[1].toLowerCase();

	if (OPAQUE_RESOURCE_SCHEMES.has(scheme)) return { path: rawPath };
	if (!INTERNAL_SCHEMES_WITH_SELECTORS[scheme]) return { path: rawPath };

	const schemeEnd = schemeMatch[0].length;

	if (scheme === "ssh" && rawPath.indexOf("/", schemeEnd) === -1) {
		return { path: rawPath };
	}
	let path = rawPath;
	const chunks: string[] = [];
	while (true) {
		const colon = path.lastIndexOf(":");

		if (colon < schemeEnd) break;
		const tail = path.slice(colon + 1);
		if (!INTERNAL_URL_SELECTOR_PART_RE.test(tail)) break;
		chunks.unshift(tail);
		path = path.slice(0, colon);
	}
	if (chunks.length === 0) return { path: rawPath };
	return { path, sel: chunks.join(":") };
}

function assertNotInternalUrl(expanded: string, original: string): void {
	for (const prefix of TOP_LEVEL_INTERNAL_URL_PREFIXES) {
		if (expanded.startsWith(prefix)) {
			throw new Error(
				`Path "${original}" uses internal scheme "${prefix}" and must be resolved through the proper protocol handler, not as a filesystem path.`,
			);
		}
	}
}

export function normalizeLocalScheme(filePath: string): string {
	return filePath.replace(/^(local:)\/(?!\/)/, "$1//");
}

export function isInternalUrlPath(filePath: string): boolean {
	const normalized = normalizeLocalScheme(filePath);
	const expandedAndNormalized = normalizeLocalScheme(expandPath(normalized));
	for (const prefix of TOP_LEVEL_INTERNAL_URL_PREFIXES) {
		if (expandedAndNormalized.startsWith(prefix)) return true;
	}
	return false;
}

export function isReadableUrlPath(value: string): boolean {
	return /^https?:\/\/?/i.test(value) || /^www\./i.test(value);
}

export function shouldExpandRangeContext(sourcePath?: string): boolean {
	return sourcePath === undefined || detectLanguageId(sourcePath) !== "plaintext";
}

export function resolveToCwd(filePath: string, cwd: string): string {
	const normalized = normalizeLocalScheme(filePath);
	const expanded = expandPath(normalized);
	const expandedAndNormalized = normalizeLocalScheme(expanded);

	assertNotInternalUrl(expandedAndNormalized, normalized);

	if (/^\/+$/.test(expanded)) {
		return cwd;
	}
	if (path.isAbsolute(expanded)) {
		return expanded;
	}
	return path.resolve(cwd, expanded);
}

export function confineToWorkspace(filePath: string, cwd: string): string | null {
	if (!filePath || path.isAbsolute(filePath)) return null;

	if (filePath.startsWith("~") || isInternalUrlPath(filePath)) return null;
	const root = path.resolve(cwd);
	const resolved = path.resolve(root, filePath);
	if (!isUnderRootLexical(resolved, root)) return null;

	const realRoot = tryRealpath(root);
	if (!realRoot) return null;

	const realTarget = tryRealpath(resolved);
	if (realTarget) return isUnderRootLexical(realTarget, realRoot) ? resolved : null;

	if (isSymlink(resolved)) return null;

	let ancestor = path.dirname(resolved);
	const tail: string[] = [path.basename(resolved)];
	for (;;) {
		const real = tryRealpath(ancestor);
		if (real) {
			return isUnderRootLexical(path.join(real, ...tail.reverse()), realRoot) ? resolved : null;
		}
		const parent = path.dirname(ancestor);

		if (parent === ancestor || !isUnderRootLexical(ancestor, root)) return null;
		tail.push(path.basename(ancestor));
		ancestor = parent;
	}
}

function isUnderRootLexical(target: string, root: string): boolean {
	const relative = path.relative(root, target);
	return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function tryRealpath(target: string): string | null {
	try {
		return fs.realpathSync.native(target);
	} catch {
		return null;
	}
}

function isSymlink(target: string): boolean {
	try {
		return fs.lstatSync(target).isSymbolicLink();
	} catch {
		return false;
	}
}

function normalizePosixPath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

export function formatPathRelativeToCwd(
	filePath: string,
	cwd: string,
	options: { trailingSlash?: boolean } = {},
): string {
	const resolvedCwd = path.resolve(cwd);
	const normalized = normalizeLocalScheme(filePath);
	if (isInternalUrlPath(normalized)) {
		return normalized;
	}
	const expanded = expandPath(normalized);
	const resolvedPath = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
	const relative = path.relative(resolvedCwd, resolvedPath);
	const isWithinCwd = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
	let displayPath = normalizePosixPath(isWithinCwd ? relative || "." : resolvedPath);
	if (options.trailingSlash && displayPath !== "." && !displayPath.endsWith("/")) {
		displayPath += "/";
	}
	return displayPath;
}

export function stripOuterDoubleQuotes(input: string): string {
	return input.startsWith('"') && input.endsWith('"') && input.length > 1 ? input.slice(1, -1) : input;
}
function normalizePathSeparators(input: string): string {
	if (isInternalUrlPath(input)) return input;
	if (!input.includes("\\")) return input;
	return input.replace(/\\/g, "/");
}

export function normalizePathLikeInput(input: string): string {
	return stripOuterDoubleQuotes(input.trim());
}

const GLOB_PATH_CHARS = ["*", "?", "[", "{"] as const;

function hasGlobPathChars(filePath: string): boolean {
	return GLOB_PATH_CHARS.some(char => filePath.includes(char));
}

type PathEntrySplitter = (item: string) => { basePath: string };

const TOP_LEVEL_WHITESPACE_RE = /\s/;

type DelimitedPathSplitMode = "comma" | "semicolon" | "whitespace" | "mixed";

function isDelimitedPathSeparator(ch: string, mode: DelimitedPathSplitMode): boolean {
	if (mode === "comma") return ch === ",";
	if (mode === "semicolon") return ch === ";";
	if (mode === "whitespace") return TOP_LEVEL_WHITESPACE_RE.test(ch);
	return ch === "," || ch === ";" || TOP_LEVEL_WHITESPACE_RE.test(ch);
}

function hasTopLevelPathDelimiter(entry: string): boolean {
	let braceDepth = 0;
	for (let i = 0; i < entry.length; i++) {
		const ch = entry[i];
		if (ch === "\\" && i + 1 < entry.length) {
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth === 0 && (ch === "," || ch === ";" || TOP_LEVEL_WHITESPACE_RE.test(ch))) {
			return true;
		}
	}
	return false;
}

function splitTopLevelDelimitedPath(entry: string, mode: DelimitedPathSplitMode): string[] {
	const parts: string[] = [];
	let braceDepth = 0;
	let start = 0;
	for (let i = 0; i < entry.length; i++) {
		const ch = entry[i];
		if (ch === "\\" && i + 1 < entry.length) {
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth !== 0 || !isDelimitedPathSeparator(ch, mode)) continue;
		parts.push(entry.slice(start, i));
		start = i + 1;
	}
	parts.push(entry.slice(start));
	return parts;
}

async function delimitedPathPartResolves(entry: string, cwd: string, splitter: PathEntrySplitter): Promise<boolean> {
	if (isInternalUrlPath(entry)) return true;
	const peeled = splitPathAndSel(entry).path;
	const { basePath } = splitter(peeled);
	const absoluteBasePath = resolveToCwd(basePath, cwd);
	try {
		await fs.promises.stat(absoluteBasePath);
		return true;
	} catch (err) {
		if (isEnoent(err) || hasFsCode(err, "ENAMETOOLONG")) return false;
		throw err;
	}
}

type DelimitedResolveRequirement = "all" | "some" | "none";

async function tryDelimitedPathSplit(
	entry: string,
	cwd: string,
	splitter: PathEntrySplitter,
	mode: DelimitedPathSplitMode,
	requirement: DelimitedResolveRequirement,
): Promise<string[] | null> {
	const rawParts = splitTopLevelDelimitedPath(entry, mode);
	if (rawParts.length < 2) return null;

	const parts = rawParts.map(normalizePathLikeInput).filter(part => part.length > 0);
	if (parts.length === 0) return null;
	if (parts.length < 2 && rawParts.length === parts.length) return null;

	if (requirement !== "none") {
		const resolved = await Promise.all(parts.map(part => delimitedPathPartResolves(part, cwd, splitter)));
		const valid = requirement === "all" ? resolved.every(Boolean) : resolved.some(Boolean);
		if (!valid) return null;
	}
	return parts;
}

export async function splitDelimitedPathEntry(
	entry: string,
	cwd: string,
	options: {
		splitter?: PathEntrySplitter;
		routedUrlPredicate?: (entry: string) => boolean;
	} = {},
): Promise<string[] | null> {
	const normalizedEntry = normalizePathLikeInput(entry);
	if (!hasTopLevelPathDelimiter(normalizedEntry)) return null;
	const splitter = options.splitter ?? parseSearchPath;
	if (options.routedUrlPredicate?.(normalizedEntry)) {
		const parts = await tryDelimitedPathSplit(normalizedEntry, cwd, splitter, "semicolon", "none");
		return parts?.every(options.routedUrlPredicate) ? parts : null;
	}
	if (isInternalUrlPath(normalizedEntry)) return null;

	if ((await probeLiteralPathExists(normalizedEntry, cwd)) !== "missing") return null;
	const peeledEntry = splitPathAndSel(normalizedEntry).path;
	if (!hasGlobPathChars(peeledEntry) && (await delimitedPathPartResolves(normalizedEntry, cwd, splitter))) {
		return null;
	}

	return (
		(await tryDelimitedPathSplit(normalizedEntry, cwd, splitter, "semicolon", "none")) ??
		(await tryDelimitedPathSplit(normalizedEntry, cwd, splitter, "comma", "some")) ??
		(await tryDelimitedPathSplit(normalizedEntry, cwd, splitter, "whitespace", "all")) ??
		(await tryDelimitedPathSplit(normalizedEntry, cwd, splitter, "mixed", "all"))
	);
}

interface ParsedSearchPath {
	basePath: string;
	glob?: string;
}

export function parseSearchPath(filePath: string): ParsedSearchPath {
	const normalizedPath = normalizePathSeparators(filePath);
	const segments = normalizedPath.split("/");
	let firstGlobIndex = -1;
	for (let i = 0; i < segments.length; i++) {
		if (hasGlobPathChars(segments[i])) {
			firstGlobIndex = i;
			break;
		}
	}

	if (firstGlobIndex === -1) {
		return { basePath: normalizedPath };
	}

	if (firstGlobIndex <= 0) {
		return { basePath: ".", glob: normalizedPath };
	}

	return {
		basePath: segments.slice(0, firstGlobIndex).join("/"),
		glob: segments.slice(firstGlobIndex).join("/"),
	};
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);
	const shellEscapedVariant = tryShellEscapedPath(resolved);
	const baseCandidates = shellEscapedVariant !== resolved ? [resolved, shellEscapedVariant] : [resolved];

	for (const baseCandidate of baseCandidates) {
		if (fileExists(baseCandidate)) {
			return baseCandidate;
		}
	}

	for (const baseCandidate of baseCandidates) {
		const amPmVariant = tryMacOSScreenshotPath(baseCandidate);
		if (amPmVariant !== baseCandidate && fileExists(amPmVariant)) {
			return amPmVariant;
		}

		const nfdVariant = tryNFDVariant(baseCandidate);
		if (nfdVariant !== baseCandidate && fileExists(nfdVariant)) {
			return nfdVariant;
		}

		const curlyVariant = tryCurlyQuoteVariant(baseCandidate);
		if (curlyVariant !== baseCandidate && fileExists(curlyVariant)) {
			return curlyVariant;
		}

		const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
		if (nfdCurlyVariant !== baseCandidate && fileExists(nfdCurlyVariant)) {
			return nfdCurlyVariant;
		}
	}

	return resolved;
}

const WORKSPACE_SUFFIX_TIMEOUT_MS = 5000;

function escapeGlobMetachars(value: string): string {
	return value.replace(/[*?[{]/g, "[$&]");
}

async function findUniqueWorkspaceSuffixWithGlob(
	rawPath: string,
	cwd: string,
	signal: AbortSignal | undefined,
	globImpl: typeof glob,
): Promise<{ absolutePath: string; displayPath: string } | null> {
	const normalized = rawPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	if (!normalized) return null;

	const timeoutSignal = AbortSignal.timeout(WORKSPACE_SUFFIX_TIMEOUT_MS);
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	let matches: string[];
	try {
		const result = await globImpl({
			pattern: `**/${escapeGlobMetachars(normalized)}`,
			path: cwd,
			hidden: true,
			signal: combinedSignal,
			timeoutMs: WORKSPACE_SUFFIX_TIMEOUT_MS,
		});
		if (signal?.aborted) throw new ToolAbortError();
		matches = result.matches.map(match => match.path);
	} catch {
		if (signal?.aborted) throw new ToolAbortError();
		return null;
	}

	if (matches.length !== 1) return null;
	return {
		absolutePath: path.resolve(cwd, matches[0]),
		displayPath: matches[0],
	};
}

export async function findUniqueWorkspaceSuffix(
	rawPath: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ absolutePath: string; displayPath: string } | null> {
	return findUniqueWorkspaceSuffixWithGlob(rawPath, cwd, signal, glob);
}
