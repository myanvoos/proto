import type { ProviderDefinition } from "./types";

/**
 * Adoption login for the official Devin CLI's persisted Windsurf seat key. The
 * key lands in the `devin` provider's pool, where discovery and usage already
 * look, instead of the `DEVIN_API_KEY` environment fallback.
 */
export const devinCliProvider = {
	id: "devin-cli",
	name: "Devin (adopt CLI credentials)",
	login: async () => {
		const { loginDevinCliHook } = await import("./oauth/devin-cli");
		return loginDevinCliHook();
	},
	storeCredentialsAs: "devin",
} as const satisfies ProviderDefinition;
