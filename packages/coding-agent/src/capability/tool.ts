import { defineCapability } from ".";
import type { SourceMeta } from "./types";

export interface CustomTool {
	name: string;

	path: string;

	description: string;

	implementation?: string;

	level: "user" | "project";

	_source: SourceMeta;
}

export const toolCapability = defineCapability<CustomTool>({
	id: "tools",
	displayName: "Custom Tools",
	description: "User-defined tools that extend agent capabilities",
	key: tool => tool.name,
	toExtensionId: tool => `tool:${tool.name}`,
	validate: tool => {
		if (!tool.name) return "Missing name";
		if (!tool.path) return "Missing path";
		return undefined;
	},
});
