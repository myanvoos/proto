import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginFirepass = createApiKeyLogin({
	providerLabel: "Fire Pass",
	authUrl: "https://app.fireworks.ai/settings/users/api-keys",
	instructions: "Create a dedicated Fire Pass API key in the Fireworks dashboard",
	promptMessage: "Paste your Fire Pass API key",
	placeholder: "fpk_...",
	validation: {
		kind: "chat-completions",
		provider: "Fire Pass",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		model: "accounts/fireworks/routers/glm-5p2-fast",
	},
});

export const firepassProvider = {
	id: "firepass",
	name: "Fire Pass (Fireworks subscription)",
	login: (cb: OAuthLoginCallbacks) => loginFirepass(cb),
} as const satisfies ProviderDefinition;
