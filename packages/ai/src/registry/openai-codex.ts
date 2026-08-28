import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const openaiCodexProvider = {
	id: "openai-codex",
	name: "ChatGPT Plus/Pro (Codex Subscription)",
	login: async (cb: OAuthLoginCallbacks) => {
		const { loginOpenAICodex } = await import("./oauth/openai-codex");
		return loginOpenAICodex(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		const { refreshOpenAICodexToken } = await import("./oauth/openai-codex");
		return refreshOpenAICodexToken(credentials.refresh);
	},
	callbackPort: 1455,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
