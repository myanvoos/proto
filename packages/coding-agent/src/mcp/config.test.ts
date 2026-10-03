import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { clearCache as clearFsCache } from "../capability/fs";
import { loadAllMCPConfigs } from "./config";

let root: string;
let projectDir: string;
let agentDir: string;
let originalAgentDir: string;

beforeEach(async () => {
	originalAgentDir = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-mcp-config-"));
	projectDir = path.join(root, "project");
	agentDir = path.join(root, "agent");
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(
		path.join(projectDir, ".proto", "mcp.json"),
		JSON.stringify({ mcpServers: { projcontext: { type: "http", url: "https://mcp.example.test/mcp" } } }),
	);
	setAgentDir(agentDir);
	clearFsCache();
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	clearFsCache();
	await fs.rm(root, { recursive: true, force: true });
});

test.each([
	["malformed", "{ not valid json"],
	["non-object", "null"],
])("a %s user mcp.json does not drop the other MCP sources", async (_label, content) => {
	await Bun.write(path.join(agentDir, "mcp.json"), content);

	const result = await loadAllMCPConfigs(projectDir, { filterExa: false });

	expect(result.configs).toHaveProperty("projcontext");
	expect(result.sources.projcontext?.level).toBe("project");
});
