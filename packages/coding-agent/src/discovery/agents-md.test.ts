import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "../capability/fs";
import { loadAgentsMd } from "./agents-md";

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-agents-md-test-"));
	clearFsCache();
});

afterEach(async () => {
	clearFsCache();
	await fs.rm(tempDir, { recursive: true, force: true });
});

test("loads the repository-root AGENTS.md when the repository root is home", async () => {
	const home = path.join(tempDir, "home");
	const cwd = path.join(home, "project");
	await fs.mkdir(cwd, { recursive: true });
	const homeAgents = path.join(home, "AGENTS.md");
	await Bun.write(homeAgents, "repo root context");

	const result = await loadAgentsMd({ cwd, home, repoRoot: home });

	expect(result.items.map(file => file.path)).toEqual([homeAgents]);
});

test("skips empty AGENTS.md files", async () => {
	const home = path.join(tempDir, "home");
	const repoRoot = path.join(home, "repo");
	const cwd = path.join(repoRoot, "pkg");
	await fs.mkdir(cwd, { recursive: true });
	await Bun.write(path.join(cwd, "AGENTS.md"), "");
	const repoAgents = path.join(repoRoot, "AGENTS.md");
	await Bun.write(repoAgents, "repo context");

	const result = await loadAgentsMd({ cwd, home, repoRoot });

	expect(result.items.map(file => file.path)).toEqual([repoAgents]);
});
