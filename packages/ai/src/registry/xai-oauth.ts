import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const xaiOauthProvider = {
	id: "xai-oauth",
	name: "xAI Grok OAuth (SuperGrok or X Premium+)",
	login: async (cb: OAuthLoginCallbacks) => {
		const { loginXAIOAuth } = await import("./oauth/xai-oauth");
		return loginXAIOAuth(cb);
	},
	refreshToken: async (credentials: OAuthCredentials, signal?: AbortSignal) => {
		const { refreshXAIOAuthToken } = await import("./oauth/xai-oauth");
		return refreshXAIOAuthToken(credentials.refresh, undefined, signal);
	},
} as const satisfies ProviderDefinition;
