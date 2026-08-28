import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const perplexityProvider = {
	id: "perplexity",
	name: "Perplexity (Pro/Max)",
	envKeys: "PERPLEXITY_API_KEY",
	login: async (cb: OAuthLoginCallbacks) => {
		const { loginPerplexity } = await import("./oauth/perplexity");
		return loginPerplexity(cb);
	},
} as const satisfies ProviderDefinition;
