import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearPluginRootsAndCaches, injectPluginDirRoots } from "../discovery/helpers";
import { discoverAgents } from "./discovery";

const tempDirs: string[] = [];

afterEach(async () => {
	await injectPluginDirRoots(os.homedir(), []);
	clearPluginRootsAndCaches();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function writePlugin(root: string, manifestDir: string, agentName: string, model: string): Promise<void> {
	await Bun.write(path.join(root, manifestDir, "plugin.json"), JSON.stringify({ name: path.basename(root) }));
	await Bun.write(
		path.join(root, "agents", `${agentName}.md`),
		`---\nname: ${agentName}\ndescription: test agent\nmodel: ${model}\n---\nDo the work.\n`,
	);
}

// Regression: a Claude Code plugin agent's `model: sonnet` was resolved as a proto model selector instead of letting
// the agent inherit the parent's model; proto-native plugin agents keep their selectors.
test("plugin agents keep proto model selectors but drop Claude Code model aliases", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "proto-agent-dialect-"));
	tempDirs.push(home);
	const claudePlugin = path.join(home, "claude-plugin");
	const protoPlugin = path.join(home, "proto-plugin");
	await writePlugin(claudePlugin, ".claude-plugin", "claude-agent", "sonnet");
	await writePlugin(protoPlugin, ".proto-plugin", "proto-agent", "@smol");
	await injectPluginDirRoots(home, [claudePlugin, protoPlugin]);

	const { agents } = await discoverAgents(home, home);

	expect(agents.find(agent => agent.name === "claude-agent")?.model).toBeUndefined();
	expect(agents.find(agent => agent.name === "proto-agent")?.model).toEqual(["@smol"]);
});
