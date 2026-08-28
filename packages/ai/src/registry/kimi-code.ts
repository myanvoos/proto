import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const kimiCodeProvider = {
	id: "kimi-code",
	name: "Kimi Code",
	login: async (cb: OAuthLoginCallbacks) => {
		const { loginKimi } = await import("./oauth/kimi");
		return loginKimi(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		const { refreshKimiToken } = await import("./oauth/kimi");
		return refreshKimiToken(credentials.refresh);
	},
} as const satisfies ProviderDefinition;
