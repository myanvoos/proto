import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { addMCPServer, readMCPConfigFile, validateServerName } from "./config-writer";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

test("accepts MCP server names containing spaces", () => {
	expect(validateServerName("MaaS Slack")).toBeUndefined();
	expect(validateServerName("MaaS/Slack")).toContain("can only contain");
});

test("persists an MCP server name containing spaces through the write path", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-mcp-config-writer-"));
	tempDirs.push(dir);
	const filePath = path.join(dir, "mcp.json");

	await addMCPServer(filePath, "MaaS Slack", { type: "stdio", command: "s" });

	const config = await readMCPConfigFile(filePath);
	expect(config.mcpServers?.["MaaS Slack"]).toEqual({ type: "stdio", command: "s" });
});
