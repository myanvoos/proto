import { USER_AGENT } from "@oh-my-pi/pi-utils";

export interface InferenceHeaderOptions {
	provider: string;
	protocol: "anthropic" | "google" | "openai";
	sessionId?: string;
	/** Go shared prompt-cache family; other session headers retain the conversation id. */
	cacheAffinity?: string;
}

/** Set a header unless the map already contains that field under any casing. */
export function setHeaderIfAbsent(headers: Record<string, string>, name: string, value: string): void {
	const normalizedName = name.toLowerCase();
	for (const existingName in headers) {
		if (existingName.toLowerCase() === normalizedName) return;
	}
	headers[name] = value;
}

/**
 * Label a request with the conversation id under the model's resolved
 * `compat.sessionHeader` (KDL `session-header`). A header the caller or config
 * already set wins; without a conversation id nothing is sent.
 */
export function applySessionHeader(
	headers: Record<string, string> | Headers,
	compat: object | undefined,
	sessionId: string | undefined,
): void {
	const name = compat && "sessionHeader" in compat ? compat.sessionHeader : undefined;
	if (typeof name !== "string" || !sessionId) return;
	if (headers instanceof Headers) {
		if (!headers.has(name)) headers.set(name, sessionId);
		return;
	}
	setHeaderIfAbsent(headers, name, sessionId);
}

export function mergeHeaders(...headerSources: (Record<string, string> | undefined)[]): Record<string, string> {
	const merged: Record<string, string> = {};
	const keyByLower = new Map<string, string>();
	for (const headers of headerSources) {
		if (!headers) continue;
		for (const [key, value] of Object.entries(headers)) {
			const lower = key.toLowerCase();
			const existing = keyByLower.get(lower);
			if (existing !== undefined && existing !== key) delete merged[existing];
			keyByLower.set(lower, key);
			merged[key] = value;
		}
	}
	return merged;
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
	const normalizedName = name.toLowerCase();
	for (const existingName in headers) {
		if (existingName.toLowerCase() !== normalizedName) continue;
		if (existingName === name && headers[existingName] === value) return;
		delete headers[existingName];
	}
	headers[name] = value;
}

/** Project the authoritative conversation id onto the headers the active protocol and host understand. */
export function applyInferenceHeaders(headers: Record<string, string>, options: InferenceHeaderOptions): void {
	const sessionId = options.sessionId;
	if (!sessionId) return;

	if (options.protocol === "anthropic") {
		setHeader(headers, "X-Claude-Code-Session-Id", sessionId);
	} else if (options.protocol === "openai" && options.provider === "openai") {
		setHeader(headers, "session_id", sessionId);
		setHeader(headers, "x-client-request-id", sessionId);
	}

	// OpenCode Go/Zen reject requests without a per-conversation session header.
	if (options.provider === "opencode-go" || options.provider === "opencode-zen") {
		setHeaderIfAbsent(headers, "User-Agent", USER_AGENT);
		setHeader(
			headers,
			"x-opencode-session",
			options.provider === "opencode-go" ? (options.cacheAffinity ?? sessionId) : sessionId,
		);
	}

	// LiteLLM groups request logs into sessions by this header. It only affects
	// log grouping, so a configured value (e.g. a run id) wins.
	if (options.provider === "litellm") {
		setHeaderIfAbsent(headers, "x-litellm-session-id", sessionId);
	}
}

function isHeaderRecord(headers: RequestInit["headers"]): headers is Record<string, string> {
	return headers !== undefined && !(headers instanceof Headers) && !Array.isArray(headers);
}

/**
 * Return `init` with proto's inference User-Agent default applied per request.
 * Explicit headers (including OAuth client fingerprints) stay authoritative, and
 * plain-object headers stay plain objects for custom `fetch` implementations
 * that index `init.headers` by name.
 */
export function withInferenceUserAgent(
	input: string | URL | Request,
	init: RequestInit | undefined,
): RequestInit | undefined {
	const sourceHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
	if (isHeaderRecord(sourceHeaders)) {
		const headers = { ...sourceHeaders };
		setHeaderIfAbsent(headers, "User-Agent", USER_AGENT);
		return { ...init, headers };
	}
	const headers = new Headers(sourceHeaders);
	if (headers.has("User-Agent")) return init;
	headers.set("User-Agent", USER_AGENT);
	return { ...init, headers };
}
