import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as capability from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { clearCache } from "../capability/fs";
import { Settings } from "../config/settings";
import * as git from "../utils/git";
import { loadCustomContextFiles } from "./custom-context-files";

let root: string;
let home: string;
let cwd: string;
let agentDir: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-extra-context-"));
	home = path.join(root, "home");
	cwd = path.join(home, "repo");
	agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	clearCache();
});

afterEach(async () => {
	vi.restoreAllMocks();
	clearCache();
	await fs.rm(root, { recursive: true, force: true });
});

function bind(names: unknown[]): Settings {
	const settings = Settings.isolated({ "contextFiles.extra": names });
	vi.spyOn(capability, "boundSettings").mockReturnValue(settings);
	return settings;
}

test("extra filenames load beside AGENTS.md instead of shadowing its scope", async () => {
	bind([" AGENTS.local.md ", "AGENTS.local.md"]);
	await Bun.write(path.join(cwd, "AGENTS.md"), "base instructions");
	await Bun.write(path.join(cwd, "AGENTS.local.md"), "extra instructions");
	const result = await capability.loadCapability<ContextFile>(contextFileCapability.id, {
		cwd,
		agentDir,
		providers: ["agents-md", "custom-context"],
	});
	expect(result.items.map(item => item.content).sort()).toEqual(["base instructions", "extra instructions"]);
});

test("project-configured names never read files in the user's agent directory", async () => {
	const settings = bind(["private.yml"]);
	vi.spyOn(settings, "getSource").mockReturnValue("project");
	await Bun.write(path.join(agentDir, "private.yml"), "secret credentials");
	await Bun.write(path.join(cwd, "private.yml"), "repository instructions");
	const result = await loadCustomContextFiles({ cwd, home, repoRoot: cwd, agentDir });
	expect(result.items.map(item => item.content)).toEqual(["repository instructions"]);
});

test("user-configured names include the active profile's agent directory", async () => {
	bind(["TEAM.md"]);
	await Bun.write(path.join(agentDir, "TEAM.md"), "profile instructions");
	const result = await loadCustomContextFiles({ cwd, home, repoRoot: cwd, agentDir });
	expect(result.items.map(item => [item.level, item.content])).toEqual([["user", "profile instructions"]]);
});

test.each(["../private.yml", "AGENTS.md", "nested/file.md", " ", 4])(
	"invalid extra context name %s cannot load an instruction file",
	async name => {
		bind([name]);
		await Bun.write(path.join(cwd, "AGENTS.md"), "builtin instructions");
		const result = await loadCustomContextFiles({ cwd, home, repoRoot: cwd, agentDir });
		expect(result.items).toEqual([]);
		expect(result.warnings).toEqual([expect.stringContaining("plain filenames")]);
	},
);

test("linked worktrees load same-named extra context from both checkout roots", async () => {
	bind(["TEAM.md"]);
	const primary = path.join(root, "primary");
	await Bun.write(path.join(cwd, "TEAM.md"), "worktree instructions");
	await Bun.write(path.join(primary, "TEAM.md"), "primary instructions");
	vi.spyOn(git.repo, "linkedWorktreeSync").mockReturnValue({ root: cwd, primaryRoot: primary });
	const result = await capability.loadCapability<ContextFile>(contextFileCapability.id, {
		cwd,
		agentDir,
		providers: ["custom-context"],
	});
	expect(result.items.map(item => item.content).sort()).toEqual(["primary instructions", "worktree instructions"]);
});

test("plain extra filenames that also name Object prototype properties remain loadable", async () => {
	bind(["constructor"]);
	await Bun.write(path.join(cwd, "constructor"), "team instructions");
	const result = await loadCustomContextFiles({ cwd, home, repoRoot: cwd, agentDir });
	expect(result.items.map(item => item.content)).toEqual(["team instructions"]);
});
