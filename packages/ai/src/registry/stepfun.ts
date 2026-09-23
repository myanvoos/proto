import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginStepfun = createApiKeyLogin({
	providerLabel: "StepFun",
	authUrl: "https://platform.stepfun.ai/interface-key",
	instructions: "Copy your API key from the StepFun Open Platform",
	promptMessage: "Paste your StepFun API key",
	// StepFun keys are unprefixed opaque strings.
	placeholder: "...",
	validation: {
		kind: "chat-completions",
		provider: "StepFun",
		baseUrl: "https://api.stepfun.ai/v1",
		model: "step-5-preview",
		optional: true,
	},
});

export const stepfunProvider = {
	id: "stepfun",
	name: "StepFun",
	login: loginStepfun,
} satisfies ProviderDefinition & { readonly id: "stepfun" };
