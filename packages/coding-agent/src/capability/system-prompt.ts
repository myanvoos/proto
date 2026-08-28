import { defineCapability } from ".";
import type { SourceMeta } from "./types";

export interface SystemPrompt {
	path: string;

	content: string;

	level: "user" | "project";

	_source: SourceMeta;
}

export const systemPromptCapability = defineCapability<SystemPrompt>({
	id: "system-prompt",
	displayName: "System Prompt",
	description: "Custom system prompt files (SYSTEM.md) that modify agent behavior",
	key: sp => sp.level,
	validate: sp => {
		if (!sp.path) return "Missing path";
		if (sp.content === undefined) return "Missing content";
		return undefined;
	},
});
