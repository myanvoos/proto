import type { ProviderDefinition } from "./types";

/**
 * Windsurf Enterprise sign-in for Devin seats. The Devin-native flow bounces
 * these seats, so the hook drives the Windsurf editor authorize page and files
 * the exchanged raw key under `devin`.
 */
export const devinWindsurfProvider = {
	id: "devin-windsurf",
	name: "Devin (Windsurf Enterprise)",
	login: async callbacks => {
		const { loginDevinWindsurfHook } = await import("./oauth/devin-windsurf");
		return loginDevinWindsurfHook(callbacks);
	},
	storeCredentialsAs: "devin",
} as const satisfies ProviderDefinition;
