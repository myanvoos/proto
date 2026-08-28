import { defineCapability } from ".";
import type { SourceMeta } from "./types";

export interface ExtensionModule {
	name: string;

	path: string;

	level: "user" | "project";

	_source: SourceMeta;
}

export const extensionModuleCapability = defineCapability<ExtensionModule>({
	id: "extension-modules",
	displayName: "Extension Modules",
	description: "TypeScript/JavaScript extension modules loaded by the extension system",
	key: ext => ext.name,
	toExtensionId: ext => `extension-module:${ext.name}`,
	validate: ext => {
		if (!ext.name) return "Missing name";
		if (!ext.path) return "Missing path";
		return undefined;
	},
});
