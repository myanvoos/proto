import { SINGULARITYAPI_DEV_API_BASE_URL } from "@oh-my-pi/pi-catalog/wire/singularityapi";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginSingularityApiDev = createApiKeyLogin({
	providerLabel: "SingularityAPI",
	authUrl: "https://app.singularityapi.dev",
	instructions: "Create an API key from the SingularityAPI dashboard, then paste it here",
	promptMessage: "Paste your SingularityAPI API key",
	placeholder: "sk-sapi-...",
	normalize: "strip-bearer",
	validation: {
		kind: "models-endpoint",
		provider: "SingularityAPI",
		modelsUrl: `${SINGULARITYAPI_DEV_API_BASE_URL}/models`,
	},
});

export const singularityApiDevProvider = {
	id: "singularityapi-dev",
	name: "SingularityAPI",
	login: (cb: OAuthLoginCallbacks) => loginSingularityApiDev(cb),
} as const satisfies ProviderDefinition;
