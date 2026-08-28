import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const openaiCodexDeviceProvider = {
	id: "openai-codex-device",
	name: "ChatGPT Plus/Pro (Codex, headless/device)",
	login: async (cb: OAuthLoginCallbacks) => {
		const { loginOpenAICodexDevice } = await import("./oauth/openai-codex");
		return loginOpenAICodexDevice(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		const { refreshOpenAICodexToken } = await import("./oauth/openai-codex");
		return refreshOpenAICodexToken(credentials.refresh);
	},
	storeCredentialsAs: "openai-codex",
} as const satisfies ProviderDefinition;
