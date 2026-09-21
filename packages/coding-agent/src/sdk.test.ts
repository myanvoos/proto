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

test("interactivePrompts decides whether a headless session keeps the ask tool", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-sdk-ask-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const settings = Settings.isolated();
	const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
	const baseOptions = {
		cwd: agentDir,
		agentDir,
		authStorage,
		modelRegistry,
		settings,
		toolNames: ["ask"],
		hasUI: false,
		disableExtensionDiscovery: true,
		enableMCP: false,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: { rootPath: agentDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	};
	try {
		// A background side agent is headless but still talks to the user, so `ask` has to survive.
		const prompting = await createAgentSession({
			...baseOptions,
			sessionManager: SessionManager.inMemory(agentDir),
			interactivePrompts: true,
		});
		const silent = await createAgentSession({
			...baseOptions,
			sessionManager: SessionManager.inMemory(agentDir),
		});
		try {
			expect(prompting.session.getEnabledToolNames()).toContain("ask");
			expect(silent.session.getEnabledToolNames()).not.toContain("ask");
		} finally {
			await prompting.session.dispose();
			await silent.session.dispose();
		}
	} finally {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
