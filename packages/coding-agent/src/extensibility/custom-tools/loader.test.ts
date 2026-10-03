import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { initializeWithSettings } from "../../capability";
import { clearCache as clearFsCache } from "../../capability/fs";
import { Settings } from "../../config/settings";
import { clearClaudePluginRootsCache } from "../../discovery/helpers";
import { discoverCustomToolPaths } from "./loader";

let root: string;
let project: string;
let originalHome: string | undefined;
let originalAgentDir: string;

beforeEach(async () => {
	clearClaudePluginRootsCache();
	clearFsCache();
	originalHome = process.env.HOME;
	originalAgentDir = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-custom-tool-discovery-"));
	const home = path.join(root, "home");
	project = path.join(root, "project");
	process.env.HOME = home;
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".proto", "agent"));
	await fs.mkdir(path.join(project, ".git"), { recursive: true });
	initializeWithSettings(Settings.isolated());
});

afterEach(async () => {
	clearClaudePluginRootsCache();
	clearFsCache();
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	await removeWithRetries(root);
});

test("automatic discovery returns executable modules only, without metadata shadowing them", async () => {
	const projectTools = path.join(project, ".proto", "tools");
	const userTools = path.join(getAgentDir(), "tools");
	await Promise.all([
		fs.mkdir(path.join(projectTools, "nested"), { recursive: true }),
		fs.mkdir(userTools, { recursive: true }),
	]);
	await Promise.all([
		fs.writeFile(path.join(projectTools, "package.json"), JSON.stringify({ name: "user-module", type: "module" })),
		fs.writeFile(path.join(projectTools, "notes.md"), "---\nname: notes\ndescription: Tool metadata\n---\n"),
		fs.writeFile(path.join(projectTools, "project-module.ts"), "export default () => [];\n"),
		fs.writeFile(path.join(userTools, "user-module.js"), "export default () => [];\n"),
		fs.writeFile(path.join(projectTools, "nested", "index.ts"), "export default () => [];\n"),
		fs.writeFile(path.join(projectTools, "types.d.ts"), "export declare const tool: unknown;\n"),
		fs.writeFile(path.join(projectTools, "helper.sh"), "#!/bin/sh\necho helper\n"),
		fs.writeFile(path.join(projectTools, "helper.py"), "print('helper')\n"),
	]);

	const discovered = await discoverCustomToolPaths([], project);

	expect(discovered.map(entry => path.relative(root, entry.path)).sort()).toEqual([
		path.join("home", ".proto", "agent", "tools", "user-module.js"),
		path.join("project", ".proto", "tools", "nested", "index.ts"),
		path.join("project", ".proto", "tools", "project-module.ts"),
	]);
});
