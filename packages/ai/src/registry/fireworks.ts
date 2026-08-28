import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginFireworks = createApiKeyLogin({
	providerLabel: "Fireworks",
	authUrl: "https://app.fireworks.ai/settings/users/api-keys",
	instructions: "Create or copy your Fireworks API key",
	promptMessage: "Paste your Fireworks API key",
	placeholder: "fw_...",
	validation: {
		kind: "models-endpoint",
		provider: "Fireworks",

		modelsUrl: "https://api.fireworks.ai/v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue&pageSize=1",
	},
});

export const fireworksProvider = {
	id: "fireworks",
	name: "Fireworks",
	login: (cb: OAuthLoginCallbacks) => loginFireworks(cb),
} as const satisfies ProviderDefinition;
