import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const cursorProvider = {
	id: "cursor",
	name: "Cursor (Claude, GPT, etc.)",
	login: async (cb: OAuthLoginCallbacks) => {
		const { loginCursor } = await import("./oauth/cursor");
		return loginCursor(
			url => cb.onAuth({ url }),
			cb.onProgress ? () => cb.onProgress?.("Waiting for browser authentication...") : undefined,
		);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		const { refreshCursorToken } = await import("./oauth/cursor");
		return refreshCursorToken(credentials.refresh);
	},
} as const satisfies ProviderDefinition;
