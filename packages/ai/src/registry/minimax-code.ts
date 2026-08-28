import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const minimaxCodeProvider = {
	id: "minimax-code",
	name: "MiniMax Token Plan (International)",
	login: async (cb: OAuthLoginCallbacks) => {
		const { loginMiniMaxCode } = await import("./oauth/minimax-code");
		return loginMiniMaxCode(cb);
	},
} as const satisfies ProviderDefinition;
