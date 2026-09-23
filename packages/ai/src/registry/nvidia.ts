import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginNvidia = createApiKeyLogin({
	providerLabel: "NVIDIA",
	authUrl: "https://org.ngc.nvidia.com/setup/personal-keys",
	instructions: "Copy your API key from NVIDIA NGC Personal Keys",
	promptMessage: "Paste your NVIDIA API key",
	placeholder: "nvapi-...",
	validation: {
		kind: "chat-completions",
		provider: "nvidia",
		baseUrl: "https://integrate.api.nvidia.com/v1",
		model: "nvidia/llama-3.1-nemotron-70b-instruct",
		optional: true,
	},
});

export const nvidiaProvider = {
	id: "nvidia",
	name: "NVIDIA",
	login: loginNvidia,
} satisfies ProviderDefinition & { readonly id: "nvidia" };
