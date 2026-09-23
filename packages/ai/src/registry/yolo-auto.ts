import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginYoloAuto = createApiKeyLogin({
	providerLabel: "Yolo-Auto",
	authUrl: "https://yolo-auto.com/app",
	instructions: "Create or copy your Yolo-Auto API key (yolo_...)",
	promptMessage: "Paste your Yolo-Auto API key",
	placeholder: "yolo_...",
	validation: {
		// `GET /v1/models` rejects missing or invalid bearer keys, so it doubles as the identity check.
		kind: "models-endpoint",
		provider: "Yolo-Auto",
		modelsUrl: "https://yolo-auto.com/v1/models",
	},
});

export const yoloAutoProvider = {
	id: "yolo-auto",
	name: "Yolo-Auto",
	login: loginYoloAuto,
} satisfies ProviderDefinition & { readonly id: "yolo-auto" };
