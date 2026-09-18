interface MCPHeaderSources {
	generated: Record<string, string>;

	configured?: Record<string, string>;
}

export function mergeMCPHeaders({ generated, configured }: MCPHeaderSources): Record<string, string> {
	if (!configured) return { ...generated };
	const generatedNames = new Set<string>();
	for (const name in generated) generatedNames.add(name.toLowerCase());
	const merged: Record<string, string> = {};
	for (const name in configured) {
		if (!generatedNames.has(name.toLowerCase())) merged[name] = configured[name];
	}
	return { ...merged, ...generated };
}

export function setGeneratedHeader(headers: Record<string, string>, name: string, value: string): void {
	const lower = name.toLowerCase();
	for (const existing in headers) {
		if (existing.toLowerCase() === lower) delete headers[existing];
	}
	headers[name] = value;
}

export function withoutHeader(
	headers: Record<string, string> | undefined,
	name: string,
): Record<string, string> | undefined {
	if (!headers) return headers;
	const lower = name.toLowerCase();
	let hasMatch = false;
	for (const key in headers) {
		if (key.toLowerCase() === lower) {
			hasMatch = true;
			break;
		}
	}
	if (!hasMatch) return headers;
	const result: Record<string, string> = {};
	for (const key in headers) {
		if (key.toLowerCase() !== lower) result[key] = headers[key];
	}
	return result;
}

const REDIRECT_STATUSES: Record<number, true> = { 301: true, 302: true, 303: true, 307: true, 308: true };
const MAX_REDIRECT_HOPS = 5;
const CREDENTIAL_HEADERS: Record<string, true> = {
	authorization: true,
	cookie: true,
	"mcp-session-id": true,
	"proxy-authorization": true,
};

function withoutCredentialHeaders(headers: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const name in headers) {
		if (!CREDENTIAL_HEADERS[name.toLowerCase()]) result[name] = headers[name];
	}
	return result;
}

export type MCPFetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface MCPFetchInit {
	method: "GET" | "POST" | "DELETE";
	body?: string;
	signal?: AbortSignal;
}

export async function mcpFetch(
	url: string,
	init: MCPFetchInit,
	sources: MCPHeaderSources,
	_originLocked: boolean,
	fetchImpl: MCPFetchImpl = fetch,
): Promise<Response> {
	const configuredOrigin = new URL(url).origin;
	let currentUrl = url;
	for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
		const attachConfigured = new URL(currentUrl).origin === configuredOrigin;
		const headers = attachConfigured ? mergeMCPHeaders(sources) : withoutCredentialHeaders(sources.generated);
		const response = await fetchImpl(currentUrl, { ...init, headers, redirect: "manual" });
		if (!REDIRECT_STATUSES[response.status]) return response;

		const location = response.headers.get("Location");
		if (!location) return response;
		await response.body?.cancel();
		if (init.method !== "GET" && response.status !== 307 && response.status !== 308) {
			throw new Error(`HTTP ${response.status}: server redirected a ${init.method} request; refusing to follow`);
		}
		const redirectUrl = new URL(location, currentUrl);
		if (redirectUrl.protocol !== "http:" && redirectUrl.protocol !== "https:") {
			throw new Error(`HTTP ${response.status}: server redirected to a non-HTTP URL; refusing to follow`);
		}
		if (redirectUrl.username || redirectUrl.password) {
			throw new Error(
				`HTTP ${response.status}: server redirected to a URL with embedded credentials; refusing to follow`,
			);
		}
		redirectUrl.hash = "";
		currentUrl = redirectUrl.href;
	}
	throw new Error(`Too many redirects (> ${MAX_REDIRECT_HOPS}) fetching MCP server`);
}
