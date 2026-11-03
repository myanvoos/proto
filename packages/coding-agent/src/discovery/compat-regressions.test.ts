import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { getCapability, loadCapability } from "../capability";
import { clearCache } from "../capability/fs";
import { type Hook, hookCapability } from "../capability/hook";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Settings, settingsCapability } from "../capability/settings";
import { getAncestorDirs } from "./builtin";
import "./claude-plugins";
import "./codex";
import { clearClaudePluginRootsCache, parseAgentFields, resolveActiveProjectRegistryPath } from "./helpers";

let root: string;
let home: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-discovery-compat-"));
	home = path.join(root, "home");
	await fs.mkdir(home);
	clearCache();
	clearClaudePluginRootsCache();
});

afterEach(async () => {
	vi.restoreAllMocks();
	clearClaudePluginRootsCache();
	clearCache();
	await fs.rm(root, { recursive: true, force: true });
});

test("malformed tools restrictions allow only the mandatory yield tool, never the defaults", () => {
	const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
	for (const tools of [false, {}, [4], " , "]) {
		expect(parseAgentFields({ name: "limited", description: "restricted", tools })?.tools).toEqual(["yield"]);
	}
	expect(warn).toHaveBeenCalledTimes(4);
	expect(parseAgentFields({ name: "normal", description: "defaults", tools: null })?.tools).toBeUndefined();
});

test("canonical home ceilings preserve the caller's symlink spelling below the boundary", async () => {
	const alias = path.join(root, "home-link");
	await fs.symlink(home, alias, "dir");
	await fs.mkdir(path.join(home, "project"));
	vi.spyOn(os, "homedir").mockReturnValue(home);
	expect(getAncestorDirs(path.join(alias, "project"), home).map(entry => entry.dir)).toEqual([
		path.join(alias, "project"),
	]);
});

test("project registry discovery never reads a shared temporary ceiling", async () => {
	vi.spyOn(os, "tmpdir").mockReturnValue(root);
	await fs.mkdir(path.join(root, ".proto"));
	const cwd = path.join(root, "scratch");
	await fs.mkdir(cwd);
	expect(await resolveActiveProjectRegistryPath(cwd)).toBeNull();
	expect(getAncestorDirs(cwd).map(entry => entry.dir)).toEqual([cwd]);
});

test("foreign user roots above a repository are skipped but repo-local agent directories remain project scope", async () => {
	vi.spyOn(os, "tmpdir").mockReturnValue(root);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	const foreign = path.join(root, "foreign");
	const repo = path.join(foreign, "repo");
	const cwd = path.join(repo, "src");
	await fs.mkdir(path.join(foreign, ".proto", "agent"), { recursive: true });
	await fs.mkdir(path.join(repo, ".git"), { recursive: true });
	await fs.mkdir(cwd);
	const expected = path.join(repo, ".proto", "plugins", "installed_plugins.json");
	expect(await resolveActiveProjectRegistryPath(cwd)).toBe(expected);
	await fs.mkdir(path.join(repo, ".proto", "agent"), { recursive: true });
	expect(await resolveActiveProjectRegistryPath(cwd)).toBe(expected);
});

test("native hook discovery accepts symlinked scripts", async () => {
	const cwd = path.join(root, "project");
	const hooks = path.join(cwd, ".proto", "hooks", "pre");
	await fs.mkdir(hooks, { recursive: true });
	const script = path.join(root, "shared-hook.sh");
	await Bun.write(script, "#!/bin/sh\nexit 0\n");
	const link = path.join(hooks, "bash.sh");
	await fs.symlink(script, link);
	const provider = getCapability<Hook>(hookCapability.id)?.providers.find(entry => entry.id === "native");
	if (!provider) throw new Error("native hook provider missing");
	const result = await provider.load({ cwd, home, repoRoot: cwd, agentDir: path.join(root, "agent") });
	expect(result.items.map(hook => [hook.path, hook.tool])).toEqual([[link, "bash"]]);
});

test("Codex TOML settings survive capability validation as user and project settings", async () => {
	const cwd = path.join(home, "project");
	await Bun.write(path.join(home, ".codex", "config.toml"), 'personality = "friendly"\n');
	await Bun.write(path.join(cwd, ".codex", "config.toml"), 'personality = "direct"\n');
	const provider = getCapability<Settings>(settingsCapability.id)?.providers.find(entry => entry.id === "codex");
	if (!provider) throw new Error("codex settings provider missing");
	const result = await provider.load({ cwd, home, repoRoot: cwd });
	expect(result.items.map(item => [item.level, item.data.personality]).sort()).toEqual([
		["project", "direct"],
		["user", "friendly"],
	]);
	for (const item of result.items) expect(settingsCapability.validate?.(item)).toBeUndefined();
});

test("Claude plugin timeouts below one second use defaults while valid explicit timeouts survive", async () => {
	const plugin = path.join(root, "plugin");
	const config = path.join(home, ".claude");
	vi.spyOn(os, "homedir").mockReturnValue(home);
	const previous = process.env.CLAUDE_CONFIG_DIR;
	try {
		process.env.CLAUDE_CONFIG_DIR = config;
		await Bun.write(
			path.join(config, "plugins", "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: { "timing@market": [{ scope: "user", installPath: plugin, version: "1.0.0" }] },
			}),
		);
		await Bun.write(
			path.join(plugin, ".mcp.json"),
			JSON.stringify({ short: { command: "noop", timeout: 600 }, valid: { command: "noop-valid", timeout: 1000 } }),
		);
		const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd: root, providers: ["claude-plugins"] });
		expect(result.items.find(item => item.name === "timing:short")?.timeout).toBeUndefined();
		expect(result.items.find(item => item.name === "timing:valid")?.timeout).toBe(1000);
		expect(result.warnings.some(warning => warning.includes("600") && warning.includes("1000ms"))).toBe(true);
	} finally {
		if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = previous;
	}
});
