import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const minimaxCodeCnProvider = {
	id: "minimax-code-cn",
	name: "MiniMax Token Plan (China)",
	login: async (cb: OAuthLoginCallbacks) => {
		const { loginMiniMaxCodeCn } = await import("./oauth/minimax-code");
		return loginMiniMaxCodeCn(cb);
	},
} as const satisfies ProviderDefinition;
