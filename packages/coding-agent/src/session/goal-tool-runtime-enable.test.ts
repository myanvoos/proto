/**
 * The goal tool was registered only when `goal.enabled` was already on at session creation. Enabling goal mode later
 * started it while the model lacked the tool it was told to use; the tool is now registered on demand.
 */
import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../config/settings";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
let agentDir: string | undefined;
afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
	if (agentDir) await fs.rm(agentDir, { recursive: true, force: true });
	agentDir = undefined;
});

it("registers and activates the goal tool when goal mode is enabled after session creation", async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "goal-tool-runtime-enable-"));
	authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	// Isolated overrides pin a value; set() models the settings UI toggling it at runtime.
	const settings = Settings.isolated({});
	settings.set("goal.enabled", false);
	({ session } = await createAgentSession({
		cwd: process.cwd(),
		agentDir,
		authStorage,
		settings,
		sessionManager: SessionManager.inMemory(process.cwd()),
		disableExtensionDiscovery: true,
		enableMCP: false,
		workspaceTree: { rootPath: process.cwd(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
	}));
	expect(session.getToolByName("goal")).toBeUndefined();
	expect(await session.ensureGoalToolActive()).toBe(false);

	session.settings.set("goal.enabled", true);

	expect(await session.ensureGoalToolActive()).toBe(true);
	expect(session.getToolByName("goal")?.name).toBe("goal");
	expect(session.getEnabledToolNames()).toContain("goal");
});
