import { afterEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getEnabledPlugins } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempRoots: string[] = [];

afterEach(async () => {
	clearClaudePluginRootsCache();
	mock.restore();
	for (const root of tempRoots.splice(0)) {
		await removeWithRetries(root);
	}
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await Bun.write(filePath, `${JSON.stringify(value)}\n`);
}

test("getEnabledPlugins caches repeated discovery for the same cwd and home until plugin caches clear", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-plugin-cache-"));
	tempRoots.push(root);
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	const pluginsDir = path.join(home, ".proto", "plugins");
	const pluginPackageJson = path.join(pluginsDir, "node_modules", "proto-cache-repro", "package.json");
	await fs.mkdir(path.dirname(pluginPackageJson), { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	await writeJson(path.join(pluginsDir, "package.json"), { dependencies: { "proto-cache-repro": "1.0.0" } });
	await writeJson(path.join(pluginsDir, "proto-plugins.lock.json"), {
		plugins: { "proto-cache-repro": { version: "1.0.0", enabled: true, enabledFeatures: null } },
		settings: {},
	});
	await writeJson(pluginPackageJson, {
		name: "proto-cache-repro",
		version: "1.0.0",
		proto: { tools: "tools" },
	});

	const [firstPlugin] = await getEnabledPlugins(cwd, { home });
	await writeJson(pluginPackageJson, {
		name: "proto-cache-repro",
		version: "2.0.0",
		proto: { tools: "tools" },
	});
	const [cachedPlugin] = await getEnabledPlugins(cwd, { home });

	expect(firstPlugin?.version).toBe("1.0.0");
	expect(cachedPlugin?.version).toBe("1.0.0");

	clearClaudePluginRootsCache();
	const [refreshedPlugin] = await getEnabledPlugins(cwd, { home });

	expect(refreshedPlugin?.version).toBe("2.0.0");
});
