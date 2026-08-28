import { defineCapability } from ".";
import type { SourceMeta } from "./types";

export interface Settings {
	path: string;

	data: Record<string, unknown>;

	level: "user" | "project";

	_source: SourceMeta;
}

export const settingsCapability = defineCapability<Settings>({
	id: "settings",
	displayName: "Settings",
	description: "Configuration settings from various sources",

	key: () => undefined,
	validate: settings => {
		if (!settings.path) return "Missing path";
		if (!settings.data || typeof settings.data !== "object") return "Missing or invalid data";
		return undefined;
	},
});
