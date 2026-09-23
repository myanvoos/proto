import { clinePassClientHeaders } from "@oh-my-pi/pi-catalog/wire/cline-pass";
import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginClinePass = createApiKeyLogin({
	providerLabel: "ClinePass",
	authUrl: "https://app.cline.bot/dashboard/account",
	instructions: "Create an API key in the Cline dashboard under Settings → API Keys",
	promptMessage: "Paste your Cline API key",
	placeholder: "sk_...",
	validation: {
		// The account identity route: login must not couple to a roster model (roster churn can retire the probe
		// target) or spend subscription quota on a ping.
		kind: "models-endpoint",
		provider: "ClinePass",
		modelsUrl: "https://api.cline.bot/api/v1/users/me",
		headers: () => clinePassClientHeaders(),
	},
});

export const clinePassProvider = {
	id: "cline-pass",
	name: "ClinePass",
	login: loginClinePass,
} satisfies ProviderDefinition & { readonly id: "cline-pass" };
