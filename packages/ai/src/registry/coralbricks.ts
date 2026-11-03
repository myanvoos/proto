import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginCoralbricks = createApiKeyLogin({
	providerLabel: "CoralBricks",
	authUrl: "https://www.coralbricks.ai/api-keys",
	instructions: "Create or copy your API key from the CoralBricks dashboard",
	promptMessage: "Paste your CoralBricks API key",
	placeholder: "cb_...",
	validation: {
		kind: "models-endpoint",
		provider: "CoralBricks",
		modelsUrl: "https://inference.coralbricks.ai/v1/models",
	},
});

export const coralbricksProvider = {
	id: "coralbricks",
	name: "CoralBricks",
	login: loginCoralbricks,
} as const satisfies ProviderDefinition;
