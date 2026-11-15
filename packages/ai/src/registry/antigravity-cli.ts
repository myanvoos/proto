import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/**
 * Google Antigravity over the official `agy` CLI's Agent Client Protocol.
 * Sign-in runs agy's own Google OAuth flow and the grant is stored as the
 * provider's OAuth credential.
 */
export const antigravityCliProvider = {
	id: "antigravity-cli",
	name: "Antigravity CLI (Gemini, Claude, GPT-OSS)",
	login: async (callbacks: OAuthLoginCallbacks) => {
		const { loginAntigravityCli } = await import("./oauth/antigravity-cli");
		return loginAntigravityCli(callbacks);
	},
	refreshToken: async (credentials: OAuthCredentials, signal?: AbortSignal) => {
		const { refreshAntigravityCli } = await import("./oauth/antigravity-cli");
		return refreshAntigravityCli(credentials, signal);
	},
} as const satisfies ProviderDefinition;
