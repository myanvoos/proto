import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginSambanova = createApiKeyLogin({
	providerLabel: "SambaNova",
	authUrl: "https://cloud.sambanova.ai/apis",
	instructions: "Copy your API key from the SambaNova Cloud dashboard",
	promptMessage: "Paste your SambaNova API key",
	placeholder: "...",
	validation: { kind: "models-endpoint", provider: "SambaNova", modelsUrl: "https://api.sambanova.ai/v1/models" },
});

export const sambanovaProvider = {
	id: "sambanova",
	name: "SambaNova",
	login: loginSambanova,
} as const satisfies ProviderDefinition;
