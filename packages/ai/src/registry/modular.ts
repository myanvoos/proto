import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginModular = createApiKeyLogin({
	providerLabel: "Modular",
	authUrl: "https://console.modular.com/api_keys",
	instructions: "Create an API key in the Modular Console",
	promptMessage: "Paste your Modular API key",
	placeholder: "...",
	validation: { kind: "models-endpoint", provider: "Modular", modelsUrl: "https://api.modular.com/v1/models" },
});

export const modularProvider = {
	id: "modular",
	name: "Modular",
	login: loginModular,
} as const satisfies ProviderDefinition;
