import { loginCursorHook, refreshCursorHook } from "./oauth/cursor";
import type { ProviderDefinition } from "./types";

export const cursorProvider = {
	id: "cursor",
	name: "Cursor (Claude, GPT, etc.)",
	login: loginCursorHook,
	refreshToken: refreshCursorHook,
} as const satisfies ProviderDefinition;
