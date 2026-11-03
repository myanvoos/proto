import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { boundSettings, registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { readFile } from "../capability/fs";
import type { LoadContext, LoadResult } from "../capability/types";
import * as git from "../utils/git";
import { loadStandaloneContextFiles } from "./agents-md";
import { calculateDepth, createSourceMeta } from "./helpers";

const PROVIDER_ID = "custom-context";
const BUILTIN_NAMES: Record<string, true> = {
	"agents.md": true,
	"claude.md": true,
	"gemini.md": true,
	"copilot-instructions.md": true,
};

export async function loadCustomContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const settings = boundSettings();
	if (!settings) return { items: [], warnings: [] };
	const configured = settings.get("contextFiles.extra");
	if (!Array.isArray(configured)) {
		return { items: [], warnings: ["contextFiles.extra must be a list of filenames"] };
	}
	const names: string[] = [];
	for (const entry of configured) {
		const name = typeof entry === "string" ? entry.trim() : "";
		if (
			!name ||
			name === "." ||
			name === ".." ||
			/[/\\\0]/.test(name) ||
			BUILTIN_NAMES[name.toLowerCase()] === true
		) {
			return {
				items: [],
				warnings: ["contextFiles.extra entries must be plain filenames, not paths or built-in context names"],
			};
		}
		if (!names.includes(name)) names.push(name);
	}
	if (names.length === 0) return { items: [], warnings: [] };

	const items: ContextFile[] = [];
	const warnings: string[] = [];
	const seen = new Set<string>();
	const push = (file: ContextFile): void => {
		const resolved = path.resolve(file.path);
		if (seen.has(resolved)) return;
		seen.add(resolved);
		items.push({ ...file, additive: true });
	};
	for (const name of names) {
		const loaded = await loadStandaloneContextFiles(ctx, PROVIDER_ID, name);
		warnings.push(...(loaded.warnings ?? []));
		for (const item of loaded.items) push(item);
	}

	const linked = git.repo.linkedWorktreeSync(ctx.cwd);
	if (linked && path.resolve(linked.primaryRoot) !== path.resolve(ctx.repoRoot ?? ctx.cwd)) {
		const primary = path.resolve(linked.primaryRoot);
		const relative = path.relative(primary, path.resolve(ctx.cwd));
		const primaryIsAncestor =
			relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
		const depth = primaryIsAncestor
			? calculateDepth(path.resolve(ctx.cwd), primary, path.sep)
			: calculateDepth(path.resolve(ctx.cwd), path.resolve(ctx.repoRoot ?? ctx.cwd), path.sep) + 1;
		for (const name of names) {
			const candidate = path.join(primary, name);
			const content = await readFile(candidate);
			if (!content) continue;
			push({
				path: candidate,
				content,
				level: "project",
				depth,
				_source: createSourceMeta(PROVIDER_ID, candidate, "project"),
			});
		}
	}

	// A repository must never pull arbitrary files from ~/.proto/agent into its prompt.
	if (settings.getSource("contextFiles.extra") !== "project") {
		for (const name of names) {
			const candidate = path.join(ctx.agentDir ?? getAgentDir(), name);
			const content = await readFile(candidate);
			if (!content) continue;
			push({ path: candidate, content, level: "user", _source: createSourceMeta(PROVIDER_ID, candidate, "user") });
		}
	}
	return { items, warnings };
}

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: "Custom context files",
	description: "Extra context filenames from contextFiles.extra, alongside built-in context files",
	priority: 9,
	load: loadCustomContextFiles,
});
