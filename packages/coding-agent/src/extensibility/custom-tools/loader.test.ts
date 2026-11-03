import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { initializeWithSettings } from "../../capability";
import { clearCache as clearFsCache } from "../../capability/fs";
import { Settings } from "../../config/settings";
import { clearClaudePluginRootsCache } from "../../discovery/helpers";
import { discoverCustomToolPaths, loadCustomTools } from "./loader";

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

test("custom tool modules evaluate once while each session invokes the factory with its own API", async () => {
	const toolPath = path.join(root, "once.mjs");
	const countPath = path.join(root, "evaluations.txt");
	await Bun.write(
		toolPath,
		`
const countPath = ${JSON.stringify(countPath)};
const count = Number(await Bun.file(countPath).text().catch(() => "0")) + 1;
await Bun.write(countPath, String(count));
export default api => [{
	name: api.cwd.endsWith("first") ? "first_session" : "second_session",
	description: "Module evaluation probe",
	parameters: api.arktype({}),
	execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
}];
`,
	);
	const first = await loadCustomTools([{ path: toolPath }], path.join(root, "first"), []);
	const second = await loadCustomTools([{ path: toolPath }], path.join(root, "second"), []);
	expect(first.errors).toEqual([]);
	expect(second.errors).toEqual([]);
	expect(first.tools.map(entry => entry.tool.name)).toEqual(["first_session"]);
	expect(second.tools.map(entry => entry.tool.name)).toEqual(["second_session"]);
	expect(await Bun.file(countPath).text()).toBe("1");
});

test("transpiled CommonJS default factories load as tools rather than failing the default-function check", async () => {
	const toolPath = path.join(root, "transpiled.cjs");
	await Bun.write(
		toolPath,
		`
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = api => [{
	name: "commonjs_tool", description: "CommonJS tool", parameters: api.arktype({}),
	execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
}];
`,
	);
	const loaded = await loadCustomTools([{ path: toolPath }], project, []);
	expect(loaded.errors).toEqual([]);
	expect(loaded.tools.map(entry => entry.tool.name)).toEqual(["commonjs_tool"]);
});
