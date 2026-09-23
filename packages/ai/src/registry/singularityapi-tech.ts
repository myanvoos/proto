import { SINGULARITYAPI_TECH_API_BASE_URL } from "@oh-my-pi/pi-catalog/wire/singularityapi";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

// Lane keys bill against a booked reservation slot: a valid key without an active slot passes this probe and
// answers 403 at inference until one is booked.
export const loginSingularityApiTech = createApiKeyLogin({
	providerLabel: "SingularityAPI Reserved Lanes",
	authUrl: "https://app.singularityapi.tech/compute/billing",
	instructions: "Create a key from the SingularityAPI lanes dashboard, then paste it here",
	promptMessage: "Paste your SingularityAPI lanes key",
	placeholder: "sk-...",
	normalize: "strip-bearer",
	validation: {
		kind: "models-endpoint",
		provider: "SingularityAPI Reserved Lanes",
		modelsUrl: `${SINGULARITYAPI_TECH_API_BASE_URL}/models`,
	},
});

export const singularityApiTechProvider = {
	id: "singularityapi-tech",
	name: "SingularityAPI Reserved Lanes",
	login: (cb: OAuthLoginCallbacks) => loginSingularityApiTech(cb),
} as const satisfies ProviderDefinition;
