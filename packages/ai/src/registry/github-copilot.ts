import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const githubCopilotProvider = {
	id: "github-copilot",
	name: "GitHub Copilot",
	login: async (cb: OAuthLoginCallbacks) => {
		const { loginGitHubCopilot } = await import("./oauth/github-copilot");
		return loginGitHubCopilot({
			onAuth: (url, instructions) => cb.onAuth({ url, instructions }),
			onPrompt: cb.onPrompt,
			onProgress: cb.onProgress,
			signal: cb.signal,
		});
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		const { refreshGitHubCopilotToken } = await import("./oauth/github-copilot");
		return refreshGitHubCopilotToken(credentials.refresh, credentials.enterpriseUrl, credentials.apiEndpoint);
	},
} as const satisfies ProviderDefinition;
