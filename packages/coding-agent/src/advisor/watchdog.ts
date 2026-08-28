import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import { expandAtImports } from "../discovery/at-imports";
import activeRepoWatchdogTemplate from "../prompts/advisor/active-repo-watchdog.md" with { type: "text" };
import contextFilesTemplate from "../prompts/advisor/context-files.md" with { type: "text" };
import type { ActiveRepoContext } from "../utils/active-repo-context";
import { repo } from "../utils/git";
import { normalizePromptPath } from "../utils/prompt-path";

export function formatActiveRepoWatchdogPrompt(activeRepoContext: ActiveRepoContext): string {
	return prompt
		.render(activeRepoWatchdogTemplate, {
			relativeRepoRoot: normalizePromptPath(activeRepoContext.relativeRepoRoot),
		})
		.trim();
}

export function formatAdvisorContextPrompt(
	contextFiles: ReadonlyArray<{ path: string; content: string }>,
): string | undefined {
	if (contextFiles.length === 0) return undefined;
	return prompt.render(contextFilesTemplate, { contextFiles }).trim() || undefined;
}

interface ConfigCandidate {
	path: string;
	content: string;
	level: "user" | "project";
	depth: number;
}

export async function collectConfigCandidates(
	cwd: string,
	agentDir: string | undefined,
	filenames: string[],
): Promise<ConfigCandidate[]> {
	const home = os.homedir();
	const resolvedAgentDir = agentDir ?? getAgentDir();
	const userPaths = new Set<string>();
	let repoRoot: string | null = null;
	try {
		repoRoot = await repo.root(cwd);
	} catch (err) {
		logger.debug("Failed to resolve git root for config discovery", { err: String(err) });
	}

	const candidates = new Set<string>();

	if (resolvedAgentDir) {
		for (const filename of filenames) {
			const userPath = path.resolve(resolvedAgentDir, filename);
			candidates.add(userPath);
			userPaths.add(userPath);
		}
	}

	let current = cwd;
	while (true) {
		for (const filename of filenames) {
			candidates.add(path.resolve(current, ".proto", filename));
			candidates.add(path.resolve(current, filename));
		}
		if (current === (repoRoot ?? home)) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	const items: ConfigCandidate[] = [];
	for (const candidate of candidates) {
		try {
			const content = await Bun.file(candidate).text();
			const parent = path.dirname(candidate);
			const baseName = parent.split(path.sep).pop() ?? "";
			const isUser = userPaths.has(candidate);
			const ownerDir = baseName === ".proto" ? path.dirname(parent) : parent;
			const ownerBaseName = ownerDir.split(path.sep).pop() ?? "";
			if (isUser || !ownerBaseName.startsWith(".") || baseName === ".proto") {
				const relative = path.relative(cwd, ownerDir);
				const depth = relative === "" ? 0 : relative.split(path.sep).filter(Boolean).length;
				items.push({ path: candidate, content, level: isUser ? "user" : "project", depth });
			}
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to read config candidate", { path: candidate, error: String(err) });
			}
		}
	}

	items.sort((a, b) => {
		if (a.level !== b.level) return a.level === "user" ? -1 : 1;
		return b.depth - a.depth;
	});

	return items;
}

export async function discoverWatchdogFiles(cwd: string, agentDir?: string): Promise<string[]> {
	const items = await collectConfigCandidates(cwd, agentDir, ["WATCHDOG.md"]);
	const blocks: string[] = [];
	for (const item of items) {
		const expanded = await expandAtImports(item.content, item.path);
		blocks.push(`Especially pay attention to:\n<attention>\n${expanded}\n</attention>`);
	}
	return blocks;
}
