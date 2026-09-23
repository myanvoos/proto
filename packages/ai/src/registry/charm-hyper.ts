import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginCharmHyper = createApiKeyLogin({
	providerLabel: "Charm Hyper",
	authUrl: "https://hyper.charm.land/",
	instructions: "Create or copy an API key from the Charm Hyper dashboard",
	promptMessage: "Paste your Charm Hyper API key",
	placeholder: "sk-hyper-...",
	normalize: "strip-bearer",
	// `/v1/models` is public and accepts any key; `/v1/credits` is authenticated and non-billable.
	validation: {
		kind: "models-endpoint",
		provider: "Charm Hyper",
		modelsUrl: "https://hyper.charm.land/v1/credits",
	},
});

export const charmHyperProvider = {
	id: "charm-hyper",
	name: "Charm Hyper",
	login: (cb: OAuthLoginCallbacks) => loginCharmHyper(cb),
} as const satisfies ProviderDefinition;
