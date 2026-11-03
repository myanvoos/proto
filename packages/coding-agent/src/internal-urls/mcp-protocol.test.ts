import { expect, test } from "bun:test";
import type { MCPManager } from "../mcp/manager";
import { readMcpResource } from "./mcp-protocol";
import { parseInternalUrl } from "./parse";

function manager(options: { hang?: boolean; templateOnly?: boolean } = {}): MCPManager {
	let loaded = false;
	return {
		getConnectedServers: () => ["connected"],
		getServerResources: () => ({
			resources: loaded && !options.templateOnly ? [{ uri: "skill://remote/SKILL.md" }] : [],
			templates: [{ uriTemplate: "skill://{name}/SKILL.md" }],
		}),
		ensureServerResources: async () => {
			loaded = true;
		},
		waitForPendingConnections: () => (options.hang ? Promise.withResolvers<void>().promise : Promise.resolve()),
		readServerResource: async () => ({ contents: [{ uri: "skill://remote/SKILL.md", text: "remote skill" }] }),
	} as unknown as MCPManager;
}

test("an advertised connected skill resource is readable without waiting for an unrelated hung handshake", async () => {
	const resource = await readMcpResource(manager({ hang: true }), parseInternalUrl("skill://remote/SKILL.md"), {
		exact: true,
		waitMs: 20,
	});
	expect(resource?.content).toBe("remote skill");
	expect(resource?.notes).toContain("MCP server: connected");
});

test("unknown skill fallback is bounded and does not claim a URI merely matching an MCP template", async () => {
	const resource = await readMcpResource(
		manager({ hang: true, templateOnly: true }),
		parseInternalUrl("skill://unknown/SKILL.md"),
		{ exact: true, waitMs: 10 },
	);
	expect(resource).toBeUndefined();
});
