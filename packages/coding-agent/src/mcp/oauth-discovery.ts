import * as AIError from "@oh-my-pi/pi-ai/error";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { MCPOAuthNetworkTimeoutError, withMCPOAuthNetworkTimeout } from "./oauth-flow";

const DISCOVERY_FETCH_TIMEOUT_MS = 10_000;
const MAX_DISCOVERY_DEPTH = 8;
const MAX_DISCOVERY_FETCHES = 64;
const MAX_DISCOVERY_REDIRECTS = 5;
const DISCOVERY_REDIRECT_STATUSES: Record<number, true> = {
	301: true,
	302: true,
	303: true,
	307: true,
	308: true,
};

interface OAuthDiscoveryOptions {
	fetch?: FetchImpl;
	protectedResource?: string;
	protectedScopes?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

interface OAuthDiscoveryContext {
	fetch: FetchImpl;
	signal?: AbortSignal;
	timeoutMs: number;
	trustedOrigin?: string;
	visitedAuthServers: Set<string>;
	visitedFetchUrls: Set<string>;
	fetchCount: number;
}

function parseIpv4(hostname: string): [number, number, number, number] | undefined {
	const parts = hostname.split(".");
	if (parts.length !== 4) return undefined;
	const octets = parts.map(part => Number(part));
	if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
	return octets as [number, number, number, number];
}

function isPrivateIpv4(octets: [number, number, number, number]): boolean {
	const [a, b, c] = octets;
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
		const [a, b, c, d] = ipv4;
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

function isPrivateIpv6(value: bigint): boolean {
	if (value <= 1n) return true;
	if (value >> 32n === 0xffffn) {
		const ipv4 = Number(value & 0xffff_ffffn);
		return isPrivateIpv4([(ipv4 >>> 24) & 0xff, (ipv4 >>> 16) & 0xff, (ipv4 >>> 8) & 0xff, ipv4 & 0xff]);
	}
	const firstByte = Number(value >> 120n);
	const firstTenBits = Number(value >> 118n);
	return (firstByte & 0xfe) === 0xfc || firstTenBits === 0x3fa || firstByte === 0xff || value >> 96n === 0x20010db8n;
}

function isPrivateNetworkHostname(rawHostname: string): boolean {
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
	if (ipv4) return isPrivateIpv4(ipv4);
	const ipv6 = parseIpv6(hostname);
	return ipv6 !== undefined && isPrivateIpv6(ipv6);
}

function parseDiscoveryUrl(value: string | URL, trustedOrigin?: string, allowTrustedOrigin = false): URL | undefined {
	let url: URL;
	try {
		url = value instanceof URL ? new URL(value) : new URL(value);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (url.username || url.password || url.hash) return undefined;
	if ((!allowTrustedOrigin || url.origin !== trustedOrigin) && isPrivateNetworkHostname(url.hostname))
		return undefined;
	return url;
}

function canonicalizeDiscoveryBase(
	value: string,
	trustedOrigin?: string,
	allowTrustedOrigin = false,
): string | undefined {
	const url = parseDiscoveryUrl(value, trustedOrigin, allowTrustedOrigin);
	if (!url) return undefined;
	const pathname = url.pathname.replace(/\/+$/, "");
	return `${url.origin}${pathname}${url.search}`;
}

function discoveryContext(serverUrl: string, opts: OAuthDiscoveryOptions): OAuthDiscoveryContext {
	let trustedOrigin: string | undefined;
	try {
		trustedOrigin = new URL(serverUrl).origin;
	} catch {}
	return {
		fetch: opts.fetch ?? fetch,
		signal: opts.signal,
		timeoutMs: opts.timeoutMs ?? DISCOVERY_FETCH_TIMEOUT_MS,
		trustedOrigin,
		visitedAuthServers: new Set<string>(),
		visitedFetchUrls: new Set<string>(),
		fetchCount: 0,
	};
}

async function fetchDiscoveryMetadata(
	value: string | URL,
	context: OAuthDiscoveryContext,
	allowTrustedOrigin = false,
): Promise<Record<string, unknown> | null> {
	let current = parseDiscoveryUrl(value, context.trustedOrigin, allowTrustedOrigin);
	if (!current) return null;
	try {
		for (let hop = 0; hop <= MAX_DISCOVERY_REDIRECTS; hop++) {
			const key = current.href;
			if (context.visitedFetchUrls.has(key) || context.fetchCount >= MAX_DISCOVERY_FETCHES) return null;
			context.visitedFetchUrls.add(key);
			context.fetchCount++;
			const requestUrl = current;
			const result = await withMCPOAuthNetworkTimeout(
				"discovery",
				context.timeoutMs,
				context.signal,
				async signal => {
					const response = await context.fetch(requestUrl, {
						method: "GET",
						headers: { Accept: "application/json" },
						redirect: "manual",
						signal,
					});
					if (DISCOVERY_REDIRECT_STATUSES[response.status]) {
						const location = response.headers.get("Location");
						await response.body?.cancel();
						return { kind: "redirect" as const, location };
					}
					if (!response.ok) {
						await response.body?.cancel();
						return { kind: "metadata" as const, metadata: null };
					}
					const payload = await response.json();
					const metadata =
						typeof payload === "object" && payload !== null && !Array.isArray(payload)
							? (payload as Record<string, unknown>)
							: null;
					return { kind: "metadata" as const, metadata };
				},
			);
			if (result.kind === "metadata") return result.metadata;
			if (!result.location) return null;
			current = parseDiscoveryUrl(new URL(result.location, current), context.trustedOrigin, allowTrustedOrigin);
			if (!current) return null;
		}
	} catch (error) {
		if (error instanceof MCPOAuthNetworkTimeoutError) throw error;
	}
	return null;
}

export interface OAuthEndpoints {
	authorizationUrl: string;
	tokenUrl: string;
	clientId?: string;

	registrationUrl?: string;
	scopes?: string;
	resource?: string;
}

function readRegistrationUrl(metadata: Record<string, unknown>): string | undefined {
	const value =
		metadata.registration_endpoint ??
		metadata.registrationEndpoint ??
		metadata.registration_url ??
		metadata.registrationUrl ??
		metadata.registration_uri ??
		metadata.registrationUri;
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export interface AuthDetectionResult {
	requiresAuth: boolean;
	authType?: "oauth" | "apikey" | "unknown";
	oauth?: OAuthEndpoints;
	authServerUrl?: string;
	resourceMetadataUrl?: string;

	scopes?: string;
	message?: string;
}

export function extractMcpAuthServerUrl(error: Error, serverUrl?: string): string | undefined {
	const match = error.message.match(/Mcp-Auth-Server:\s*([^;\]\s]+)/i);
	if (!match?.[1]) return undefined;

	try {
		return new URL(match[1], serverUrl).toString();
	} catch {
		return undefined;
	}
}

export function extractOAuthChallengeScopes(error: Error): string | undefined {
	const entries = error.message.matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]+)"/g);
	for (const [, rawKey, value] of entries) {
		const key = rawKey.toLowerCase();
		if ((key === "scope" || key === "scopes") && value.trim() !== "") {
			return value;
		}
	}
	return undefined;
}

function extractOAuthEndpoints(error: Error): OAuthEndpoints | null {
	const errorMsg = error.message;

	const readEndpointsFromObject = (obj: Record<string, unknown>): OAuthEndpoints | null => {
		const authorizationUrl =
			(obj.authorization_url as string | undefined) ||
			(obj.authorizationUrl as string | undefined) ||
			(obj.authorization_endpoint as string | undefined) ||
			(obj.authorizationEndpoint as string | undefined) ||
			(obj.authorization_uri as string | undefined) ||
			(obj.authorizationUri as string | undefined);
		const tokenUrl =
			(obj.token_url as string | undefined) ||
			(obj.tokenUrl as string | undefined) ||
			(obj.token_endpoint as string | undefined) ||
			(obj.tokenEndpoint as string | undefined) ||
			(obj.token_uri as string | undefined) ||
			(obj.tokenUri as string | undefined);

		if (!authorizationUrl || !tokenUrl) return null;

		const scopeFromArray = Array.isArray(obj.scopes_supported)
			? (obj.scopes_supported as unknown[]).filter(v => typeof v === "string").join(" ")
			: undefined;
		const scopes = (obj.scopes as string | undefined) || (obj.scope as string | undefined) || scopeFromArray;
		const clientId =
			(obj.client_id as string | undefined) ||
			(obj.clientId as string | undefined) ||
			(obj.default_client_id as string | undefined) ||
			(obj.public_client_id as string | undefined);

		const resource =
			(obj.resource as string | undefined) ||
			(obj.resource_uri as string | undefined) ||
			(obj.resourceUri as string | undefined);

		return { authorizationUrl, tokenUrl, registrationUrl: readRegistrationUrl(obj), clientId, scopes, resource };
	};

	const clientIdFromAuthUrl = (authorizationUrl: string): string | undefined => {
		try {
			return new URL(authorizationUrl).searchParams.get("client_id") ?? undefined;
		} catch {
			return undefined;
		}
	};

	const scopeFromAuthUrl = (authorizationUrl: string): string | undefined => {
		try {
			return new URL(authorizationUrl).searchParams.get("scope") ?? undefined;
		} catch {
			return undefined;
		}
	};

	try {
		const jsonMatch = errorMsg.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const errorBody = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

			if (errorBody.oauth || errorBody.authorization || errorBody.auth) {
				const oauthData = (errorBody.oauth || errorBody.authorization || errorBody.auth) as Record<string, unknown>;
				const endpoints = readEndpointsFromObject(oauthData);
				if (endpoints) {
					return {
						...endpoints,
						clientId: endpoints.clientId || clientIdFromAuthUrl(endpoints.authorizationUrl),
						scopes: endpoints.scopes || scopeFromAuthUrl(endpoints.authorizationUrl),
					};
				}
			}

			const topLevelEndpoints = readEndpointsFromObject(errorBody);
			if (topLevelEndpoints) {
				return {
					...topLevelEndpoints,
					clientId: topLevelEndpoints.clientId || clientIdFromAuthUrl(topLevelEndpoints.authorizationUrl),
					scopes: topLevelEndpoints.scopes || scopeFromAuthUrl(topLevelEndpoints.authorizationUrl),
				};
			}
		}
	} catch {}

	const challengeEntries = Array.from(errorMsg.matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]+)"/g));
	if (challengeEntries.length > 0) {
		const challengeValues = new Map<string, string>();
		for (const [, rawKey, value] of challengeEntries) {
			challengeValues.set(rawKey.toLowerCase(), value);
		}

		const authorizationUrl =
			challengeValues.get("authorization_uri") ||
			challengeValues.get("authorization_url") ||
			challengeValues.get("authorization_endpoint") ||
			challengeValues.get("authorize_url") ||
			challengeValues.get("realm");
		const tokenUrl =
			challengeValues.get("token_url") || challengeValues.get("token_uri") || challengeValues.get("token_endpoint");
		const resource = challengeValues.get("resource") || challengeValues.get("resource_uri");

		if (authorizationUrl && tokenUrl) {
			return {
				authorizationUrl,
				tokenUrl,
				registrationUrl:
					challengeValues.get("registration_endpoint") ||
					challengeValues.get("registration_url") ||
					challengeValues.get("registration_uri"),
				clientId: challengeValues.get("client_id") || clientIdFromAuthUrl(authorizationUrl),
				scopes: challengeValues.get("scope") || challengeValues.get("scopes") || scopeFromAuthUrl(authorizationUrl),
				resource,
			};
		}
	}

	const wwwAuthMatch = errorMsg.match(/realm="([^"]+)".*token_url="([^"]+)"/);
	if (wwwAuthMatch) {
		return {
			authorizationUrl: wwwAuthMatch[1],
			tokenUrl: wwwAuthMatch[2],
			clientId: clientIdFromAuthUrl(wwwAuthMatch[1]),
			scopes: scopeFromAuthUrl(wwwAuthMatch[1]),
		};
	}

	return null;
}

export function analyzeAuthError(error: Error, serverUrl?: string): AuthDetectionResult {
	if (!AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)) {
		return { requiresAuth: false };
	}

	const authServerUrl = extractMcpAuthServerUrl(error, serverUrl);

	const resourceMetaMatch = error.message.match(/resource_metadata\s*=\s*"([^"]+)"/i);
	const resourceMetadataUrl = resourceMetaMatch?.[1];

	const oauth = extractOAuthEndpoints(error);
	const challengeScopes = extractOAuthChallengeScopes(error);

	if (oauth) {
		const mergedScopes = oauth.scopes ?? challengeScopes;

		const mergedOAuth: OAuthEndpoints = mergedScopes === oauth.scopes ? oauth : { ...oauth, scopes: mergedScopes };
		return {
			requiresAuth: true,
			authType: "oauth",
			oauth: mergedOAuth,
			authServerUrl,
			resourceMetadataUrl,
			scopes: mergedScopes,
			message: "Server requires OAuth authentication. Launching authorization flow...",
		};
	}

	const errorMsg = error.message.toLowerCase();
	if (
		errorMsg.includes("api key") ||
		errorMsg.includes("api_key") ||
		errorMsg.includes("token") ||
		errorMsg.includes("bearer")
	) {
		return {
			requiresAuth: true,
			authType: "apikey",
			authServerUrl,
			resourceMetadataUrl,
			scopes: challengeScopes,
			message: "Server requires API key authentication.",
		};
	}

	return {
		requiresAuth: true,
		authType: "unknown",
		authServerUrl,
		resourceMetadataUrl,
		scopes: challengeScopes,
		message: "Server requires authentication but type could not be determined.",
	};
}

function normalizeIssuerUrl(value: string): string | undefined {
	try {
		const u = new URL(value);
		const path = u.pathname.replace(/\/+$/, "");
		return `${u.protocol}//${u.host}${path}`;
	} catch {
		return undefined;
	}
}

function issuerMatchesBase(metadataIssuer: unknown, baseUrl: string): boolean {
	if (typeof metadataIssuer !== "string" || !metadataIssuer.trim()) {
		return true;
	}
	const normalizedIssuer = normalizeIssuerUrl(metadataIssuer);
	const normalizedBase = normalizeIssuerUrl(baseUrl);
	if (!normalizedIssuer || !normalizedBase) return true;
	return normalizedIssuer === normalizedBase;
}

function readMetadataScopes(metadata: Record<string, unknown>): string | undefined {
	if (Array.isArray(metadata.scopes_supported)) {
		const joined = metadata.scopes_supported.filter((scope): scope is string => typeof scope === "string").join(" ");
		if (joined) return joined;
	}
	if (typeof metadata.scopes === "string" && metadata.scopes.trim() !== "") return metadata.scopes;
	if (typeof metadata.scope === "string" && metadata.scope.trim() !== "") return metadata.scope;
	return undefined;
}

export async function fetchResourceMetadataScopes(
	resourceMetadataUrl: string,
	opts?: { fetch?: FetchImpl; signal?: AbortSignal; timeoutMs?: number },
): Promise<string | undefined> {
	const context = discoveryContext("", opts ?? {});
	const metadata = await fetchDiscoveryMetadata(resourceMetadataUrl, context);
	return metadata ? readMetadataScopes(metadata) : undefined;
}

export async function discoverOAuthEndpoints(
	serverUrl: string,
	authServerUrl?: string,
	resourceMetadataUrl?: string,
	opts: OAuthDiscoveryOptions = {},
): Promise<OAuthEndpoints | null> {
	return await discoverOAuthEndpointsWithContext(
		serverUrl,
		authServerUrl,
		resourceMetadataUrl,
		{ protectedResource: opts.protectedResource, protectedScopes: opts.protectedScopes },
		discoveryContext(serverUrl, opts),
		0,
	);
}

async function discoverOAuthEndpointsWithContext(
	serverUrl: string,
	authServerUrl: string | undefined,
	resourceMetadataUrl: string | undefined,
	protectedMetadata: { protectedResource?: string; protectedScopes?: string },
	context: OAuthDiscoveryContext,
	depth: number,
): Promise<OAuthEndpoints | null> {
	if (depth > MAX_DISCOVERY_DEPTH) return null;
	const wellKnownPaths = [
		"/.well-known/oauth-authorization-server",
		"/.well-known/openid-configuration",
		"/.well-known/oauth-protected-resource",
		"/oauth/metadata",
		"/.mcp/auth",
		"/authorize",
	];
	const urlsToQuery: Array<{ url: string; issuerCandidate: boolean; allowTrustedOrigin: boolean }> = [];
	let protectedResource = protectedMetadata.protectedResource;
	let protectedScopes = protectedMetadata.protectedScopes;
	const addDiscoveryBase = (value: string | undefined, issuerCandidate: boolean, allowTrustedOrigin = false): void => {
		if (!value) return;
		const canonical = canonicalizeDiscoveryBase(value, context.trustedOrigin, allowTrustedOrigin);
		if (!canonical || context.visitedAuthServers.has(canonical)) return;
		context.visitedAuthServers.add(canonical);
		urlsToQuery.push({ url: canonical, issuerCandidate, allowTrustedOrigin });
	};

	if (resourceMetadataUrl) {
		const metadata = await fetchDiscoveryMetadata(resourceMetadataUrl, context);
		if (metadata) {
			protectedScopes = readMetadataScopes(metadata) ?? protectedScopes;
			if (typeof metadata.resource === "string" && metadata.resource.trim() !== "") {
				protectedResource = metadata.resource;
			}
			const authServers = Array.isArray(metadata.authorization_servers)
				? metadata.authorization_servers.filter((entry): entry is string => typeof entry === "string")
				: [];
			for (const authServer of authServers) addDiscoveryBase(authServer, true);
		}
	}

	addDiscoveryBase(authServerUrl, true);
	addDiscoveryBase(serverUrl, false, true);

	const findEndpoints = (metadata: Record<string, unknown>): OAuthEndpoints | null => {
		if (metadata.authorization_endpoint && metadata.token_endpoint) {
			const resource = typeof metadata.resource === "string" ? metadata.resource : protectedResource;
			return {
				authorizationUrl: String(metadata.authorization_endpoint),
				tokenUrl: String(metadata.token_endpoint),
				registrationUrl: readRegistrationUrl(metadata),
				clientId:
					typeof metadata.client_id === "string"
						? metadata.client_id
						: typeof metadata.clientId === "string"
							? metadata.clientId
							: typeof metadata.default_client_id === "string"
								? metadata.default_client_id
								: typeof metadata.public_client_id === "string"
									? metadata.public_client_id
									: undefined,
				scopes: protectedScopes ?? readMetadataScopes(metadata),
				resource,
			};
		}

		if (metadata.oauth || metadata.authorization || metadata.auth) {
			const oauthData = (metadata.oauth || metadata.authorization || metadata.auth) as Record<string, unknown>;
			if (typeof oauthData.authorization_url === "string" && typeof oauthData.token_url === "string") {
				const resource = typeof oauthData.resource === "string" ? oauthData.resource : protectedResource;
				return {
					authorizationUrl: oauthData.authorization_url,
					tokenUrl: oauthData.token_url,
					registrationUrl: readRegistrationUrl(oauthData),
					clientId:
						typeof oauthData.client_id === "string"
							? oauthData.client_id
							: typeof oauthData.clientId === "string"
								? oauthData.clientId
								: typeof oauthData.default_client_id === "string"
									? oauthData.default_client_id
									: typeof oauthData.public_client_id === "string"
										? oauthData.public_client_id
										: undefined,
					scopes: protectedScopes ?? readMetadataScopes(oauthData),
					resource,
				};
			}
		}
		return null;
	};

	for (const base of urlsToQuery) {
		for (const path of wellKnownPaths) {
			for (const url of buildWellKnownUrls(path, base.url)) {
				const metadata = await fetchDiscoveryMetadata(url, context, base.allowTrustedOrigin);
				if (!metadata) continue;

				const requireIssuerMatch =
					base.issuerCandidate &&
					(path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration");
				const issuerOk = requireIssuerMatch ? issuerMatchesBase(metadata.issuer, base.url) : true;
				const endpoints = issuerOk ? findEndpoints(metadata) : null;
				if (endpoints) return endpoints;

				if (path !== "/.well-known/oauth-protected-resource") continue;
				const authServers = Array.isArray(metadata.authorization_servers)
					? metadata.authorization_servers.filter((entry): entry is string => typeof entry === "string")
					: [];
				const discoveredProtectedResource =
					typeof metadata.resource === "string" && metadata.resource.trim() !== ""
						? metadata.resource
						: protectedResource;

				for (const discoveredAuthServer of authServers) {
					const canonical = canonicalizeDiscoveryBase(discoveredAuthServer, context.trustedOrigin);
					if (!canonical || context.visitedAuthServers.has(canonical)) continue;
					const discovered = await discoverOAuthEndpointsWithContext(
						serverUrl,
						canonical,
						undefined,
						{
							protectedResource: discoveredProtectedResource,
							protectedScopes: readMetadataScopes(metadata) ?? protectedScopes,
						},
						context,
						depth + 1,
					);
					if (discovered) return discovered;
				}
			}
		}
	}
	return null;
}

function buildWellKnownUrls(wellKnownPath: string, baseUrl: string): URL[] {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		return [];
	}

	const absUrl = new URL(wellKnownPath, parsed);
	if (!wellKnownPath.startsWith("/")) return [absUrl];

	const normalizedPath = parsed.pathname.replace(/\/$/, "");
	const lastSlash = normalizedPath.lastIndexOf("/");

	if (lastSlash < 0) return [absUrl];

	const prefixPath = lastSlash === 0 ? normalizedPath : normalizedPath.slice(0, lastSlash);
	const relUrl = new URL(wellKnownPath.slice(1), `${parsed.origin}${prefixPath}/`);

	const candidates: URL[] = [absUrl];
	const seen = new Set<string>([absUrl.href]);
	const push = (u: URL): void => {
		if (!seen.has(u.href)) {
			candidates.push(u);
			seen.add(u.href);
		}
	};
	push(relUrl);

	if (wellKnownPath.startsWith("/.well-known/")) {
		const pathfulUrl = new URL(`${wellKnownPath}${normalizedPath}`, parsed.origin);
		push(pathfulUrl);
	}

	return candidates;
}
