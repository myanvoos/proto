import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginNovita = createApiKeyLogin({
	providerLabel: "Novita",
	authUrl: "https://novita.ai/settings/key-management",
	instructions: "Create or copy your API key from the Novita dashboard",
	promptMessage: "Paste your Novita API key",
	placeholder: "sk_...",
	validation: {
		kind: "chat-completions",
		provider: "Novita",
		baseUrl: "https://api.novita.ai/openai/v1",
		model: "moonshotai/kimi-k2.7-code",
	},
});

export const novitaProvider = {
	id: "novita",
	name: "Novita",
	login: loginNovita,
} satisfies ProviderDefinition & { readonly id: "novita" };
