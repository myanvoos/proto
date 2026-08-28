import { createApiKeyLogin } from "../api-key-login";

const WAFER_AUTH_URL = "https://app.wafer.ai/usage";
const WAFER_MODELS_URL = "https://pass.wafer.ai/v1/models";

export const loginWaferServerless = createApiKeyLogin({
	providerLabel: "Wafer Serverless",
	authUrl: WAFER_AUTH_URL,
	instructions: "Create or copy your Wafer Serverless API key from the Wafer dashboard",
	promptMessage: "Paste your Wafer Serverless API key",
	placeholder: "wfr_...",
	validation: {
		kind: "models-endpoint",
		provider: "Wafer Serverless",
		modelsUrl: WAFER_MODELS_URL,
	},
});
