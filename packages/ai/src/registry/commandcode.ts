import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginCommandCode = createApiKeyLogin({
	providerLabel: "Command Code",
	authUrl: "https://commandcode.ai/studio",
	instructions: "Create or copy a Provider API key from Command Code Studio",
	promptMessage: "Paste your Command Code API key",
	placeholder: "user_...",
	// No probe: `/provider/v1/models` is public (any key passes), and a completions probe would bill the key and
	// reject Go-plan keys that are still valid CLI credentials.
	validation: null,
});

export const commandCodeProvider = {
	id: "commandcode",
	name: "Command Code",
	login: loginCommandCode,
} satisfies ProviderDefinition & { readonly id: "commandcode" };
