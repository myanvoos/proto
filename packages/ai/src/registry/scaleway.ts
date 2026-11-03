import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginScaleway = createApiKeyLogin({
	providerLabel: "Scaleway",
	authUrl: "https://console.scaleway.com/iam/api-keys",
	instructions: "Create an API key on the Scaleway console and paste its Secret Key (SCW_SECRET_KEY)",
	promptMessage: "Paste your Scaleway secret key",
	placeholder: "...",
	normalize: "strip-bearer",
	validation: { kind: "models-endpoint", provider: "Scaleway", modelsUrl: "https://api.scaleway.ai/v1/models" },
});

export const scalewayProvider = {
	id: "scaleway",
	name: "Scaleway",
	login: loginScaleway,
} as const satisfies ProviderDefinition;
