import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { readInstalledPluginsRegistry } from "./registry";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

test("skips malformed installed-plugin entries instead of trusting their install paths", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-plugin-registry-"));
	tempDirs.push(tempDir);
	const registryPath = path.join(tempDir, "installed_plugins.json");
	await Bun.write(
		registryPath,
		JSON.stringify({
			version: 2,
			plugins: {
				"bad@market": [
					{
						scope: "user",
						installPath: { attackerControlled: true },
						version: "1.0.0",
						installedAt: "2026-01-01T00:00:00.000Z",
						lastUpdated: "2026-01-01T00:00:00.000Z",
					},
				],
				"good@market": [
					{
						scope: "user",
						installPath: path.join(tempDir, "cache", "good"),
						version: "1.0.0",
						installedAt: "2026-01-01T00:00:00.000Z",
						lastUpdated: "2026-01-01T00:00:00.000Z",
					},
				],
			},
		}),
	);
	const warn = spyOn(logger, "warn").mockImplementation(() => {});

	const registry = await readInstalledPluginsRegistry(registryPath);

	expect(registry.plugins["bad@market"]).toBeUndefined();
	expect(registry.plugins["good@market"]).toHaveLength(1);
	expect(warn).toHaveBeenCalled();
});
