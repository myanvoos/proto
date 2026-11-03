import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getPluginsDir, logger } from "@oh-my-pi/pi-utils";
import { clearCache } from "../capability/fs";
import { clearClaudePluginRootsCache, listClaudePluginRoots } from "./helpers";

let root: string;
let home: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-registry-refresh-"));
	home = path.join(root, "home");
	clearCache();
	clearClaudePluginRootsCache();
});

afterEach(async () => {
	vi.restoreAllMocks();
	clearClaudePluginRootsCache();
	clearCache();
	await fs.rm(root, { recursive: true, force: true });
});

async function registry(version: string): Promise<void> {
	await Bun.write(
		path.join(getPluginsDir(home), "installed_plugins.json"),
		JSON.stringify({
			version: 2,
			plugins: { "sample@market": [{ scope: "user", installPath: path.join(root, version), version }] },
		}),
	);
}

test("each cached working directory observes an external plugin registry replacement", async () => {
	const first = path.join(root, "first");
	const second = path.join(root, "second");
	await fs.mkdir(first);
	await fs.mkdir(second);
	await registry("1.0.0");
	expect((await listClaudePluginRoots(home, first)).roots.map(entry => entry.version)).toEqual(["1.0.0"]);
	await registry("2.0.0-longer");
	expect((await listClaudePluginRoots(home, second)).roots.map(entry => entry.version)).toEqual(["2.0.0-longer"]);
	expect((await listClaudePluginRoots(home, first)).roots.map(entry => entry.version)).toEqual(["2.0.0-longer"]);
});

test("an unstatable foreign registry does not hide native installed plugins", async () => {
	await registry("1.0.0");
	await Bun.write(path.join(home, ".claude"), "regular file");
	expect((await listClaudePluginRoots(home, root)).roots.map(entry => entry.id)).toEqual(["sample@market"]);
});

test("concurrent registry readers report one diagnostic until that file changes", async () => {
	const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
	const file = path.join(getPluginsDir(home), "installed_plugins.json");
	await Bun.write(file, "invalid json");
	await Promise.all([listClaudePluginRoots(home, root), listClaudePluginRoots(home, root)]);
	await listClaudePluginRoots(home, root);
	expect(
		warn.mock.calls.filter(([message]) => String(message).includes("Failed to parse PROTO plugin registry")),
	).toHaveLength(1);
});
