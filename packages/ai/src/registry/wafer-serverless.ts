import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const waferServerlessProvider = {
	id: "wafer-serverless",
	name: "Wafer Serverless (pay-as-you-go)",
	login: async (cb: OAuthLoginCallbacks) => {
		const { loginWaferServerless } = await import("./oauth/wafer");
		return loginWaferServerless(cb);
	},
} as const satisfies ProviderDefinition;
