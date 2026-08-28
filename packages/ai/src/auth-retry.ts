import { extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import type { OAuthAccess } from "./auth-storage";
import * as AIError from "./error";
import { isAuthRetryableError, isInvalidatedOAuthTokenError } from "./error/auth-classify";
import { isAccountPolicyError, isUsageLimit } from "./error/flags";
import { isConcurrencyCapExclusion, isUsageLimitOutcome } from "./error/rate-limit";

export interface ApiKeyResolveContext {
	lastChance: boolean;

	error: unknown;

	previousKey?: string;

	signal?: AbortSignal;
}

export type ApiKeyResolver = (ctx: ApiKeyResolveContext) => Promise<string | undefined> | string | undefined;

export type ApiKey = string | ApiKeyResolver;

export function isApiKeyResolver(key: ApiKey | undefined): key is ApiKeyResolver {
	return typeof key === "function";
}

export async function resolveApiKeyOnce(key: ApiKey | undefined, signal?: AbortSignal): Promise<string | undefined> {
	if (key === undefined) return undefined;
	if (isApiKeyResolver(key)) return (await key({ lastChance: false, error: undefined, signal })) || undefined;
	return key;
}

export function seedApiKeyResolver(seed: string | undefined, resolver: ApiKeyResolver): ApiKeyResolver {
	let seedPending = seed !== undefined;
	return ctx => {
		if (seedPending && ctx.error === undefined) {
			seedPending = false;
			return seed;
		}
		return resolver(ctx);
	};
}

export { isAuthRetryableError };

export const AUTH_RETRY_STEPS: readonly boolean[] = [false, true];

export const AUTH_RETRY_MAX_ATTEMPTS = 64;

function isDirectCredentialRotationError(error: unknown): boolean {
	if (isAccountPolicyError(error)) return true;
	if (isUsageLimit(error) || isInvalidatedOAuthTokenError(error)) return true;
	const status = AIError.status(error);
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;

	const isForbidden =
		status === 403 ||
		(status === undefined && message !== undefined && extractHttpStatusFromError({ message }) === 403);
	if (isForbidden && !isConcurrencyCapExclusion(status, message)) return true;
	return isUsageLimitOutcome(status, message);
}

export async function resolveRetryKey(
	resolver: ApiKeyResolver,
	lastChance: boolean,
	error: unknown,
	signal?: AbortSignal,
	previousKey?: string,
): Promise<string | undefined> {
	try {
		const rotateSibling = lastChance || (!lastChance && isDirectCredentialRotationError(error));
		return (await resolver({ lastChance: rotateSibling, error, signal, previousKey })) || undefined;
	} catch {
		return undefined;
	}
}

export interface AuthRetryKeyState {
	attemptedKeys: Set<string>;

	lastKey: string;

	refreshedCurrent: boolean;

	legacyAuthSwitchUsed: boolean;

	tokenRefreshReplayUsed?: boolean;

	attempts: number;
}

export function createAuthRetryKeyState(initialKey: string): AuthRetryKeyState {
	return {
		attemptedKeys: new Set([initialKey]),
		lastKey: initialKey,
		refreshedCurrent: false,
		legacyAuthSwitchUsed: false,
		tokenRefreshReplayUsed: false,
		attempts: 1,
	};
}

function acceptRetryKey(state: AuthRetryKeyState, key: string, refreshedCurrent: boolean): string | undefined {
	if (state.attemptedKeys.has(key) || state.attempts >= AUTH_RETRY_MAX_ATTEMPTS) return undefined;
	state.attemptedKeys.add(key);
	state.attempts += 1;
	state.lastKey = key;
	state.refreshedCurrent = refreshedCurrent;
	return key;
}

export async function resolveNextAuthRetryKey(
	state: AuthRetryKeyState,
	resolver: ApiKeyResolver,
	error: unknown,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (signal?.aborted) return undefined;
	if (state.attempts >= AUTH_RETRY_MAX_ATTEMPTS) return undefined;
	if (error instanceof AIError.OAuthError && error.kind === "token-refresh") {
		if (state.tokenRefreshReplayUsed) return undefined;
		state.tokenRefreshReplayUsed = true;
		const refreshed = await resolveRetryKey(resolver, false, error, signal, state.lastKey);
		state.refreshedCurrent = true;
		if (signal?.aborted || refreshed === undefined) return undefined;
		return acceptRetryKey(state, refreshed, true);
	}
	const directRotation = isDirectCredentialRotationError(error);
	if (!directRotation) {
		if (state.legacyAuthSwitchUsed) return undefined;
		if (!state.refreshedCurrent) {
			const refreshed = await resolveRetryKey(resolver, false, error, signal, state.lastKey);
			state.refreshedCurrent = true;
			if (signal?.aborted) return undefined;
			if (refreshed !== undefined) {
				const accepted = acceptRetryKey(state, refreshed, true);
				if (accepted !== undefined) return accepted;
			}
		}
	}

	if (signal?.aborted) return undefined;
	const rotated = await resolveRetryKey(resolver, true, error, signal, state.lastKey);
	if (signal?.aborted || rotated === undefined) return undefined;
	const accepted = acceptRetryKey(state, rotated, !directRotation);
	if (accepted !== undefined && !directRotation) state.legacyAuthSwitchUsed = true;
	return accepted;
}

function oauthCredentialIdentity(access: OAuthAccess): string {
	return access.credentialId !== undefined ? `credential:${access.credentialId}` : `bearer:${access.accessToken}`;
}

async function runOAuthAttempt<T>(
	access: OAuthAccess,
	attempt: (access: OAuthAccess) => Promise<T>,
	isAuthError: (error: unknown) => boolean,
): Promise<{ ok: true; result: T } | { ok: false; error: unknown }> {
	try {
		return { ok: true, result: await attempt(access) };
	} catch (error) {
		if (!isAuthError(error)) throw error;
		return { ok: false, error };
	}
}

export async function withAuth<T>(
	key: ApiKey | undefined,
	attempt: (key: string) => Promise<T>,
	opts?: { isAuthError?: (error: unknown) => boolean; signal?: AbortSignal; missingKeyMessage?: string },
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const missingKey = (): Error => new AIError.MissingApiKeyError(undefined, opts?.missingKeyMessage);

	if (!isApiKeyResolver(key)) {
		if (key === undefined) throw missingKey();
		return attempt(key);
	}

	const resolver = key;
	const signal = opts?.signal;
	const initialKey = await resolveRetryKey(resolver, false, undefined, signal);
	if (initialKey === undefined) throw missingKey();

	const state = createAuthRetryKeyState(initialKey);
	let lastError: unknown;
	try {
		return await attempt(initialKey);
	} catch (error) {
		if (!isAuthError(error)) throw error;
		lastError = error;
	}

	while (true) {
		const nextKey = await resolveNextAuthRetryKey(state, resolver, lastError, signal);
		if (nextKey === undefined) break;
		try {
			return await attempt(nextKey);
		} catch (error) {
			if (!isAuthError(error)) throw error;
			lastError = error;
		}
	}

	throw lastError;
}

export interface OAuthAccessSource {
	getOAuthAccess(
		provider: string,
		sessionId?: string,
		options?: { forceRefresh?: boolean; signal?: AbortSignal },
	): Promise<OAuthAccess | undefined>;
	rotateSessionCredential(
		provider: string,
		sessionId: string | undefined,
		options?: { error?: unknown; signal?: AbortSignal; apiKey?: string; credentialId?: number },
	): Promise<boolean>;
}

export interface WithOAuthAccessOptions {
	sessionId?: string;
	signal?: AbortSignal;

	isAuthError?: (error: unknown) => boolean;

	seed?: OAuthAccess;
	missingAccessMessage?: string;
}

export async function withOAuthAccess<T>(
	storage: OAuthAccessSource,
	provider: string,
	attempt: (access: OAuthAccess) => Promise<T>,
	opts?: WithOAuthAccessOptions,
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const { sessionId, signal } = opts ?? {};

	let lastAccess = opts?.seed ?? (await storage.getOAuthAccess(provider, sessionId, { signal }));
	if (!lastAccess) {
		throw new AIError.MissingApiKeyError(
			provider,
			opts?.missingAccessMessage ?? `No OAuth credential available for provider: ${provider}`,
		);
	}

	const attemptedBearers = new Set([lastAccess.accessToken]);
	const attemptedCredentialIdentities = new Set([oauthCredentialIdentity(lastAccess)]);
	let attemptCount = 1;
	let legacyAuthSwitchUsed = false;
	let refreshedCurrent = false;
	let tokenRefreshReplayUsed = false;
	let attemptResult = await runOAuthAttempt(lastAccess, attempt, isAuthError);
	if (attemptResult.ok) return attemptResult.result;

	let lastError = attemptResult.error;
	while (true) {
		let next: OAuthAccess | undefined;
		if (signal?.aborted || attemptCount >= AUTH_RETRY_MAX_ATTEMPTS) break;
		const tokenRefreshReplay = lastError instanceof AIError.OAuthError && lastError.kind === "token-refresh";
		if (tokenRefreshReplay) {
			if (tokenRefreshReplayUsed) break;
			tokenRefreshReplayUsed = true;
			refreshedCurrent = true;
			try {
				next = await storage.getOAuthAccess(provider, sessionId, { forceRefresh: true, signal });
			} catch {
				next = undefined;
			}
			if (signal?.aborted || !next) break;
			const bearer = next.accessToken;
			if (attemptedBearers.has(bearer) || attemptCount >= AUTH_RETRY_MAX_ATTEMPTS) break;
			attemptedCredentialIdentities.add(oauthCredentialIdentity(next));
			attemptedBearers.add(bearer);
			attemptCount += 1;
			lastAccess = next;
			attemptResult = await runOAuthAttempt(next, attempt, isAuthError);
			if (attemptResult.ok) return attemptResult.result;
			lastError = attemptResult.error;
			continue;
		}

		const directRotation = isDirectCredentialRotationError(lastError);
		if (!directRotation) {
			if (legacyAuthSwitchUsed) break;
			if (!refreshedCurrent) {
				refreshedCurrent = true;
				try {
					next = await storage.getOAuthAccess(provider, sessionId, { forceRefresh: true, signal });
				} catch {
					next = undefined;
				}
				if (signal?.aborted) break;
				if (next) {
					const bearer = next.accessToken;
					if (!attemptedBearers.has(bearer) && attemptCount < AUTH_RETRY_MAX_ATTEMPTS) {
						attemptedCredentialIdentities.add(oauthCredentialIdentity(next));
						attemptedBearers.add(bearer);
						attemptCount += 1;
						lastAccess = next;
						attemptResult = await runOAuthAttempt(next, attempt, isAuthError);
						if (attemptResult.ok) return attemptResult.result;
						lastError = attemptResult.error;
						continue;
					}
				}
			}
		}

		if (signal?.aborted || attemptCount >= AUTH_RETRY_MAX_ATTEMPTS) break;
		try {
			const rotated = await storage.rotateSessionCredential(provider, sessionId, {
				error: lastError,
				signal,
				apiKey: lastAccess.accessToken,
				credentialId: lastAccess.credentialId,
			});
			if (!rotated) break;
			next = await storage.getOAuthAccess(provider, sessionId, { signal });
		} catch {
			next = undefined;
		}
		if (signal?.aborted || !next) break;
		const credentialIdentity = oauthCredentialIdentity(next);
		if (
			attemptedCredentialIdentities.has(credentialIdentity) ||
			attemptedBearers.has(next.accessToken) ||
			attemptCount >= AUTH_RETRY_MAX_ATTEMPTS
		) {
			break;
		}
		attemptedCredentialIdentities.add(credentialIdentity);
		attemptedBearers.add(next.accessToken);
		attemptCount += 1;
		lastAccess = next;
		refreshedCurrent = !directRotation;
		if (!directRotation) legacyAuthSwitchUsed = true;
		attemptResult = await runOAuthAttempt(next, attempt, isAuthError);
		if (attemptResult.ok) return attemptResult.result;
		lastError = attemptResult.error;
	}

	throw lastError;
}
