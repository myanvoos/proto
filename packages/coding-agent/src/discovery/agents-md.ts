import * as path from "node:path";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { readFile } from "../capability/fs";
import type { LoadContext, LoadResult } from "../capability/types";
import { calculateDepth, createSourceMeta } from "./helpers";

const PROVIDER_ID = "agents-md";
const DISPLAY_NAME = "AGENTS.md";

function samePath(left: string, right: string): boolean {
	return path.resolve(left) === path.resolve(right);
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function loadAgentsMd(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];
	const home = path.resolve(ctx.home);
	const cwd = path.resolve(ctx.cwd);
	const repoRoot = ctx.repoRoot ? path.resolve(ctx.repoRoot) : null;
	const filesystemRoot = path.parse(cwd).root;
	const cwdIsUnderHome = isWithin(home, cwd);
	const repoIsUnderHome = repoRoot !== null && isWithin(home, repoRoot);
	const scanToHome = repoRoot !== null && cwdIsUnderHome && repoIsUnderHome;
	const boundary = scanToHome ? home : (repoRoot ?? (cwdIsUnderHome ? home : filesystemRoot));
	const includeBoundary = repoRoot === null ? cwdIsUnderHome : !samePath(boundary, home);
	const excludeHome = scanToHome;

	let current = cwd;
	while (true) {
		const atBoundary = samePath(current, boundary);
		const atHome = excludeHome && samePath(current, home);
		if (!(atHome || (atBoundary && !includeBoundary))) {
			const candidate = path.join(current, "AGENTS.md");
			const content = await readFile(candidate);

			if (content !== null) {
				const parent = path.dirname(candidate);
				const baseName = parent.split(path.sep).pop() ?? "";

				if (!baseName.startsWith(".")) {
					const fileDir = path.dirname(candidate);
					const calculatedDepth = calculateDepth(cwd, fileDir, path.sep);

					items.push({
						path: candidate,
						content,
						level: "project",
						depth: calculatedDepth,
						_source: createSourceMeta(PROVIDER_ID, candidate, "project"),
					});
				}
			}
		}
		if (atBoundary) break;

		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return { items, warnings };
}

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Standalone AGENTS.md files (Codex/Gemini style)",
	priority: 10,
	load: loadAgentsMd,
});
