import * as path from "node:path";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

export interface ContextFile {
	path: string;

	content: string;

	level: "user" | "project";

	depth?: number;

	/** Extra filenames coexist with built-in context files at the same depth. */
	additive?: boolean;

	_source: SourceMeta;
}

export const contextFileCapability = defineCapability<ContextFile>({
	id: "context-files",
	displayName: "Context Files",
	description: "Persistent instruction files (CLAUDE.md, AGENTS.md, etc.) that guide agent behavior",

	key: file => {
		const scope = file.level === "user" ? "user" : `project:${Math.max(0, file.depth ?? 0)}`;
		return file.additive ? `${scope}:additive:${path.resolve(file.path)}` : scope;
	},
	toExtensionId: file => `context-file:${file.level}:${path.basename(file.path)}`,
	validate: file => {
		if (!file.path) return "Missing path";
		if (file.content === undefined) return "Missing content";
		if (file.level !== "user" && file.level !== "project") return "Invalid level: must be 'user' or 'project'";
		return undefined;
	},
});
