import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const openrouterProvider = {
	id: "openrouter",
	name: "OpenRouter",
	// Browser sign-in mints a durable key and a pasted `sk-or-…` key is validated
	// in the same manual-input race; both store the key as an api_key credential.
	// Lazy import keeps the callback server out of the eager registry graph.
	login: async (cb: OAuthLoginCallbacks) => {
		const { loginOpenRouterOAuth } = await import("./oauth/openrouter");
		const credentials = await loginOpenRouterOAuth(cb);
		return credentials.access;
	},
	callbackPort: 54549,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
