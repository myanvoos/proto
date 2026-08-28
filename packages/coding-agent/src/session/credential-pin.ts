import type { AuthStorage } from "./auth-storage";
import type { SessionManager } from "./session-manager";

interface CredentialPinIdentity {
	accountId?: string;
	email?: string;
	projectId?: string;
	orgId?: string;
}

export function credentialPinHash(provider: string, identity: CredentialPinIdentity): string | undefined {
	if (!identity.accountId && !identity.email) return undefined;
	const key = [
		provider,
		identity.accountId ?? "",
		identity.email ?? "",
		identity.orgId ?? "",
		identity.projectId ?? "",
	].join("\0");
	return new Bun.CryptoHasher("sha256").update(key).digest("hex");
}

export function recordCredentialPin(
	authStorage: AuthStorage,
	sessionManager: SessionManager,
	sessionId: string,
	provider: string,
): void {
	const identity = authStorage.getOAuthAccountIdentity(provider, sessionId);
	if (!identity) return;
	const hash = credentialPinHash(provider, identity);
	if (!hash || sessionManager.getCredentialPins().get(provider)?.hash === hash) return;
	sessionManager.appendCredentialPin(provider, hash);
}

export function seedCredentialPins(authStorage: AuthStorage, sessionManager: SessionManager, sessionId: string): void {
	for (const [provider, pin] of sessionManager.getCredentialPins()) {
		const accounts = authStorage.listOAuthAccounts(provider, sessionId);
		if (accounts.length === 0 || accounts.some(account => account.active)) continue;
		const match = accounts.find(account => credentialPinHash(provider, account) === pin.hash);
		if (!match) continue;
		authStorage.pinSessionOAuthAccount(provider, sessionId, match.credentialId, {
			lastUsedAtMs: pin.lastUsedAt,
		});
	}
}
