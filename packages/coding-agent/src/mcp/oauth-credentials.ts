import { isDefinitiveOAuthFailure, REMOTE_REFRESH_SENTINEL, type StoredOAuthRefreshResult } from "@oh-my-pi/pi-ai";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import { expandEnvVarsDeep } from "../discovery/helpers";
import type { AuthStorage } from "../session/auth-storage";
import {
	isManagedMCPOAuthCredentialId,
	type MCPStoredOAuthCredential,
	mcpOAuthCredentialId,
	mcpOAuthCredentialProfile,
	mcpOAuthServerUrlFromCredentialId,
	refreshMCPOAuthToken,
} from "./oauth-flow";
import type { MCPAuthConfig, MCPServerConfig } from "./types";

export interface MCPOAuthCredentialLookup {
	credentialId: string;
	credential: MCPStoredOAuthCredential;
}

type MCPOAuthRefreshMaterial = MCPStoredOAuthCredential | MCPAuthConfig | undefined;

export function mcpOAuthCredentialIdsForServerUrl(serverUrl: string | undefined): string[] {
	if (!serverUrl) return [];
	const ids: string[] = [];
	for (const url of [expandEnvVarsDeep(serverUrl), serverUrl]) {
		const id = mcpOAuthCredentialId(url);
		if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}

function hasMcpAuthorizationHeader(config: MCPServerConfig): boolean {
	if (config.type !== "http" && config.type !== "sse") return false;
	return Object.keys(config.headers ?? {}).some(header => header.toLowerCase() === "authorization");
}

export function lookupMcpOAuthCredentialForServer(
	authStorage: AuthStorage | null | undefined,
	auth: MCPAuthConfig | undefined,
	serverUrl: string | undefined,
	options: { allowUrlKeyedFallback?: boolean } = {},
): MCPOAuthCredentialLookup | undefined {
	if (!authStorage) return undefined;
	if (auth && auth.type !== "oauth") return undefined;
	const urlKeyedCredentialIds = mcpOAuthCredentialIdsForServerUrl(serverUrl);
	if (
		auth?.credentialId &&
		(!auth.credentialId.startsWith("mcp_oauth:profile:") || urlKeyedCredentialIds.includes(auth.credentialId))
	) {
		const credential = authStorage.get(auth.credentialId);
		if (credential?.type === "oauth") {
			return { credentialId: auth.credentialId, credential };
		}
	}
	if (options.allowUrlKeyedFallback === false) return undefined;
	for (const credentialId of urlKeyedCredentialIds) {
		const credential = authStorage.get(credentialId);
		if (credential?.type === "oauth") {
			return { credentialId, credential };
		}
	}
	return undefined;
}

export function lookupMcpOAuthCredential(
	authStorage: AuthStorage | null | undefined,
	config: MCPServerConfig,
): MCPOAuthCredentialLookup | undefined {
	const auth = config.auth;
	if (config.type !== "http" && config.type !== "sse") {
		return lookupMcpOAuthCredentialForServer(authStorage, auth, undefined);
	}
	if (hasMcpAuthorizationHeader(config)) {
		return lookupMcpOAuthCredentialForServer(authStorage, auth, config.url, { allowUrlKeyedFallback: false });
	}
	return lookupMcpOAuthCredentialForServer(authStorage, auth, config.url);
}

export function selectMcpOAuthRefreshMaterial(
	credential: MCPStoredOAuthCredential,
	auth: MCPAuthConfig | undefined,
): MCPOAuthRefreshMaterial {
	return credential.tokenUrl ? credential : auth;
}

export function refreshManagedMcpOAuthCredential(
	credential: MCPStoredOAuthCredential,
	opts: { serverUrl?: string; auth?: MCPAuthConfig; signal?: AbortSignal } = {},
): Promise<OAuthCredentials> {
	const material = selectMcpOAuthRefreshMaterial(credential, opts.auth);
	const tokenUrl = material?.tokenUrl;
	if (!credential.refresh || !tokenUrl) {
		throw new Error("MCP OAuth credential is missing refresh material");
	}
	const authorizationUrl = material && "authorizationUrl" in material ? material.authorizationUrl : undefined;
	const resourceIsFallback = !material?.resource && Boolean(opts.serverUrl);
	const resource = material?.resource ?? (resourceIsFallback ? opts.serverUrl : undefined);
	return refreshMCPOAuthToken(tokenUrl, credential.refresh, material?.clientId, material?.clientSecret, resource, {
		authorizationUrl,
		stripSameOriginResource: resourceIsFallback,
		signal: opts.signal,
	});
}

async function refreshBrokeredMcpOAuthCredential(
	authStorage: AuthStorage,
	credentialId: number,
	provider: string,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const entry = await authStorage.forceRefreshCredentialById(credentialId, signal);
	if (entry.credential.type !== "oauth") {
		throw new Error(`Broker returned non-OAuth credential for ${provider}`);
	}
	const refreshed = entry.credential;
	return {
		access: refreshed.access,
		refresh: REMOTE_REFRESH_SENTINEL,
		expires: refreshed.expires,
		accountId: refreshed.accountId,
		email: refreshed.email,
		projectId: refreshed.projectId,
		enterpriseUrl: refreshed.enterpriseUrl,
	};
}

/**
 * Refreshes one stored MCP OAuth row through the durable credential owner so rotating refresh tokens are persisted
 * before callers use them. `serverUrl` supplies the fallback resource indicator (omit it for stdio servers);
 * standalone callers holding only the credential id set `recoverServerUrlFromCredentialId` instead.
 */
export async function refreshStoredManagedMcpOAuthCredential(
	authStorage: AuthStorage,
	provider: string,
	opts: {
		credentialId?: number;
		serverUrl?: string;
		recoverServerUrlFromCredentialId?: boolean;
		auth?: MCPAuthConfig;
		forceRefresh?: boolean;
		signal?: AbortSignal;
		onRefreshFailure?: (error: unknown) => void;
	} = {},
): Promise<StoredOAuthRefreshResult<MCPStoredOAuthCredential>> {
	const row = authStorage
		.listStoredCredentials(provider)
		.find(
			entry =>
				entry.credential.type === "oauth" && (opts.credentialId === undefined || entry.id === opts.credentialId),
		);
	if (row?.credential.type !== "oauth") {
		return { credential: undefined, refreshed: false, removed: false };
	}
	const serverUrl =
		opts.serverUrl ??
		(opts.recoverServerUrlFromCredentialId ? mcpOAuthServerUrlFromCredentialId(provider) : undefined);
	return authStorage.refreshStoredOAuthCredential<MCPStoredOAuthCredential>(provider, {
		credentialId: row.id,
		observedCredential: row.credential,
		credentialFromRow: credential => credential,
		forceRefresh: opts.forceRefresh,
		signal: opts.signal,
		refreshSkewMs: 5 * 60_000,
		canRefresh: current => {
			const material = selectMcpOAuthRefreshMaterial(current, opts.auth);
			return Boolean(current.refresh && material?.tokenUrl);
		},
		refresh: (current, signal) =>
			current.refresh === REMOTE_REFRESH_SENTINEL
				? refreshBrokeredMcpOAuthCredential(authStorage, row.id, provider, signal)
				: refreshManagedMcpOAuthCredential(current, { serverUrl, auth: opts.auth, signal }),
		mergeRefreshedCredential: (current, refreshed) => {
			const material = selectMcpOAuthRefreshMaterial(current, opts.auth);
			const resourceIsFallback = !material?.resource && Boolean(serverUrl);
			return {
				...current,
				...refreshed,
				tokenUrl: material?.tokenUrl,
				clientId: material?.clientId,
				clientSecret: material?.clientSecret,
				resource: resourceIsFallback ? undefined : material?.resource,
				authorizationUrl: material && "authorizationUrl" in material ? material.authorizationUrl : undefined,
			};
		},
		isDefinitiveFailure: error => isDefinitiveOAuthFailure(error instanceof Error ? error.message : String(error)),
		disabledCause: error => `oauth refresh failed: ${error instanceof Error ? error.message : String(error)}`,
		keepCredentialOnRefreshFailure: true,
		onRefreshFailure: opts.onRefreshFailure,
	});
}

export async function removeManagedMcpOAuthCredential(
	authStorage: AuthStorage,
	credentialId: string | undefined,
): Promise<boolean> {
	if (!isManagedMCPOAuthCredentialId(credentialId)) return false;
	const scopedProfile = mcpOAuthCredentialProfile(credentialId);
	if (scopedProfile !== undefined && scopedProfile !== (getActiveProfile() ?? "default")) return false;
	if (authStorage.get(credentialId)?.type !== "oauth") return false;
	await authStorage.remove(credentialId);
	return true;
}

export async function removeManagedMcpOAuthCredentials(
	authStorage: AuthStorage,
	credentialIds: readonly (string | undefined)[],
): Promise<boolean> {
	let removed = false;
	for (const credentialId of credentialIds) {
		removed = (await removeManagedMcpOAuthCredential(authStorage, credentialId)) || removed;
	}
	return removed;
}
