import * as dns from "node:dns/promises";
import { scheduler } from "node:timers/promises";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ptree } from "@oh-my-pi/pi-utils";
import type TurndownService from "@oh-my-pi/pi-utils/turndown";

import type { AgentStorage } from "../../session/agent-storage";
import { ToolAbortError } from "../../tools/tool-errors";

export { formatNumber } from "@oh-my-pi/pi-utils";

export interface RenderResult {
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	content: string;
	fetchedAt: string;
	truncated: boolean;
	notes: string[];
}

export type SpecialHandler = (
	url: string,
	timeout: number,
	signal?: AbortSignal,
	storage?: AgentStorage | null,
) => Promise<RenderResult | null>;

export const MAX_OUTPUT_CHARS = 500_000;
export const MAX_BYTES = 50 * 1024 * 1024;

const USER_AGENTS = [
	"curl/8.0",
	"Mozilla/5.0 (compatible; TextBot/1.0)",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

function isBotBlocked(status: number, content: string): boolean {
	if (status === 403 || status === 503) {
		const lower = content.toLowerCase();
		return (
			lower.includes("cloudflare") ||
			lower.includes("captcha") ||
			lower.includes("challenge") ||
			lower.includes("blocked") ||
			lower.includes("access denied") ||
			lower.includes("bot detection")
		);
	}
	return false;
}

export function finalizeOutput(content: string): { content: string; truncated: boolean } {
	const cleaned = content.replace(/\n{3,}/g, "\n\n").trim();
	const truncated = cleaned.length > MAX_OUTPUT_CHARS;
	return {
		content: cleaned.slice(0, MAX_OUTPUT_CHARS),
		truncated,
	};
}

interface LoadPageOptions {
	timeout?: number;
	headers?: Record<string, string>;
	method?: string;
	body?: string;
	maxBytes?: number;
	signal?: AbortSignal;
	fetch?: FetchImpl;
	/** Explicitly permits a private initial URL and same-origin private redirects. */
	allowPrivateNetwork?: boolean;

	skipBodyForContentType?: (contentType: string) => boolean;
}

interface LoadPageResult {
	content: string;
	contentType: string;
	finalUrl: string;
	ok: boolean;
	status?: number;

	truncated?: boolean;

	error?: string;

	bodySkipped?: boolean;
}

const RETRY_AFTER_MAX_MS = 10_000;

function parseRetryAfterMs(value: string | null): number {
	if (!value) return 1_000;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, RETRY_AFTER_MAX_MS);
	const date = Date.parse(value);
	if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), RETRY_AFTER_MAX_MS);
	return 1_000;
}

function charsetFromContentType(header: string): string | undefined {
	return /charset\s*=\s*"?([\w-]+)"?/i.exec(header)?.[1];
}

function decodeBody(bytes: Uint8Array, contentTypeHeader: string): string {
	let label = charsetFromContentType(contentTypeHeader);
	if (!label) {
		label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(
			new TextDecoder("latin1" as Bun.Encoding).decode(bytes.subarray(0, 2048)),
		)?.[1];
	}
	if (label && !/^utf-?8$/i.test(label)) {
		try {
			return new TextDecoder(label as Bun.Encoding).decode(bytes);
		} catch {}
	}
	return new TextDecoder().decode(bytes);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;
const PRIVATE_NETWORK_ESCAPE_HATCH = "PROTO_ALLOW_PRIVATE_NETWORK";

interface ParsedIpv4 {
	readonly octets: readonly [number, number, number, number];
}

function parseIpv4(hostname: string): ParsedIpv4 | undefined {
	const parts = hostname.split(".");
	if (parts.length !== 4) return undefined;
	const octets = parts.map(part => Number(part));
	if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
	return { octets: octets as [number, number, number, number] };
}

function isReservedIpv4({ octets: [a, b, c] }: ParsedIpv4): boolean {
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0 && c === 0) ||
		(a === 192 && b === 0 && c === 2) ||
		(a === 192 && b === 88 && c === 99) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	);
}

function parseIpv6(hostname: string): bigint | undefined {
	let value = hostname.toLowerCase();
	if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
	const ipv4Match = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(value);
	if (ipv4Match) {
		const ipv4 = parseIpv4(ipv4Match[1]);
		if (!ipv4) return undefined;
		const [a, b, c, d] = ipv4.octets;
		value = `${value.slice(0, -ipv4Match[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}

	const halves = value.split("::");
	if (halves.length > 2) return undefined;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
	const groups = halves.length === 2 ? [...left, ...Array.from({ length: missing }, () => "0"), ...right] : left;
	if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;

	let parsed = 0n;
	for (const group of groups) parsed = (parsed << 16n) | BigInt(`0x${group}`);
	return parsed;
}

function isReservedIpv6(value: bigint): boolean {
	if (value <= 1n || value >> 32n === 0n) return true;
	if (value >> 32n === 0xffff_ffff_ffff_ffff_ffff_ffffn) {
		const ipv4 = Number(value & 0xffff_ffffn);
		return isReservedIpv4({
			octets: [(ipv4 >>> 24) & 0xff, (ipv4 >>> 16) & 0xff, (ipv4 >>> 8) & 0xff, ipv4 & 0xff],
		});
	}
	const firstByte = Number(value >> 120n);
	const firstTenBits = Number(value >> 118n);
	const first16Bits = Number(value >> 112n);
	return (
		(firstByte & 0xfe) === 0xfc || // unique local (fc00::/7)
		firstTenBits === 0x3fa || // link local (fe80::/10)
		firstByte === 0xff || // multicast (ff00::/8)
		value >> 96n === 0x20010db8n || // documentation (2001:db8::/32)
		value >> 96n === 0x20010000n || // protocol assignments (2001::/32)
		first16Bits === 0x2002 || // 6to4 (2002::/16)
		first16Bits === 0x3fff || // documentation (3fff::/20)
		value >> 112n === 0x100n // discard-only (100::/64)
	);
}

function isReservedNetworkAddress(rawHostname: string): boolean {
	const hostname = rawHostname
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "")
		.toLowerCase();
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal") ||
		hostname.endsWith(".home.arpa")
	) {
		return true;
	}
	const ipv4 = parseIpv4(hostname);
	if (ipv4) return isReservedIpv4(ipv4);
	const ipv6 = parseIpv6(hostname);
	return ipv6 !== undefined && isReservedIpv6(ipv6);
}

function privateNetworkEscapeHatchEnabled(options: LoadPageOptions): boolean {
	return options.allowPrivateNetwork === true || Bun.env[PRIVATE_NETWORK_ESCAPE_HATCH] === "1";
}

/**
 * A private destination the caller named directly is intent: reading a local dev server is a normal thing
 * to ask for. A private destination arrived at by REDIRECT is the SSRF vector, because the hop was chosen
 * by the remote server rather than the user — so that is refused unless it stays on the private origin the
 * request already started from.
 */
async function validateNetworkTarget(
	url: string,
	allowPrivateNetwork: boolean,
	isInitialRequest: boolean,
	allowedPrivateOrigin?: string,
): Promise<{ ok: true; privateOrigin?: string } | { ok: false; error: string }> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, error: `Invalid URL: ${url}` };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, error: `Unsupported URL protocol: ${parsed.protocol}` };
	}
	if (parsed.username || parsed.password) {
		return { ok: false, error: "URL credentials are not allowed" };
	}

	const hostname = parsed.hostname;
	const hostnameIsReserved = isReservedNetworkAddress(hostname);
	let addresses: string[] = [];
	if (!hostnameIsReserved) {
		try {
			addresses = (await dns.lookup(hostname, { all: true, verbatim: true })).map(address => address.address);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return { ok: false, error: `Could not resolve ${hostname}: ${detail}` };
		}
	}
	const resolvesToReserved = addresses.some(address => isReservedNetworkAddress(address));
	const isPrivate = hostnameIsReserved || resolvesToReserved;
	if (!isPrivate) return { ok: true };
	if (isInitialRequest || allowPrivateNetwork) {
		if (allowedPrivateOrigin && parsed.origin !== allowedPrivateOrigin) {
			return { ok: false, error: `Refusing private-network redirect outside ${allowedPrivateOrigin}` };
		}
		return { ok: true, privateOrigin: allowedPrivateOrigin ?? parsed.origin };
	}
	return {
		ok: false,
		error: `Refusing to follow a redirect into a private or reserved network address: ${hostname} (set ${PRIVATE_NETWORK_ESCAPE_HATCH}=1 to explicitly allow it)`,
	};
}

export interface ReadResponseBytesResult {
	bytes: Uint8Array;
	truncated: boolean;
}

/** Read a response body without trusting its Content-Length header. */
export async function readResponseBytes(response: Response, maxBytes: number): Promise<ReadResponseBytesResult> {
	const limit = Number.isFinite(maxBytes) && maxBytes >= 0 ? Math.floor(maxBytes) : MAX_BYTES;
	if (!response.body) return { bytes: new Uint8Array(), truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			if (total + value.byteLength > limit) {
				const accepted = Math.max(0, limit - total);
				if (accepted > 0) {
					chunks.push(value.subarray(0, accepted));
					total += accepted;
				}
				truncated = true;
				await reader.cancel("response body limit exceeded").catch(() => {});
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated };
}

export async function readResponseText(response: Response, maxBytes: number): Promise<string | null> {
	const result = await readResponseBytes(response, maxBytes);
	if (result.truncated) return null;
	return new TextDecoder().decode(result.bytes);
}

export async function loadPage(url: string, options: LoadPageOptions = {}): Promise<LoadPageResult> {
	const {
		timeout = 20,
		headers = {},
		maxBytes = MAX_BYTES,
		signal,
		method = "GET",
		body,
		fetch: fetchImpl = fetch,
	} = options;
	const allowPrivateNetwork = privateNetworkEscapeHatchEnabled(options);

	let lastError: string | undefined;
	let retried429 = false;
	for (let attempt = 0; attempt < USER_AGENTS.length; attempt++) {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}

		const userAgent = USER_AGENTS[attempt];
		const requestSignal = ptree.combineSignals(signal, timeout * 1000);
		let currentUrl = url;
		let currentMethod = method;
		let currentBody = body;
		let privateOrigin: string | undefined;

		try {
			for (let redirect = 0; ; redirect++) {
				const target = await validateNetworkTarget(currentUrl, allowPrivateNetwork, redirect === 0, privateOrigin);
				if (!target.ok) {
					return { content: "", contentType: "", finalUrl: currentUrl, ok: false, error: target.error };
				}
				privateOrigin = target.privateOrigin ?? privateOrigin;

				const requestInit: RequestInit = {
					signal: requestSignal,
					method: currentMethod,
					headers: {
						"User-Agent": userAgent,
						Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
						"Accept-Language": "en-US,en;q=0.5",
						"Accept-Encoding": "identity",
						...headers,
					},
					redirect: "manual",
				};

				if (currentBody !== undefined) requestInit.body = currentBody;

				const response = await fetchImpl(currentUrl, requestInit);
				const observedUrl = response.url || currentUrl;
				if (observedUrl !== currentUrl) {
					const observedTarget = await validateNetworkTarget(
						observedUrl,
						allowPrivateNetwork,
						false,
						privateOrigin,
					);
					if (!observedTarget.ok) {
						await response.body?.cancel().catch(() => {});
						return {
							content: "",
							contentType: "",
							finalUrl: observedUrl,
							ok: false,
							error: observedTarget.error,
						};
					}
					privateOrigin = observedTarget.privateOrigin ?? privateOrigin;
					currentUrl = observedUrl;
				}

				const rawContentType = response.headers.get("content-type") ?? "";
				const contentType = rawContentType.split(";")[0]?.trim().toLowerCase() ?? "";

				if (REDIRECT_STATUSES.has(response.status)) {
					const location = response.headers.get("location");
					if (!location) {
						await response.body?.cancel().catch(() => {});
						return { content: "", contentType, finalUrl: currentUrl, ok: false, status: response.status };
					}
					if (redirect >= MAX_REDIRECTS) {
						await response.body?.cancel().catch(() => {});
						return {
							content: "",
							contentType,
							finalUrl: currentUrl,
							ok: false,
							status: response.status,
							error: `Too many redirects (limit ${MAX_REDIRECTS})`,
						};
					}
					try {
						currentUrl = new URL(location, currentUrl).href;
					} catch {
						await response.body?.cancel().catch(() => {});
						return {
							content: "",
							contentType,
							finalUrl: currentUrl,
							ok: false,
							status: response.status,
							error: "Invalid redirect URL",
						};
					}
					await response.body?.cancel().catch(() => {});
					if (
						response.status === 303 ||
						((response.status === 301 || response.status === 302) &&
							currentMethod !== "GET" &&
							currentMethod !== "HEAD")
					) {
						currentMethod = "GET";
						currentBody = undefined;
					}
					continue;
				}

				if (response.status === 429 && !retried429) {
					retried429 = true;
					const delayMs = parseRetryAfterMs(response.headers.get("retry-after"));
					void response.body?.cancel().catch(() => {});
					try {
						await scheduler.wait(delayMs, { signal });
					} catch {
						throw new ToolAbortError();
					}
					continue;
				}

				if (response.ok && options.skipBodyForContentType?.(contentType)) {
					void response.body?.cancel().catch(() => {});
					return {
						content: "",
						contentType,
						finalUrl: currentUrl,
						ok: true,
						status: response.status,
						bodySkipped: true,
					};
				}

				if (!response.body) {
					return { content: "", contentType, finalUrl: currentUrl, ok: false, status: response.status };
				}

				const { bytes: bodyBytes, truncated } = await readResponseBytes(response, maxBytes);
				const content = decodeBody(bodyBytes, rawContentType);

				if (isBotBlocked(response.status, content) && attempt < USER_AGENTS.length - 1) {
					break;
				}

				if (!response.ok) {
					return { content, contentType, finalUrl: currentUrl, ok: false, status: response.status, truncated };
				}

				return { content, contentType, finalUrl: currentUrl, ok: true, status: response.status, truncated };
			}
		} catch (error) {
			if (signal?.aborted) {
				throw new ToolAbortError();
			}
			lastError = error instanceof Error ? error.message : String(error);
			if (attempt === USER_AGENTS.length - 1) {
				return { content: "", contentType: "", finalUrl: currentUrl, ok: false, error: lastError };
			}
		}
	}

	return { content: "", contentType: "", finalUrl: url, ok: false, error: lastError };
}

let turndownPromise: Promise<TurndownService> | undefined;

function getTurndown(): Promise<TurndownService> {
	turndownPromise ||= initTurndown();
	return turndownPromise;
}

async function initTurndown(): Promise<TurndownService> {
	const { createTurndown } = await import("../../utils/turndown");
	return createTurndown();
}

export async function htmlToBasicMarkdown(html: string): Promise<string> {
	const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
	const turndown = await getTurndown();
	return turndown.turndown(cleaned).trim();
}

export function buildResult(
	md: string,
	opts: { url: string; finalUrl?: string; method: string; fetchedAt: string; notes?: string[]; contentType?: string },
): RenderResult {
	const output = finalizeOutput(md);
	return {
		url: opts.url,
		finalUrl: opts.finalUrl ?? opts.url,
		contentType: opts.contentType ?? "text/markdown",
		method: opts.method,
		content: output.content,
		fetchedAt: opts.fetchedAt,
		truncated: output.truncated,
		notes: opts.notes ?? [],
	};
}

export function formatIsoDate(value?: string | number | Date): string {
	if (value == null) return "";
	if (typeof value === "string") {
		const datePrefix = value.match(/^\d{4}-\d{2}-\d{2}/);
		if (datePrefix) return datePrefix[0];
	}
	try {
		return new Date(value).toISOString().split("T")[0];
	} catch {
		return "";
	}
}

export function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&#x2F;/g, "/")
		.replace(/&nbsp;/g, " ");
}

export function formatMediaDuration(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const secs = Math.floor(totalSeconds % 60);
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export type LocalizedText = string | Record<string, string | null> | null | undefined;

export function getLocalizedText(value: LocalizedText, defaultLocale?: string): string | undefined {
	if (value == null) return undefined;
	if (typeof value === "string") return value;
	if (defaultLocale && value[defaultLocale]) return value[defaultLocale];
	return (
		value["en-US"] ?? value.en_US ?? value.en ?? Object.values(value).find(v => typeof v === "string") ?? undefined
	);
}

export function looksLikeHtml(content: string): boolean {
	const trimmed = content.trim().toLowerCase();
	return (
		trimmed.startsWith("<!doctype") ||
		trimmed.startsWith("<html") ||
		trimmed.startsWith("<head") ||
		trimmed.startsWith("<body")
	);
}
