import { defineCapability } from ".";
import type { SourceMeta } from "./types";

export interface Prompt {
	name: string;

	path: string;

	content: string;

	_source: SourceMeta;
}

export const promptCapability = defineCapability<Prompt>({
	id: "prompts",
	displayName: "Prompts",
	description: "Reusable prompt templates available via /prompts: menu",
	key: prompt => prompt.name,
	toExtensionId: prompt => `prompt:${prompt.name}`,
	validate: prompt => {
		if (!prompt.name) return "Missing name";
		if (!prompt.path) return "Missing path";
		if (prompt.content === undefined) return "Missing content";
		return undefined;
	},
});
