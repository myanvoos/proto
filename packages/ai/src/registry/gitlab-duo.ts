import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const gitlabDuoProvider = {
	id: "gitlab-duo",
	name: "GitLab Duo Non-Agentic",
	login: async (cb: OAuthLoginCallbacks) => {
		const { loginGitLabDuo } = await import("./oauth/gitlab-duo");
		return loginGitLabDuo(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		const { refreshGitLabDuoToken } = await import("./oauth/gitlab-duo");
		return refreshGitLabDuoToken(credentials);
	},
	callbackPort: 8080,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
