import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { clearCache as clearFsCache } from "../capability/fs";
import { listOmpExtensionRoots } from "./proto-extension-roots";

let home: string;
let cwd: string;
let agentDir: string;
let originalAgentDir: string;

beforeEach(async () => {
	originalAgentDir = getAgentDir();
	home = await fs.mkdtemp(path.join(os.tmpdir(), "proto-ext-roots-"));
	cwd = path.join(home, "project");
	agentDir = path.join(home, ".proto", "agent");
	for (const name of ["user-ext", "project-ext"]) await fs.mkdir(path.join(home, name), { recursive: true });
	await fs.mkdir(path.join(cwd, ".proto"), { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	setAgentDir(agentDir);
	clearFsCache();
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	clearFsCache();
	await fs.rm(home, { recursive: true, force: true });
});

async function configuredRoots(): Promise<Array<{ name: string; level: string }>> {
	const roots = await listOmpExtensionRoots({ cwd, home, repoRoot: null });
	return roots.map(({ name, level }) => ({ name, level }));
}

const userExt = () => path.join(home, "user-ext");
const projectExt = () => path.join(home, "project-ext");

test("extensions configured in the user config.yml are discovered", async () => {
	await Bun.write(path.join(agentDir, "config.yml"), `extensions:\n  - ${userExt()}\n`);
	expect(await configuredRoots()).toEqual([{ name: "user-ext", level: "user" }]);
});

test("a project extensions list replaces the user list, as in settings", async () => {
	await Bun.write(path.join(agentDir, "config.yml"), `extensions:\n  - ${userExt()}\n`);
	await Bun.write(path.join(cwd, ".proto", "config.yml"), `extensions:\n  - ${projectExt()}\n`);
	expect(await configuredRoots()).toEqual([{ name: "project-ext", level: "project" }]);
});

test("an empty project extensions list suppresses the user list", async () => {
	await Bun.write(path.join(agentDir, "config.yml"), `extensions:\n  - ${userExt()}\n`);
	await Bun.write(path.join(cwd, ".proto", "settings.json"), JSON.stringify({ extensions: [] }));
	expect(await configuredRoots()).toEqual([]);
});

test("a user config.yml supersedes the legacy settings.json it was migrated from", async () => {
	await Bun.write(path.join(agentDir, "settings.json"), JSON.stringify({ extensions: [userExt()] }));
	expect(await configuredRoots()).toEqual([{ name: "user-ext", level: "user" }]);
	await Bun.write(path.join(agentDir, "config.yml"), "theme: dark\n");
	clearFsCache();
	expect(await configuredRoots()).toEqual([]);
});
