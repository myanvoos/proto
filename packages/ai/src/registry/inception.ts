import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginInception = createApiKeyLogin({
	providerLabel: "Inception",
	authUrl: "https://platform.inceptionlabs.ai/dashboard/api-keys",
	instructions: "Create or copy your key from the Inception dashboard",
	promptMessage: "Paste your Inception API key",
	placeholder: "sk_...",
	validation: {
		kind: "chat-completions",
		provider: "Inception",
		baseUrl: "https://api.inceptionlabs.ai/v1",
		model: "mercury-3",
		maxTokensField: "max_completion_tokens",
	},
});

export const inceptionProvider = {
	id: "inception",
	name: "Inception",
	login: loginInception,
} as const satisfies ProviderDefinition;
