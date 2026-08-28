import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginOpenRouter = createApiKeyLogin({
	providerLabel: "OpenRouter",
	authUrl: "https://openrouter.ai/keys",
	instructions: "Create or copy your OpenRouter API key",
	promptMessage: "Paste your OpenRouter API key",
	placeholder: "sk-or-...",
	validation: {
		kind: "models-endpoint",
		provider: "OpenRouter",
		modelsUrl: "https://openrouter.ai/api/v1/auth/key",
	},
});

export const openrouterProvider = {
	id: "openrouter",
	name: "OpenRouter",
	login: (cb: OAuthLoginCallbacks) => loginOpenRouter(cb),
} as const satisfies ProviderDefinition;
