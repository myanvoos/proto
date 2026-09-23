import { loginMuseCode, parseMuseCodeCredential } from "./oauth/muse-code";
import type { ProviderDefinition } from "./types";

// Muse Code stores the Meta account token and its subscription-minted Model API key together in one OAuth access
// value; requests and discovery authenticate with the minted key. Meta rejects refresh_token grants, so there is
// no refresh hook.
export const museCodeProvider = {
	id: "muse-code",
	name: "Muse Code (Subscription)",
	credentialExpiry: "jwt-or-never",
	login: loginMuseCode,
	prepareRequest: (model, options) => {
		if (!options.apiKey) return { model, options };
		const { apiKey } = parseMuseCodeCredential(options.apiKey);
		return {
			model,
			options: { ...options, apiKey, headers: { "x-api-version": "1.0.0", ...options.headers } },
		};
	},
	prepareModelDiscovery: config => {
		if (!config.apiKey) return { ...config, authenticated: false };
		const { apiKey } = parseMuseCodeCredential(config.apiKey);
		return { ...config, apiKey, authenticated: true };
	},
} as const satisfies ProviderDefinition;
