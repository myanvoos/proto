import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "./config/model-registry";
import { Settings } from "./config/settings";
import { createAgentSession } from "./sdk";
import { AuthStorage } from "./session/auth-storage";
import { SessionManager } from "./session/session-manager";

test("an empty tool selection disables MCP discovery", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-sdk-no-tools-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const settings = Settings.isolated();
	const sessionManager = SessionManager.inMemory(agentDir);
	try {
		const { session, mcpManager } = await createAgentSession({
			cwd: agentDir,
			agentDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings }),
			settings,
			sessionManager,
			toolNames: [],
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: agentDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		try {
			expect(mcpManager).toBeUndefined();
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
