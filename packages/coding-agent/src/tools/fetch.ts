import type { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type FetchImpl, getEnvApiKey, type ImageContent, type TextContent } from "@oh-my-pi/pi-ai";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { $which, ptree, truncate, truncateHeadBytes } from "@oh-my-pi/pi-utils";
import type { ArchiveFormat } from "@oh-my-pi/pi-utils/ar";
import type { Element as DomElement } from "@oh-my-pi/pi-utils/dom";
import type { Settings } from "../config/settings";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { type Theme, theme } from "../modes/theme/theme";
import type { ToolSession } from "../sdk";
import type { AgentStorage } from "../session/agent-storage";
import { DEFAULT_MAX_BYTES, truncateHead } from "../session/streaming-output";
import { renderStatusLine, urlHyperlink } from "../tui";
import { CachedOutputBlock, markFramedBlockComponent } from "../tui/output-block";
import { decodeBody, readResponseText } from "../web/response-body";
import { MAX_BYTES, type RenderResult, type SpecialHandler } from "../web/scrapers/types";
import type { BinaryFetchResult } from "../web/scrapers/utils";
import { applyListLimit } from "./list-limit";
import { formatStyledArtifactReference, type OutputMeta } from "./output-meta";
import { isReadableUrlPath, type LineRange, parseLineRanges } from "./path-utils";
import { formatBytes, formatExpandHint, getDomain, sanitizeDisplayLines } from "./render-utils";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

const FETCH_DEFAULT_MAX_LINES = 300;

function loadScraperTypes() {
	return import("../web/scrapers/types");
}

function loadScraperUtils() {
	return import("../web/scrapers/utils");
}

async function fetchBinaryPayload(url: string, timeout: number, signal?: AbortSignal) {
	const { fetchBinary } = await loadScraperUtils();
	return fetchBinary(url, timeout, signal);
}

async function convertWithMarkitPayload(buffer: Uint8Array, extension: string, timeout: number, signal?: AbortSignal) {
	const { convertWithMarkit } = await loadScraperUtils();
	return convertWithMarkit(buffer, extension, timeout, signal);
}

function isPotentialMarkitExtension(extension: string): boolean {
	return (
		extension === ".pdf" ||
		extension === ".docx" ||
		extension === ".pptx" ||
		extension === ".xlsx" ||
		extension === ".epub"
	);
}

async function isConvertible(mime: string, extensionHint: string): Promise<boolean> {
	if (CONVERTIBLE_MIMES.has(mime)) return true;
	if (!isPotentialMarkitExtension(extensionHint)) return false;
	const { CONVERTIBLE_EXTENSIONS } = await import("../utils/markit");
	return CONVERTIBLE_EXTENSIONS.has(extensionHint);
}

const CONVERTIBLE_MIMES = new Set([
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/epub+zip",
]);

const NOTEBOOK_MIMES = new Set(["application/x-ipynb+json"]);
const NOTEBOOK_EXTENSIONS = new Set([".ipynb"]);

const SQLITE_MIMES = new Set([
	"application/vnd.sqlite3",
	"application/x-sqlite3",
	"application/sqlite3",
	"application/sqlite",
]);
const SQLITE_EXTENSIONS = new Set([".sqlite", ".sqlite3", ".db", ".db3"]);

const ARCHIVE_MIMES = new Set([
	"application/zip",
	"application/x-zip-compressed",
	"application/x-tar",
	"application/tar",
	"application/gzip",
	"application/x-gzip",
]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".tar", ".tar.gz", ".tgz", ".gz"]);

const IMAGE_MIME_BY_EXTENSION = new Map<string, string>([
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
]);
const SUPPORTED_INLINE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_IMAGE_OUTPUT_BYTES = 300 * 1024;

function hasCommand(cmd: string): boolean {
	return Boolean($which(cmd));
}

function buildLlmEndpointCandidates(url: string): string[] {
	try {
		const parsed = new URL(url);
		if (parsed.pathname === "/") {
			return [`${parsed.origin}/.well-known/llms.txt`, `${parsed.origin}/llms.txt`, `${parsed.origin}/llms.md`];
		}

		const trimmedPath = parsed.pathname.replace(/\/+$/, "");
		const segments = trimmedPath.split("/").filter(Boolean);
		const scopeDepth = parsed.pathname.endsWith("/") ? segments.length : Math.max(segments.length - 1, 1);
		const endpoints: string[] = [];

		for (let depth = scopeDepth; depth >= 1; depth--) {
			const scope = `/${segments.slice(0, depth).join("/")}/`;
			endpoints.push(`${parsed.origin}${scope}llms.txt`, `${parsed.origin}${scope}llms.md`);
		}

		return endpoints;
	} catch {
		return [];
	}
}

function repairCollapsedScheme(value: string): string {
	const m = value.match(/^(https?):\/(?!\/)/i);
	return m ? `${m[1]}://${value.slice(m[0].length)}` : value;
}

function normalizeUrl(url: string): string {
	url = repairCollapsedScheme(url);
	if (!url.match(/^https?:\/\//i)) {
		return `https://${url}`;
	}
	return url;
}

interface ParsedReadUrlTarget {
	path: string;
	raw: boolean;
	offset?: number;
	limit?: number;

	ranges?: readonly LineRange[];
}

function isUrlSelectorToken(token: string): boolean {
	if (token.toLowerCase() === "raw") return true;
	try {
		return parseLineRanges(token) !== null;
	} catch {
		return false;
	}
}

export function parseReadUrlTarget(readPath: string): ParsedReadUrlTarget | null {
	const repaired = repairCollapsedScheme(readPath);
	const embedded = tryExtractEmbeddedUrlSelector(repaired);
	const urlPath = embedded?.path ?? repaired;
	if (!isReadableUrlPath(urlPath)) {
		return null;
	}

	const selectors = embedded?.sels ?? [];
	const raw = selectors.some(sel => sel.toLowerCase() === "raw");
	let ranges: readonly LineRange[] | undefined;
	for (const sel of selectors) {
		if (sel.toLowerCase() === "raw") {
			continue;
		}
		if (ranges !== undefined) {
			throw new ToolError(
				`URL selector has multiple range groups; combine them with commas (e.g. \`:5-10,20-30\`).`,
			);
		}
		const parsed = parseLineRanges(raw ? sel.replace(/(^|,)\s*(\d+)\s*(?=,|$)/g, "$1$2-$2") : sel);
		if (parsed === null) {
			throw new ToolError(`Invalid URL line selector: ${sel}`);
		}
		ranges = parsed;
	}

	if (!ranges || ranges.length === 0) return { path: urlPath, raw };
	if (ranges.length === 1) {
		const r = ranges[0];
		return {
			path: urlPath,
			raw,
			offset: r.startLine,
			limit: r.endLine !== undefined ? r.endLine - r.startLine + 1 : undefined,
		};
	}
	return { path: urlPath, raw, ranges };
}

/**
 * True when `candidate` is the port of `base`'s authority rather than a selector, i.e. the colon
 * separating them is the `host:port` delimiter: `http://127.0.0.1` + `38051`. A port only exists
 * while the authority is still the tail of the URL (`http://host:8080/page` has its path after it)
 * and while the authority carries no port yet (`http://host:8080` + `12` is a line selector).
 */
function isAuthorityPortCandidate(base: string, candidate: string): boolean {
	if (!/^\d{1,5}$/.test(candidate)) return false;
	const port = Number(candidate);
	if (port < 1 || port > 65535) return false;
	const withoutScheme = base.replace(/^https?:\/\//i, "");
	const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? "";
	if (withoutScheme.length > authority.length) return false;
	const afterHost = authority.slice(authority.lastIndexOf("]") + 1);
	return !afterHost.includes(":");
}

function tryExtractEmbeddedUrlSelector(readPath: string): { path: string; sels: string[] } | null {
	let basePath = readPath;
	const sels: string[] = [];
	while (true) {
		const lastColonIndex = basePath.lastIndexOf(":");
		if (lastColonIndex <= 0) break;

		const candidate = basePath.slice(lastColonIndex + 1);
		const remainder = basePath.slice(0, lastColonIndex);
		if (!isReadableUrlPath(remainder)) break;
		if (!isUrlSelectorToken(candidate)) break;
		if (isAuthorityPortCandidate(remainder, candidate)) break;

		try {
			new URL(
				remainder.startsWith("http://") || remainder.startsWith("https://") ? remainder : `https://${remainder}`,
			);
		} catch {
			break;
		}

		sels.unshift(candidate);
		basePath = remainder;
	}
	if (sels.length === 0) return null;
	return { path: basePath, sels };
}

function normalizeMime(contentType: string): string {
	return contentType.split(";")[0].trim().toLowerCase();
}

function getFilenameExtensionHint(filename: string): string {
	const lower = filename.toLowerCase();
	if (lower.endsWith(".tar.gz")) return ".tar.gz";
	return path.extname(filename).toLowerCase();
}

function getExtensionHint(url: string, contentDisposition?: string): string {
	if (contentDisposition) {
		const match = contentDisposition.match(/filename[*]?=["']?([^"';\n]+)/i);
		if (match) {
			const ext = getFilenameExtensionHint(match[1]);
			if (ext) return ext;
		}
	}

	try {
		const pathname = new URL(url).pathname;
		const ext = getFilenameExtensionHint(pathname);
		if (ext) return ext;
	} catch {}

	return "";
}

function resolveImageMimeType(mime: string, extensionHint: string): string | null {
	if (mime.startsWith("image/")) return mime;
	const shouldUseExtensionHint =
		mime.length === 0 || mime === "application/octet-stream" || mime === "binary/octet-stream" || mime === "unknown";
	if (!shouldUseExtensionHint) return null;
	return IMAGE_MIME_BY_EXTENSION.get(extensionHint) ?? null;
}

function isInlineImageMimeTypeSupported(mimeType: string): boolean {
	return SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(mimeType);
}

async function tryLlmEndpoints(
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; endpoint: string; finalUrl: string; truncated: boolean } | null> {
	const { loadPage, looksLikeHtml } = await loadScraperTypes();
	const endpoints = buildLlmEndpointCandidates(url);

	if (signal?.aborted || endpoints.length === 0) {
		return null;
	}

	for (const endpoint of endpoints) {
		if (signal?.aborted) {
			return null;
		}
		const result = await loadPage(endpoint, { timeout: Math.min(timeout, 5), signal });
		if (result.ok && result.content.trim().length > 100 && !looksLikeHtml(result.content)) {
			return { content: result.content, endpoint, finalUrl: result.finalUrl, truncated: Boolean(result.truncated) };
		}
	}
	return null;
}

async function tryContentNegotiation(
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; type: string; finalUrl: string; truncated: boolean } | null> {
	const { loadPage, looksLikeHtml } = await loadScraperTypes();
	if (signal?.aborted) {
		return null;
	}

	const result = await loadPage(url, {
		timeout,
		headers: { Accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8" },
		signal,
	});

	if (!result.ok) return null;

	const mime = normalizeMime(result.contentType);
	if ((mime.includes("markdown") || mime === "text/plain") && !looksLikeHtml(result.content)) {
		return {
			content: result.content,
			type: result.contentType,
			finalUrl: result.finalUrl,
			truncated: Boolean(result.truncated),
		};
	}

	return null;
}

function getHtmlAttribute(tag: string, attribute: string): string | null {
	const pattern = new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i");
	const match = tag.match(pattern);
	if (!match) return null;
	return (match[1] ?? match[2] ?? match[3] ?? "").trim();
}

// Bounded case-insensitive scans: lowercasing the whole page first cost ~0.3ms/MB.
function extractHeadHtml(html: string): string {
	const window = html.length > 256 * 1024 ? html.slice(0, 256 * 1024) : html;
	const headStart = window.search(/<head[\s>]/i);
	if (headStart === -1) {
		return html.slice(0, 32 * 1024);
	}

	const headTagEnd = html.indexOf(">", headStart);
	if (headTagEnd === -1 || headTagEnd - headStart > 4096) {
		return html.slice(headStart, headStart + 32 * 1024);
	}

	const tail = html.slice(headTagEnd + 1, headTagEnd + 1 + 128 * 1024);
	const relativeEnd = tail.search(/<\/head\s*>/i);
	// No close tag in the scanned window: the head may run longer, so keep everything scanned.
	if (relativeEnd === -1) return html.slice(headStart, headTagEnd + 1 + tail.length);
	return html.slice(headStart, headTagEnd + 1 + relativeEnd + 7);
}

function parseAlternateLinks(html: string, pageUrl: string): Array<{ href: string; kind: "markdown" | "feed" }> {
	const links: Array<{ href: string; kind: "markdown" | "feed" }> = [];

	try {
		const pagePath = new URL(pageUrl).pathname.replace(/\/+$/, "");
		const headHtml = extractHeadHtml(html);
		const linkTags = headHtml.match(/<link\b[^>]*>/gi) ?? [];

		for (const tag of linkTags) {
			const rel = getHtmlAttribute(tag, "rel")?.toLowerCase() ?? "";
			const relTokens = rel.split(/\s+/).filter(Boolean);
			if (!relTokens.includes("alternate")) continue;

			const href = getHtmlAttribute(tag, "href");
			const type = getHtmlAttribute(tag, "type")?.toLowerCase() ?? "";
			if (!href) continue;

			if (
				href.includes("RecentChanges") ||
				href.includes("Special:") ||
				href.includes("/feed/") ||
				href.includes("action=feed")
			) {
				continue;
			}

			const altPath = new URL(href, pageUrl).pathname;
			const pageSpecific =
				altPath === pagePath ||
				(pagePath !== "" && (altPath.startsWith(`${pagePath}/`) || altPath.startsWith(`${pagePath}.`)));
			if (!pageSpecific) continue;
			if (type.includes("markdown")) links.push({ href, kind: "markdown" });
			else if (pagePath !== "" && (type.includes("rss") || type.includes("atom") || type.includes("feed")))
				links.push({ href, kind: "feed" });
		}
	} catch {}

	return links;
}

async function extractDocumentLinks(html: string, baseUrl: string): Promise<string[]> {
	const { CONVERTIBLE_EXTENSIONS } = await import("../utils/markit");
	const links: string[] = [];
	const seen = new Set<string>();

	try {
		const anchorTags = html.slice(0, 512 * 1024).match(/<a\b[^>]*>/gi) ?? [];
		for (const tag of anchorTags) {
			const href = getHtmlAttribute(tag, "href");
			if (!href) continue;

			const ext = path.extname(href).toLowerCase();
			if (!CONVERTIBLE_EXTENSIONS.has(ext)) continue;

			const resolved = href.startsWith("http") ? href : new URL(href, baseUrl).href;
			if (seen.has(resolved)) continue;
			seen.add(resolved);
			links.push(resolved);
			if (links.length >= 20) break;
		}
	} catch {}

	return links;
}

function cleanFeedText(text: string): string {
	return text
		.replace(/<!\[CDATA\[/g, "")
		.replace(/\]\]>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/<[^>]+>/g, "")
		.trim();
}

interface FeedEntry {
	title: string;
	link: string;
	date: string;
	summary: string;
}

function formatFeedMarkdown(title: string, entries: readonly FeedEntry[]): string {
	let md = `# ${title}\n\n`;
	for (const entry of entries) {
		md += `## ${entry.title || "Untitled"}\n`;
		if (entry.date) md += `*${entry.date}*\n\n`;
		if (entry.summary) md += `${entry.summary.slice(0, 500)}${entry.summary.length > 500 ? "..." : ""}\n\n`;
		if (entry.link) md += `[Read more](${entry.link})\n\n`;
		md += "---\n\n";
	}
	return md;
}

async function parseFeedToMarkdown(content: string, maxItems = 10): Promise<string | null> {
	const { parseHTML, Text: DomText } = await import("@oh-my-pi/pi-utils/dom");
	try {
		const doc = parseHTML(content).document;
		const childText = (parent: DomElement, selector: string): string =>
			cleanFeedText(parent.querySelector(selector)?.textContent ?? "");
		const hasContent = (entry: FeedEntry): boolean => entry.title.length > 0 || entry.link.length > 0;

		const channel = doc.querySelector("channel");
		if (channel) {
			const entries = channel
				.querySelectorAll("item")
				.slice(0, maxItems)
				.map(item => {
					const link = item.querySelector("link");
					const linkSibling = link?.nextSibling;
					const linkText = link?.textContent || (linkSibling instanceof DomText ? linkSibling.textContent : "");
					return {
						title: childText(item, "title"),
						link: cleanFeedText(linkText),
						date: childText(item, "pubDate"),
						summary: childText(item, "description"),
					};
				})
				.filter(hasContent);
			if (entries.length === 0) return null;
			return formatFeedMarkdown(childText(channel, "title") || "RSS Feed", entries);
		}

		const feed = doc.querySelector("feed");
		if (feed) {
			const entries = feed
				.querySelectorAll("entry")
				.slice(0, maxItems)
				.map(entry => ({
					title: childText(entry, "title"),
					link: entry.querySelector("link")?.getAttribute("href") ?? "",
					date: childText(entry, "updated"),
					summary: childText(entry, "summary") || childText(entry, "content"),
				}))
				.filter(hasContent);
			if (entries.length === 0) return null;
			return formatFeedMarkdown(childText(feed, "title") || "Atom Feed", entries);
		}
	} catch {}

	return null;
}

const REMOTE_READER_MAX_MS = 10_000;
const JINA_MARKDOWN_MARKER = "Markdown Content:";
const JINA_READER_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Reads at most `maxBytes` of a response body, cancelling the stream as soon as the
 * cap is passed. `response.text()` would buffer the whole body regardless of the
 * declared `content-length`, which a missing, wrong, or chunked header makes unbounded.
 */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
	return readResponseText(response, maxBytes);
}

function parseJinaReaderContent(responseBody: string): string | null {
	const markerStart = responseBody.indexOf(JINA_MARKDOWN_MARKER);
	if (markerStart < 0) return null;

	const content = responseBody.slice(markerStart + JINA_MARKDOWN_MARKER.length).trim();
	if (content.length < 100 || content.startsWith("Loading...") || content.startsWith("Please enable JavaScript")) {
		return null;
	}
	return content;
}

/**
 * Markdown image whose destination is an inline `data:` URI (any case, bare or `<…>`-wrapped, optional title). The
 * label allows backslash escapes; base64 payloads never contain `)` or whitespace.
 */
const DATA_URI_IMAGE_RE =
	/!\[((?:\\.|[^\\\]])*)\]\(\s*(?:<data:[^>]*>|data:[^)\s]*)(?:\s+(?:"(?:\\.|[^\\"])*"|'(?:\\.|[^\\'])*'|\((?:\\.|[^\\)])*\)))?\s*\)/gi;

/** Drops inline `data:` image payloads (SVG icons, base64 `<img>`) that dwarf article text; keeps alt text. */
function stripDataUriImages(markdown: string): string {
	return markdown.replace(DATA_URI_IMAGE_RE, (_match, alt: string) => (alt.trim() ? `![${alt}]` : ""));
}

/**
 * `<meta>` names and properties, as the page writes them in any letter case, whose front-matter
 * line is worth its tokens to a reader; Open Graph, Twitter Card, viewport and verification tags
 * are not.
 */
const READER_META_NAMES: Record<string, true> = {
	description: true,
	author: true,
	"article:published_time": true,
	"article:modified_time": true,
};

/** The key of a front-matter line: a plain YAML scalar, which holds no `: `, or a double-quoted one. */
const FRONT_MATTER_KEY_RE = /^(?:("(?:\\.|[^\\"])*")|([^"][^\n]*?)): /;

/** Omitted `<meta>` names the front matter lists by name; the rest are counted. */
const MAX_OMITTED_META_NAMES = 25;

/** Reader output at or under this many characters is no rendering of the page. */
const MIN_RENDERED_CHARS = 100;

/**
 * Drop the native converter's front-matter lines for `<meta>` tags outside {@link READER_META_NAMES}
 * (keys `meta-<name>`, YAML-escaped) and name them in one `meta_omitted` line. A page whose only
 * content is its `<head>` is returned whole.
 */
function pruneFrontMatter(markdown: string): string {
	if (!markdown.startsWith("---\n")) return markdown;
	const end = markdown.indexOf("\n---\n", 3);
	if (end < 0) return markdown;
	const kept: string[] = [];
	const omitted: string[] = [];
	for (const line of markdown.slice(4, end).split("\n")) {
		const key = FRONT_MATTER_KEY_RE.exec(line);
		// No front matter: the body opens with a `---` rule.
		if (!key) return markdown;
		let name: string;
		try {
			// The converter's double-quoted escapes are JSON's.
			name = key[1] === undefined ? key[2] : JSON.parse(key[1]);
		} catch {
			return markdown;
		}
		if (name.startsWith("meta-") && !Object.hasOwn(READER_META_NAMES, name.slice(5).toLowerCase())) {
			omitted.push(name.slice(5));
		} else {
			kept.push(line);
		}
	}
	if (omitted.length === 0) return markdown;
	const rest = markdown.slice(end);
	const head = kept.join("\n");
	// `renderHtmlToText` already stripped data-URI images, so the length check needs no second pass.
	if ((head ? `---\n${head}${rest}` : rest.slice(5)).trim().length <= MIN_RENDERED_CHARS) return markdown;
	const more = omitted.length - MAX_OMITTED_META_NAMES;
	const note = `${omitted.slice(0, MAX_OMITTED_META_NAMES).join(", ")}${more > 0 ? ` (+${more} more)` : ""}; read the URL with :raw for their values`;
	// A JSON string is a YAML double-quoted scalar once the characters YAML reads as line breaks are escaped.
	const value = JSON.stringify(note).replace(
		/[\u0085\u2028\u2029]/g,
		c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
	return `---\n${head ? `${head}\n` : ""}meta_omitted: ${value}${rest}`;
}

type FetchProvider = "native" | "trafilatura" | "lynx" | "parallel" | "jina";

const FETCH_PROVIDER_ORDER: readonly FetchProvider[] = ["native", "trafilatura", "lynx", "parallel", "jina"];

export async function renderHtmlToText(
	url: string,
	html: string,
	timeout: number,
	settings: Settings,
	userSignal: AbortSignal | undefined,
	storage: AgentStorage | null,
	fetchOverride?: FetchImpl,
): Promise<{ content: string; ok: boolean; method: string }> {
	const overallSignal = ptree.combineSignals(userSignal, timeout * 1000);
	const execOptions = {
		mode: "group" as const,
		allowNonZero: true,
		allowAbort: true,
		stderr: "full" as const,
		maxStdoutBytes: MAX_BYTES,
		maxStderrBytes: 64 * 1024,
		signal: overallSignal,
	};
	const remoteBudgetMs = Math.min(timeout * 1000, REMOTE_READER_MAX_MS);

	const remoteSignal = () => ptree.combineSignals(userSignal, remoteBudgetMs);
	const fetchImpl = fetchOverride ?? fetch;

	const runners: Record<FetchProvider, () => Promise<string | null>> = {
		native: async () => {
			const { htmlToMarkdown } = await import("@oh-my-pi/pi-natives");
			return htmlToMarkdown(html, { cleanContent: true, hiddenContent: "reachable" });
		},
		trafilatura: async () => {
			const { ensureTool } = await import("../utils/tools-manager");
			overallSignal?.throwIfAborted();
			const trafilatura = await ensureTool("trafilatura", { signal: overallSignal, silent: true });
			overallSignal?.throwIfAborted();
			if (!trafilatura) return null;
			const result = await ptree.exec([trafilatura, "-u", url, "--output-format", "markdown"], execOptions);
			return result.ok ? result.stdout : null;
		},
		lynx: async () => {
			overallSignal?.throwIfAborted();
			if (!hasCommand("lynx")) return null;
			const result = await ptree.exec(["lynx", "-dump", "-nolist", "-width", "250", url], execOptions);
			return result.ok ? result.stdout : null;
		},
		parallel: async () => {
			const { extractWithParallel, findParallelApiKey, getParallelExtractContent } = await import("../web/parallel");
			if (!findParallelApiKey(storage)) return null;
			const parallelResult = await extractWithParallel(
				[url],
				{
					objective: "Extract the main content",
					excerpts: true,
					fullContent: false,
					signal: remoteSignal(),
					fetch: fetchImpl,
				},
				storage,
			);
			const firstDocument = parallelResult.results[0];
			return firstDocument ? getParallelExtractContent(firstDocument) : null;
		},
		jina: async () => {
			const { findCredential } = await import("../web/search/providers/utils");
			const apiKey = findCredential(storage, getEnvApiKey("jina"), "jina");
			const response = await fetchImpl(`https://r.jina.ai/${url}`, {
				headers: {
					Accept: "text/markdown",
					"X-No-Cache": "true",
					...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
				},
				signal: remoteSignal(),
			});
			if (!response.ok) return null;
			const contentLength = Number(response.headers.get("content-length"));
			if (Number.isFinite(contentLength) && contentLength > JINA_READER_MAX_BYTES) return null;
			const body = await readBoundedText(response, JINA_READER_MAX_BYTES);
			return body === null ? null : parseJinaReaderContent(body);
		},
	};

	const preference = settings.get("providers.fetch");
	const order: readonly FetchProvider[] =
		preference === "auto"
			? FETCH_PROVIDER_ORDER
			: [preference, ...FETCH_PROVIDER_ORDER.filter(method => method !== preference)];

	let lowQuality: { content: string; method: FetchProvider } | null = null;

	for (const method of order) {
		userSignal?.throwIfAborted();
		try {
			const rendered = await runners[method]();
			if (!rendered) continue;
			const content = stripDataUriImages(rendered);
			if (content.trim().length <= 100) continue;
			if (!isLowQualityOutput(content, method)) {
				return { content, ok: true, method };
			}
			lowQuality ??= { content, method };
		} catch {
			userSignal?.throwIfAborted();
		}
	}

	if (lowQuality) {
		return { content: lowQuality.content, ok: true, method: lowQuality.method };
	}
	return { content: "", ok: false, method: "none" };
}

function isLowQualityOutput(content: string, method: string): boolean {
	const lower = content.toLowerCase();

	const jsGated = [
		"enable javascript",
		"javascript required",
		"turn on javascript",
		"please enable javascript",
		"browser not supported",
	];
	if (content.length < 1024 && jsGated.some(t => lower.includes(t))) {
		return true;
	}

	return method === "lynx" && isMostlyShortLines(content);
}

function isMostlyShortLines(content: string): boolean {
	const lines = content.split("\n").filter(line => line.trim());
	return lines.length > 10 && lines.filter(line => line.trim().length < 40).length / lines.length > 0.7;
}

function renderedLinkTargets(content: string, baseUrl: string): Set<string> {
	const targets = new Set<string>();
	for (const match of content.matchAll(/\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g)) {
		try {
			targets.add(new URL(match[1] ?? match[2], baseUrl).href);
		} catch {}
	}
	return targets;
}

function formatJson(content: string): string {
	try {
		return JSON.stringify(JSON.parse(content), null, 2);
	} catch {
		return content;
	}
}

interface FetchImagePayload {
	data: string;
	mimeType: string;
}

type FetchRenderResult = RenderResult & {
	image?: FetchImagePayload;
	/** Set when the request itself failed (HTTP error status or transport error). */
	failure?: { status?: number; error?: string };
};

const BINARY_SAMPLE_CHARS = 4096;
const URL_ARCHIVE_LIST_LIMIT = 500;
const URL_SQLITE_LIST_LIMIT = 500;

function sampleLooksBinary(text: string): boolean {
	const limit = Math.min(text.length, BINARY_SAMPLE_CHARS);
	if (limit === 0) return false;

	let replacementCount = 0;
	for (let index = 0; index < limit; index++) {
		const code = text.charCodeAt(index);
		if (code === 0) return true;
		if (code === 0xfffd) replacementCount++;
	}

	return replacementCount >= 3 && replacementCount / limit > 0.01;
}

function isNotebookHint(mime: string, extensionHint: string): boolean {
	return NOTEBOOK_MIMES.has(mime) || NOTEBOOK_EXTENSIONS.has(extensionHint);
}

function isSqliteHint(mime: string, extensionHint: string): boolean {
	return SQLITE_MIMES.has(mime) || SQLITE_EXTENSIONS.has(extensionHint);
}

function isArchiveHint(mime: string, extensionHint: string): boolean {
	return ARCHIVE_MIMES.has(mime) || ARCHIVE_EXTENSIONS.has(extensionHint);
}

function shouldSkipBodyDownload(contentType: string): boolean {
	return (
		CONVERTIBLE_MIMES.has(contentType) ||
		NOTEBOOK_MIMES.has(contentType) ||
		SQLITE_MIMES.has(contentType) ||
		ARCHIVE_MIMES.has(contentType) ||
		SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(contentType)
	);
}

function getArchiveFormatHint(mime: string, extensionHint: string): ArchiveFormat | undefined {
	if (extensionHint === ".zip" || mime === "application/zip" || mime === "application/x-zip-compressed") {
		return "zip";
	}
	if (extensionHint === ".tar" || mime === "application/x-tar" || mime === "application/tar") {
		return "tar";
	}
	if (
		extensionHint === ".tar.gz" ||
		extensionHint === ".tgz" ||
		extensionHint === ".gz" ||
		mime === "application/gzip" ||
		mime === "application/x-gzip"
	) {
		return "tar.gz";
	}
	return undefined;
}

function formatErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function binaryContentType(mime: string): string {
	return mime || "application/octet-stream";
}

function buildBinaryNotice(finalUrl: string, mime: string, byteLength?: number): string {
	const size = byteLength === undefined ? "unknown size" : formatBytes(byteLength);
	return `[Binary content: ${binaryContentType(mime)}, ${size}] ${finalUrl}`;
}

async function buildBinaryPayloadResult(
	url: string,
	finalUrl: string,
	mime: string,
	method: string,
	content: string,
	fetchedAt: string,
	notes: string[],
): Promise<FetchRenderResult> {
	const { finalizeOutput } = await loadScraperTypes();
	const output = finalizeOutput(content);
	return {
		url,
		finalUrl,
		contentType: binaryContentType(mime),
		method,
		content: output,
		fetchedAt,
		truncated: false,
		notes,
	};
}

async function withTempBinaryFile<T>(
	prefix: string,
	extension: string,
	bytes: Uint8Array,
	readTempFile: (tempPath: string) => Promise<T>,
): Promise<T> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const tempPath = path.join(tempDir, `payload${extension}`);
	try {
		await Bun.write(tempPath, bytes);
		return await readTempFile(tempPath);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

async function renderNotebookPayload(bytes: Uint8Array, displayUrl: string): Promise<string> {
	const { readEditableNotebookText } = await import("./notebook");
	return withTempBinaryFile("proto-url-notebook-", ".ipynb", bytes, tempPath =>
		readEditableNotebookText(tempPath, displayUrl),
	);
}

async function renderSqlitePayload(bytes: Uint8Array): Promise<string> {
	const { listTables, openSqliteReadConnection, renderTableList } = await import("./sqlite-reader");
	return withTempBinaryFile("proto-url-sqlite-", ".sqlite", bytes, async tempPath => {
		let db: Database | null = null;
		try {
			db = await openSqliteReadConnection(tempPath);
			const listLimit = applyListLimit(listTables(db), { limit: URL_SQLITE_LIST_LIMIT });
			return renderTableList(listLimit.items);
		} finally {
			db?.close();
		}
	});
}

async function payloadLooksLikeSqlite(bytes: Uint8Array): Promise<boolean> {
	const { looksLikeSqlite } = await import("./sqlite-reader");
	return looksLikeSqlite(bytes);
}

async function tryRenderBinaryPayload(
	url: string,
	finalUrl: string,
	mime: string,
	extHint: string,
	rawContent: string,
	bodySkipped: boolean,
	timeout: number,
	signal: AbortSignal | undefined,
	fetchedAt: string,
	notes: readonly string[],
	prefetched?: BinaryFetchResult,
): Promise<FetchRenderResult | string | null> {
	const hasNotebookHint = isNotebookHint(mime, extHint);
	const hasSqliteHint = isSqliteHint(mime, extHint);
	const hasArchiveHint = isArchiveHint(mime, extHint);
	const rawLooksBinary = bodySkipped || sampleLooksBinary(rawContent);
	if (!hasNotebookHint && !hasSqliteHint && !hasArchiveHint && !rawLooksBinary) {
		return null;
	}

	const resultNotes = [...notes];
	const binary = prefetched ?? (await fetchBinaryPayload(finalUrl, timeout, signal));
	if (!binary.ok) {
		resultNotes.push(binary.error ? `Binary fetch failed: ${binary.error}` : "Binary fetch failed");
		return buildBinaryPayloadResult(
			url,
			finalUrl,
			mime,
			"binary",
			buildBinaryNotice(finalUrl, mime),
			fetchedAt,
			resultNotes,
		);
	}

	const binaryExtHint = getExtensionHint(finalUrl, binary.contentDisposition) || extHint;
	if (isNotebookHint(mime, binaryExtHint)) {
		try {
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"notebook",
				await renderNotebookPayload(binary.buffer, finalUrl),
				fetchedAt,
				resultNotes,
			);
		} catch (error) {
			resultNotes.push(`Notebook rendering failed: ${formatErrorMessage(error)}`);
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"binary",
				buildBinaryNotice(finalUrl, mime, binary.buffer.byteLength),
				fetchedAt,
				resultNotes,
			);
		}
	}

	if (isSqliteHint(mime, binaryExtHint) || (await payloadLooksLikeSqlite(binary.buffer))) {
		try {
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"sqlite",
				await renderSqlitePayload(binary.buffer),
				fetchedAt,
				resultNotes,
			);
		} catch (error) {
			resultNotes.push(`SQLite rendering failed: ${formatErrorMessage(error)}`);
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"binary",
				buildBinaryNotice(finalUrl, mime, binary.buffer.byteLength),
				fetchedAt,
				resultNotes,
			);
		}
	}

	const hintedArchiveFormat = getArchiveFormatHint(mime, binaryExtHint);
	const shouldArchiveSniff = hintedArchiveFormat !== undefined || !(await isConvertible(mime, binaryExtHint));
	const archiveFormat =
		hintedArchiveFormat ??
		(shouldArchiveSniff ? (await import("@oh-my-pi/pi-utils/ar")).sniffArchiveFormat(binary.buffer) : undefined);
	if (archiveFormat) {
		try {
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"archive",
				await (await import("@oh-my-pi/pi-utils/ar")).listArchiveRoot(binary.buffer, archiveFormat, {
					limit: URL_ARCHIVE_LIST_LIMIT,
				}),
				fetchedAt,
				resultNotes,
			);
		} catch (error) {
			resultNotes.push(`Archive rendering failed: ${formatErrorMessage(error)}`);
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"binary",
				buildBinaryNotice(finalUrl, mime, binary.buffer.byteLength),
				fetchedAt,
				resultNotes,
			);
		}
	}

	if (rawLooksBinary && !bodySkipped && !hasNotebookHint && !hasSqliteHint && !hasArchiveHint) {
		const bytes = Buffer.from(binary.buffer.buffer, binary.buffer.byteOffset, binary.buffer.byteLength);
		if (!sampleLooksBinary(decodeBody(bytes.subarray(0, BINARY_SAMPLE_CHARS), binary.contentType ?? mime)))
			return decodeBody(bytes, binary.contentType ?? mime);
	}

	if (rawLooksBinary) {
		return buildBinaryPayloadResult(
			url,
			finalUrl,
			mime,
			"binary",
			buildBinaryNotice(finalUrl, mime, binary.buffer.byteLength),
			fetchedAt,
			resultNotes,
		);
	}

	return null;
}

let specialHandlersPromise: Promise<SpecialHandler[]> | undefined;

function loadSpecialHandlers(): Promise<SpecialHandler[]> {
	specialHandlersPromise ??= import("../web/scrapers").then(m => m.specialHandlers);
	return specialHandlersPromise;
}

async function handleSpecialUrls(
	url: string,
	timeout: number,
	signal: AbortSignal | undefined,
	storage: AgentStorage | null,
): Promise<FetchRenderResult | null> {
	const specialHandlers = await loadSpecialHandlers();
	for (const handler of specialHandlers) {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}
		const result = await handler(url, timeout, signal, storage);
		if (result) return result;
	}
	return null;
}

async function renderUrl(
	url: string,
	timeout: number,
	raw: boolean,
	settings: Settings,
	signal: AbortSignal | undefined,
	storage: AgentStorage | null,
	fetchOverride?: FetchImpl,
	excludeWebP?: true,
): Promise<FetchRenderResult> {
	const { finalizeOutput, loadPage, looksLikeHtml } = await loadScraperTypes();
	const notes: string[] = [];
	const fetchedAt = new Date().toISOString();
	if (signal?.aborted) {
		throw new ToolAbortError();
	}

	if (url.startsWith("pi-internal://")) {
		return {
			url,
			finalUrl: url,
			contentType: "text/plain",
			method: "internal",
			content: "",
			fetchedAt,
			truncated: false,
			notes: ["Internal protocol URL - no external content"],
		};
	}

	url = normalizeUrl(url);

	if (!raw) {
		const specialResult = await handleSpecialUrls(url, timeout, signal, storage);
		if (specialResult) return specialResult;
	}

	const requestExtHint = getExtensionHint(url);
	const genericBinaryMimes = new Set(["application/octet-stream", "binary/octet-stream", "application/x-download"]);
	const skipBody = (contentType: string) =>
		shouldSkipBodyDownload(contentType) ||
		(genericBinaryMimes.has(normalizeMime(contentType)) && isPotentialMarkitExtension(requestExtHint));
	let response = await loadPage(url, { timeout, signal, skipBodyForContentType: skipBody });
	if (
		response.ok &&
		response.bodySkipped &&
		!shouldSkipBodyDownload(response.contentType) &&
		!isPotentialMarkitExtension(getExtensionHint(response.finalUrl))
	) {
		response = await loadPage(url, {
			timeout,
			signal,
			skipBodyForContentType: shouldSkipBodyDownload,
		});
	}
	if (signal?.aborted) {
		throw new ToolAbortError();
	}
	if (!response.ok) {
		return {
			url,
			finalUrl: response.finalUrl || url,
			contentType: response.contentType || "unknown",
			method: "failed",
			content: response.content,
			fetchedAt,
			truncated: Boolean(response.truncated),
			notes: [
				response.status ? `Failed to fetch URL (HTTP ${response.status})` : "Failed to fetch URL",
				...(response.error ? [`Cause: ${response.error}`] : []),
			],
			failure: { status: response.status, error: response.error },
		};
	}

	const { finalUrl } = response;
	let rawContent = response.content;
	let sourceTruncated = Boolean(response.truncated);
	const mime = normalizeMime(response.contentType);
	const extHint = getExtensionHint(finalUrl);
	if (response.status === 204)
		return {
			url,
			finalUrl,
			contentType: mime,
			method: "no-content",
			content: "",
			fetchedAt,
			truncated: false,
			notes: ["HTTP 204 No Content"],
		};
	if (raw)
		return {
			url,
			finalUrl,
			contentType: mime,
			method: "raw",
			content: rawContent,
			fetchedAt,
			truncated: sourceTruncated,
			notes,
		};

	const imageMimeType = resolveImageMimeType(mime, extHint);
	let skipConvertibleBinaryRetry = false;
	if (imageMimeType) {
		if (!isInlineImageMimeTypeSupported(imageMimeType)) {
			notes.push(
				`Image MIME type ${imageMimeType} is unsupported for inline model serialization; returning text metadata only`,
			);
			notes.push("Falling back to textual rendering from initial response");
			skipConvertibleBinaryRetry = true;
		} else {
			const binary = await fetchBinaryPayload(finalUrl, timeout, signal);
			if (binary.ok) {
				notes.push("Fetched image binary");

				if (binary.buffer.byteLength > MAX_INLINE_IMAGE_SOURCE_BYTES) {
					notes.push(
						`Image exceeds inline source limit (${binary.buffer.byteLength} bytes > ${MAX_INLINE_IMAGE_SOURCE_BYTES} bytes)`,
					);
					const output = finalizeOutput(
						`Fetched image content (${imageMimeType}), but it is too large to inline render.`,
					);
					return {
						url,
						finalUrl,
						contentType: imageMimeType,
						method: "image-too-large",
						content: output,
						fetchedAt,
						truncated: false,
						notes,
					};
				}

				const { formatDimensionNote, resizeImage } = await import("../utils/image-resize");
				const resized = await resizeImage(
					{ type: "image", data: Buffer.from(binary.buffer).toBase64(), mimeType: imageMimeType },
					{ maxBytes: MAX_INLINE_IMAGE_OUTPUT_BYTES, excludeWebP },
				);
				const isDecodedImage =
					resized.originalWidth > 0 && resized.originalHeight > 0 && resized.width > 0 && resized.height > 0;
				if (!isDecodedImage) {
					notes.push(`Fetched payload could not be decoded as ${imageMimeType}; returning text metadata only`);
					const output = finalizeOutput(
						rawContent ?? `Fetched payload was labeled ${imageMimeType}, but bytes were not a valid image.`,
					);
					return {
						url,
						finalUrl,
						contentType: imageMimeType,
						method: "image-invalid",
						content: output,
						fetchedAt,
						truncated: false,
						notes,
					};
				}
				if (resized.buffer.length > MAX_INLINE_IMAGE_OUTPUT_BYTES) {
					notes.push(
						`Image exceeds inline output limit after resize (${resized.buffer.length} bytes > ${MAX_INLINE_IMAGE_OUTPUT_BYTES} bytes)`,
					);
					const output = finalizeOutput(
						`Fetched image content (${imageMimeType}), but it is too large to inline render.`,
					);
					return {
						url,
						finalUrl,
						contentType: imageMimeType,
						method: "image-too-large",
						content: output,
						fetchedAt,
						truncated: false,
						notes,
					};
				}

				const dimensionNote = formatDimensionNote(resized);
				let imageSummary = `Fetched image content (${resized.mimeType}).`;
				if (dimensionNote) {
					imageSummary += `\n${dimensionNote}`;
				}
				const output = finalizeOutput(imageSummary);
				return {
					url,
					finalUrl,
					contentType: resized.mimeType,
					method: "image",
					content: output,
					fetchedAt,
					truncated: false,
					notes,
					image: {
						data: resized.data,
						mimeType: resized.mimeType,
					},
				};
			}
			notes.push(binary.error ? `Binary fetch failed: ${binary.error}` : "Binary fetch failed");
			notes.push("Falling back to textual rendering from initial response");
			skipConvertibleBinaryRetry = true;
		}
	}

	let convertibleBinary: BinaryFetchResult | undefined;
	if (!skipConvertibleBinaryRetry && (await isConvertible(mime, extHint))) {
		const binary = await fetchBinaryPayload(finalUrl, timeout, signal);
		convertibleBinary = binary;
		if (binary.ok) {
			const ext = getExtensionHint(finalUrl, binary.contentDisposition) || extHint;
			const converted = await convertWithMarkitPayload(binary.buffer, ext, timeout, signal);
			if (converted.ok) {
				if (converted.content.trim().length > 50) {
					notes.push("Converted with markit");
					const output = finalizeOutput(converted.content);
					return {
						url,
						finalUrl,
						contentType: mime,
						method: "markit",
						content: output,
						fetchedAt,
						truncated: false,
						notes,
					};
				}
				notes.push("markit conversion produced no usable output");
			} else if (converted.error) {
				notes.push(`markit conversion failed: ${converted.error}`);
			} else {
				notes.push("markit conversion failed");
			}
		} else if (binary.error) {
			notes.push(`Binary fetch failed: ${binary.error}`);
		} else {
			notes.push("Binary fetch failed");
		}
	}

	const binaryPayloadResult = await tryRenderBinaryPayload(
		url,
		finalUrl,
		mime,
		extHint,
		rawContent,
		response.bodySkipped === true,
		timeout,
		signal,
		fetchedAt,
		notes,
		convertibleBinary,
	);
	if (typeof binaryPayloadResult === "string") {
		rawContent = binaryPayloadResult;
		sourceTruncated = false;
	} else if (binaryPayloadResult) return binaryPayloadResult;

	const isHtml = mime.includes("html") || mime.includes("xhtml");
	const isJson = mime.includes("json");
	const isXml = mime.includes("xml") && !isHtml;
	const isText = mime.includes("text/plain") || mime.includes("text/markdown");
	const isFeed = mime.includes("rss") || mime.includes("atom") || mime.includes("feed");

	if (isJson) {
		const output = finalizeOutput(formatJson(rawContent));
		return {
			url,
			finalUrl,
			contentType: mime,
			method: "json",
			content: output,
			fetchedAt,
			truncated: sourceTruncated,
			notes,
		};
	}

	if (isFeed || (isXml && (rawContent.includes("<rss") || rawContent.includes("<feed")))) {
		const parsed = await parseFeedToMarkdown(rawContent);
		const output = finalizeOutput(parsed ?? rawContent);
		return {
			url,
			finalUrl,
			contentType: mime,
			method: "feed",
			content: output,
			fetchedAt,
			truncated: sourceTruncated,
			notes,
		};
	}

	if (isText && !looksLikeHtml(rawContent)) {
		const output = finalizeOutput(rawContent);
		return {
			url,
			finalUrl,
			contentType: mime,
			method: "text",
			content: output,
			fetchedAt,
			truncated: sourceTruncated,
			notes,
		};
	}

	if (isHtml && !raw) {
		const alternates = parseAlternateLinks(rawContent, finalUrl);
		const markdownAlt = alternates.find(alt => alt.kind === "markdown");
		if (markdownAlt) {
			const resolved = new URL(markdownAlt.href, finalUrl).href;
			const altResult = await loadPage(resolved, { timeout, signal });
			if (altResult.ok && altResult.content.trim().length > 100 && !looksLikeHtml(altResult.content)) {
				notes.push(`Used markdown alternate: ${resolved}`);
				const output = finalizeOutput(altResult.content);
				return {
					url,
					finalUrl: altResult.finalUrl,
					contentType: "text/markdown",
					method: "alternate-markdown",
					content: output,
					fetchedAt,
					truncated: Boolean(altResult.truncated),
					notes,
				};
			}
		}

		const negotiated = await tryContentNegotiation(url, timeout, signal);
		if (negotiated) {
			notes.push(`Content negotiation returned ${negotiated.type}`);
			const output = finalizeOutput(negotiated.content);
			return {
				url,
				finalUrl: negotiated.finalUrl,
				contentType: normalizeMime(negotiated.type),
				method: "content-negotiation",
				content: output,
				fetchedAt,
				truncated: Boolean(negotiated.truncated),
				notes,
			};
		}

		const feedAlternates = alternates.filter(alt => alt.kind === "feed");
		const tryFeedAlternate = async (pageContent: string): Promise<FetchRenderResult | null> => {
			for (const altUrl of feedAlternates.slice(0, 2)) {
				const resolved = new URL(altUrl.href, finalUrl).href;
				const altResult = await loadPage(resolved, { timeout, signal });
				if (!altResult.ok) continue;
				const parsed = await parseFeedToMarkdown(altResult.content);
				if (!parsed || parsed.trim().length <= pageContent.trim().length) continue;
				notes.push(`Used feed alternate: ${resolved}`);
				const output = finalizeOutput(parsed);
				return {
					url,
					finalUrl: altResult.finalUrl,
					contentType: "application/feed",
					method: "alternate-feed",
					content: output,
					fetchedAt,
					truncated: Boolean(altResult.truncated),
					notes,
				};
			}
			return null;
		};

		if (signal?.aborted) {
			throw new ToolAbortError();
		}

		const htmlResult = await renderHtmlToText(
			finalUrl,
			rawContent,
			timeout,
			settings,
			signal,
			storage,
			fetchOverride,
		);
		if (!htmlResult.ok) {
			notes.push("html rendering failed (no reader backend produced usable output)");

			const feedResult = await tryFeedAlternate("");
			if (feedResult) return feedResult;

			const llmResult = await tryLlmEndpoints(finalUrl, timeout, signal);
			if (llmResult) {
				notes.push(`Used llms.txt fallback: ${llmResult.endpoint}`);
				const output = finalizeOutput(llmResult.content);
				return {
					url,
					finalUrl: llmResult.finalUrl,
					contentType: "text/plain",
					method: "llms.txt",
					content: output,
					fetchedAt,
					truncated: Boolean(llmResult.truncated),
					notes,
				};
			}

			const output = finalizeOutput(rawContent);
			return {
				url,
				finalUrl,
				contentType: mime,
				method: "raw-html",
				content: output,
				fetchedAt,
				truncated: sourceTruncated,
				notes,
			};
		}

		const lowQuality = isLowQualityOutput(htmlResult.content, htmlResult.method);
		const wrapper =
			isMostlyShortLines(htmlResult.content) && htmlResult.content.split("\n").length <= FETCH_DEFAULT_MAX_LINES;
		if (lowQuality || wrapper) {
			let docLinks = await extractDocumentLinks(rawContent, finalUrl);
			if (!lowQuality) {
				const retained = renderedLinkTargets(htmlResult.content, finalUrl);
				docLinks = docLinks.filter(link => retained.has(link));
			}
			if (docLinks.length > 0) {
				const docUrl = docLinks[0];
				const binary = await fetchBinaryPayload(docUrl, timeout, signal);
				if (binary.ok) {
					const ext = getExtensionHint(docUrl, binary.contentDisposition);
					const converted = await convertWithMarkitPayload(binary.buffer, ext, timeout, signal);
					if (converted.ok && converted.content.trim().length > htmlResult.content.length) {
						notes.push(`Extracted and converted document: ${docUrl}`);
						const output = finalizeOutput(converted.content);
						return {
							url,
							finalUrl: docUrl,
							contentType: "application/document",
							method: "extracted-document",
							content: output,
							fetchedAt,
							truncated: false,
							notes,
						};
					}
					if (!converted.ok && converted.error) {
						notes.push(`markit conversion failed: ${converted.error}`);
					}
				} else if (binary.error) {
					notes.push(`Binary fetch failed: ${binary.error}`);
				}
			}
		}
		if (lowQuality) {
			const feedResult = await tryFeedAlternate(htmlResult.content);
			if (feedResult) return feedResult;

			const llmResult = await tryLlmEndpoints(finalUrl, timeout, signal);
			if (llmResult) {
				notes.push(`Used llms.txt fallback: ${llmResult.endpoint}`);
				const output = finalizeOutput(llmResult.content);
				return {
					url,
					finalUrl: llmResult.finalUrl,
					contentType: "text/plain",
					method: "llms.txt",
					content: output,
					fetchedAt,
					truncated: Boolean(llmResult.truncated),
					notes,
				};
			}

			notes.push("Page appears to require JavaScript or is mostly navigation");
		}

		const output = finalizeOutput(
			htmlResult.method === "native" ? pruneFrontMatter(htmlResult.content) : htmlResult.content,
		);
		return {
			url,
			finalUrl,
			contentType: mime,
			method: htmlResult.method,
			content: output,
			fetchedAt,
			truncated: sourceTruncated,
			notes,
		};
	}

	const output = finalizeOutput(rawContent);
	return {
		url,
		finalUrl,
		contentType: mime,
		method: "raw",
		content: output,
		fetchedAt,
		truncated: sourceTruncated,
		notes,
	};
}

export interface ReadUrlToolDetails {
	raw?: boolean;
	kind: "url";
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	truncated: boolean;
	notes: string[];
	meta?: OutputMeta;
}

interface ReadUrlEntry {
	artifactId?: string;
	artifactPath?: string;
	details: ReadUrlToolDetails;
	image?: FetchImagePayload;
	output: string;
	content: string;
}

async function findArtifactPath(session: ToolSession, artifactId: string): Promise<string | null> {
	const artifactsDir = session.getArtifactsDir?.();
	if (!artifactsDir) return null;

	try {
		const files = await fs.readdir(artifactsDir);
		const match = files.find(file => file.startsWith(`${artifactId}.`));
		return match ? path.join(artifactsDir, match) : null;
	} catch {
		return null;
	}
}

async function persistReadUrlArtifact(
	session: ToolSession,
	output: string,
): Promise<{ id?: string; path?: string } | undefined> {
	const artifact = await session.allocateOutputArtifact?.("read");
	if (!artifact?.path) return undefined;
	await Bun.write(artifact.path, output);
	return artifact;
}

async function ensureReadUrlArtifact(session: ToolSession, entry: ReadUrlEntry): Promise<ReadUrlEntry> {
	if (entry.artifactId && entry.artifactPath) return entry;
	if (entry.artifactId) {
		const artifactPath = await findArtifactPath(session, entry.artifactId);
		if (artifactPath) return { ...entry, artifactPath };
	}
	const artifact = await persistReadUrlArtifact(session, entry.output);
	return artifact?.id ? { ...entry, artifactId: artifact.id, artifactPath: artifact.path } : entry;
}

export async function fetchReadUrl(
	session: ToolSession,
	params: { path: string; raw?: boolean },
	signal?: AbortSignal,
	options?: { ensureArtifact?: boolean },
): Promise<ReadUrlEntry> {
	const { path: url, raw = false } = params;

	const effectiveTimeout = clampTimeout("fetch", 30, session.settings.get("tools.maxTimeout"));

	if (signal?.aborted) {
		throw new ToolAbortError();
	}

	const storage = session.settings.getStorage();
	const { webpExclusionForModel } = await import("../utils/image-loading");
	const result = await renderUrl(
		url,
		effectiveTimeout,
		raw,
		session.settings,
		signal,
		storage,
		session.fetch,
		webpExclusionForModel(session.getActiveModel?.()),
	);
	if (result.failure) throw fetchFailureError(url, result);
	if (result.truncated)
		result.notes.push(
			`Response body exceeded ${formatBytes(MAX_BYTES)} and was cut mid-stream; content is incomplete`,
		);
	const output = raw ? result.content : buildUrlReadOutput(result, result.content);
	const artifact = options?.ensureArtifact ? await persistReadUrlArtifact(session, output) : undefined;

	return {
		artifactId: artifact?.id,
		artifactPath: artifact?.path,
		details: {
			kind: "url",
			raw,
			url: result.url,
			finalUrl: result.finalUrl,
			contentType: result.contentType,
			method: result.method,
			truncated: Boolean(result.truncated),
			notes: result.notes,
		},
		image: result.image,
		output,
		content: result.content,
	};
}

const FETCH_FAILURE_BODY_CHARS = 500;

/** Turn a failed request into a tool error that names the status, the URL and what the server sent. */
function fetchFailureError(requestedUrl: string, result: FetchRenderResult): ToolError {
	const failure = result.failure ?? {};
	const where =
		result.finalUrl && result.finalUrl !== requestedUrl
			? `${requestedUrl} (redirected to ${result.finalUrl})`
			: requestedUrl;
	const status = failure.status !== undefined ? ` (HTTP ${failure.status})` : "";
	const cause = failure.error ? `: ${failure.error}` : "";
	const body = result.content.trim();
	const excerpt =
		body.length === 0
			? ""
			: `\nBody: ${body.length > FETCH_FAILURE_BODY_CHARS ? `${body.slice(0, FETCH_FAILURE_BODY_CHARS)}…` : body}`;
	return new ToolError(`Failed to fetch ${where}${status}${cause}${excerpt}`);
}

function buildUrlReadOutput(result: FetchRenderResult, content: string): string {
	let output = "";
	output += `URL: ${result.finalUrl}\n`;
	output += `Content-Type: ${result.contentType}\n`;
	output += `Method: ${result.method}\n`;
	if (result.notes.length > 0) {
		output += `Notes: ${result.notes.join("; ")}\n`;
	}
	output += `\n---\n\n`;
	output += content;
	return output;
}

export async function executeReadUrl(
	session: ToolSession,
	params: { path: string; raw?: boolean },
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadUrlToolDetails>> {
	let entry = await fetchReadUrl(session, params, signal);
	let truncation = truncateHead(entry.output, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: FETCH_DEFAULT_MAX_LINES,
	});
	if (truncation.firstLineExceedsLimit) {
		const preview = truncateHeadBytes(entry.output, DEFAULT_MAX_BYTES);
		const newline = entry.output.indexOf("\n");
		truncation = {
			...truncation,
			content: preview.text,
			totalBytes: Buffer.byteLength(newline === -1 ? entry.output : entry.output.slice(0, newline), "utf-8"),
			outputLines: preview.bytes > 0 ? 1 : 0,
			outputBytes: preview.bytes,
		};
	}
	const needsArtifact = truncation.truncated;
	if (needsArtifact && !entry.artifactId) {
		entry = await ensureReadUrlArtifact(session, entry);
	}
	const output = needsArtifact ? truncation.content : entry.output;
	const details: ReadUrlToolDetails = {
		...entry.details,
		truncated: Boolean(entry.details.truncated || needsArtifact),
	};

	const contentBlocks: Array<TextContent | ImageContent> = [{ type: "text", text: output }];
	if (entry.image) {
		contentBlocks.push({ type: "image", data: entry.image.data, mimeType: entry.image.mimeType });
	}

	const resultBuilder = toolResult(details).content(contentBlocks).sourceUrl(details.finalUrl);
	if (needsArtifact) {
		resultBuilder.truncation(truncation, { direction: "head", artifactId: entry.artifactId });
	}

	return resultBuilder.done();
}

function countNonEmptyLines(text: string): number {
	return text.split("\n").filter(l => l.trim()).length;
}

function readUrlLinkTarget(input: string): string {
	try {
		return parseReadUrlTarget(input)?.path ?? input;
	} catch {
		return input;
	}
}

function formatReadUrlDescription(input: string): string {
	const target = readUrlLinkTarget(input);
	const displayUrl = target.match(/^www\./i) ? `https://${target}` : target;
	const domain = getDomain(displayUrl);
	const urlPath = truncate(displayUrl.replace(/^https?:\/\/[^/]+/, ""), 50, "…");
	const label = `${domain}${urlPath ? ` ${urlPath}` : ""}`.trim();
	return urlHyperlink(target, label);
}

function formatReadUrlMetadataValue(url: string, uiTheme: Theme): string {
	return urlHyperlink(url, uiTheme.fg("mdLinkUrl", url));
}

export function renderReadUrlCall(
	args: { path?: string; url?: string; raw?: boolean },
	_options: RenderResultOptions,
	uiTheme: Theme = theme,
): Component {
	const url = args.path ?? args.url ?? "";
	const description = formatReadUrlDescription(url);
	const meta: string[] = [];
	if (args.raw) meta.push("raw");
	const text = renderStatusLine({ icon: "pending", title: "Read", description, meta }, uiTheme);
	return new Text(text, 0, 0);
}

export function renderReadUrlResult(
	result: { content: Array<{ type: string; text?: string }>; details?: ReadUrlToolDetails; isError?: boolean },
	options: RenderResultOptions,
	uiTheme: Theme = theme,
): Component {
	const details = result.details;

	if (result.isError || !details) {
		const rawErrorText = result.content?.find(c => c.type === "text")?.text ?? "";
		const errorText = (rawErrorText || "No response data").replace(/^Error:\s*/, "");
		const urlText = details?.finalUrl ?? details?.url ?? "";
		const description = urlText ? formatReadUrlDescription(urlText) : undefined;
		const header = renderStatusLine({ icon: "error", title: "Read", description }, uiTheme);
		const errorLines = sanitizeDisplayLines(errorText).map(line => uiTheme.fg("error", line));
		const outputBlock = new CachedOutputBlock();
		return markFramedBlockComponent({
			render: (width: number) =>
				outputBlock.render({ header, state: "error", sections: [{ lines: errorLines }], width }, uiTheme),
			invalidate: () => outputBlock.invalidate(),
		});
	}

	const description = formatReadUrlDescription(details.finalUrl);
	const hasRedirect = details.url !== details.finalUrl;
	const hasNotes = details.notes.length > 0;
	const truncation = details.meta?.truncation;
	const truncated = Boolean(details.truncated || truncation);

	const header = renderStatusLine(
		{
			icon: truncated ? "warning" : "success",
			title: "Read",
			description,
		},
		uiTheme,
	);

	const contentText = result.content[0]?.text ?? "";
	const contentBody =
		!details.raw && contentText.includes("---\n\n")
			? contentText.split("---\n\n").slice(1).join("---\n\n")
			: contentText;
	const lineCount = countNonEmptyLines(contentBody);
	const charCount = contentBody.trim().length;
	const contentLines = contentBody.split("\n").filter(l => l.trim());

	const metadataLines: string[] = [
		`${uiTheme.fg("muted", "Content-Type:")} ${details.contentType || "unknown"}`,
		`${uiTheme.fg("muted", "Method:")} ${details.method}`,
	];
	if (hasRedirect) {
		metadataLines.push(
			`${uiTheme.fg("muted", "Final URL:")} ${formatReadUrlMetadataValue(details.finalUrl, uiTheme)}`,
		);
	}
	const lineLabel = `${lineCount} line${lineCount === 1 ? "" : "s"}`;
	metadataLines.push(`${uiTheme.fg("muted", "Lines:")} ${lineLabel}`);
	metadataLines.push(`${uiTheme.fg("muted", "Chars:")} ${charCount}`);
	if (truncated) {
		metadataLines.push(uiTheme.fg("warning", `${uiTheme.status.warning} Output truncated`));
		if (truncation?.artifactId) metadataLines.push(formatStyledArtifactReference(truncation.artifactId, uiTheme));
	}
	if (hasNotes) {
		metadataLines.push(`${uiTheme.fg("muted", "Notes:")} ${details.notes.join("; ")}`);
	}

	const outputBlock = new CachedOutputBlock();
	let lastExpanded: boolean | undefined;
	let contentPreviewLines: string[] | undefined;

	return markFramedBlockComponent({
		render: (width: number) => {
			const { expanded } = options;

			if (contentPreviewLines === undefined || lastExpanded !== expanded) {
				const previewLimit = expanded ? Number.POSITIVE_INFINITY : 3;
				const previewList = applyListLimit(contentLines, { headLimit: previewLimit });
				const previewLines = previewList.items.flatMap(sanitizeDisplayLines).map(line => line.trimEnd());
				const remaining = Math.max(0, contentLines.length - previewList.items.length);
				contentPreviewLines =
					previewLines.length > 0
						? previewLines.map(line => uiTheme.fg("dim", line))
						: [uiTheme.fg("dim", "(no content)")];
				if (remaining > 0) {
					const hint = formatExpandHint(uiTheme, expanded, true);
					contentPreviewLines.push(uiTheme.fg("muted", `… ${remaining} more lines${hint ? ` ${hint}` : ""}`));
				}
				lastExpanded = expanded;
				outputBlock.invalidate();
			}

			return outputBlock.render(
				{
					header,
					state: truncated ? "warning" : "success",
					sections: [
						{ label: uiTheme.fg("toolTitle", "Metadata"), lines: metadataLines },
						{ label: uiTheme.fg("toolTitle", "Content Preview"), lines: contentPreviewLines },
					],
					width,
				},
				uiTheme,
			);
		},
		invalidate: () => {
			outputBlock.invalidate();
			contentPreviewLines = undefined;
			lastExpanded = undefined;
		},
	});
}
