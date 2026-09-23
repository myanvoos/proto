import * as AIError from "../../error";
import { getProviderDefinition, getProviderRegistry } from "../registry";
import type {
	OAuthCredentials,
	OAuthProvider,
	OAuthProviderId,
	OAuthProviderInfo,
	OAuthProviderInterface,
} from "./types";

export * from "./anthropic";
export * from "./device-code";
export type * from "./types";

let builtInOAuthProviders: OAuthProviderInfo[] | undefined;

function getBuiltInOAuthProviders(): OAuthProviderInfo[] {
	builtInOAuthProviders ??= getProviderRegistry()
		.filter(provider => provider.login && provider.showInLoginList !== false)
		.map(provider => ({
			id: provider.id,
			name: provider.name,
			available: provider.available ?? true,
			storeCredentialsAs: provider.storeCredentialsAs,
		}));
	return builtInOAuthProviders;
}

const customOAuthProviders = new Map<string, OAuthProviderInterface>();

export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	customOAuthProviders.set(provider.id, provider);
}

export function unregisterOAuthProvider(id: string): void {
	customOAuthProviders.delete(id);
}

export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return customOAuthProviders.get(id);
}

export function unregisterOAuthProviders(sourceId: string): void {
	for (const [id, provider] of customOAuthProviders.entries()) {
		if (provider.sourceId === sourceId) {
			customOAuthProviders.delete(id);
		}
	}
}

export async function refreshOAuthToken(
	provider: OAuthProvider,
	credentials: OAuthCredentials,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	if (!credentials) {
		throw new AIError.OAuthError(`No OAuth credentials found for ${provider}`, {
			kind: "validation",
			provider,
		});
	}
	const def = getProviderDefinition(provider);
	if (!def?.login) {
		throw new AIError.OAuthError(`Unknown OAuth provider: ${provider}`, {
			kind: "validation",
			provider,
		});
	}

	return def.refreshToken ? def.refreshToken(credentials, signal) : credentials;
}

const NEVER_EXPIRES = 8.64e15;
const JWT_EXPIRY_SKEW_MS = 5 * 60_000;

function jwtExpiryMs(token: string): number | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	const payload = parts[1];
	if (!payload) return undefined;
	try {
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
		if (typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp)) return undefined;
		return decoded.exp * 1000 - JWT_EXPIRY_SKEW_MS;
	} catch {
		return undefined;
	}
}

/**
 * Applies a provider's declared credential expiry. `jwt-or-never` providers trust a JWT `exp` claim when present and
 * otherwise treat the credential as non-expiring, ignoring stale stored timestamps older logins wrote.
 */
export function normalizeOAuthCredentialExpiry<T extends OAuthCredentials>(provider: string, credentials: T): T {
	if (getProviderDefinition(provider)?.credentialExpiry !== "jwt-or-never") return credentials;
	const normalizedExpires =
		credentials.expires > 0 && credentials.expires < 10_000_000_000
			? credentials.expires * 1000
			: credentials.expires;
	const expires = jwtExpiryMs(credentials.access) ?? Math.max(normalizedExpires, NEVER_EXPIRES);
	return expires === credentials.expires ? credentials : { ...credentials, expires };
}

export async function getOAuthApiKey(
	provider: OAuthProvider,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const stored = credentials[provider];
	if (!stored) {
		return null;
	}
	const creds = normalizeOAuthCredentialExpiry(provider, stored);

	if (Date.now() >= creds.expires) {
		throw new AIError.OAuthError(
			`OAuth credential for ${provider} is expired and must be refreshed via AuthStorage before getOAuthApiKey is called`,
			{ kind: "validation", provider },
		);
	}

	const needsStructuredApiKey =
		provider === "github-copilot" ||
		provider === "google-gemini-cli" ||
		provider === "google-antigravity" ||
		provider === "alibaba-coding-plan";
	const apiKey = needsStructuredApiKey
		? JSON.stringify({
				apiEndpoint: creds.apiEndpoint,
				token: creds.access,
				enterpriseUrl: creds.enterpriseUrl,
				projectId: creds.projectId,
				refreshToken: creds.refresh,
				expiresAt: creds.expires,
				email: creds.email,
				accountId: creds.accountId,
			})
		: creds.access;
	return { newCredentials: creds, apiKey };
}

export function getOAuthProviders(): OAuthProviderInfo[] {
	const customProviders = Array.from(customOAuthProviders.values(), provider => ({
		id: provider.id,
		name: provider.name,
		available: true,
		storeCredentialsAs: provider.storeCredentialsAs,
	}));
	return [...getBuiltInOAuthProviders(), ...customProviders];
}
