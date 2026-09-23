/**
 * `set_auto_compaction`/`set_auto_retry` and the queue-mode RPC setters must configure only the calling session,
 * never the machine-global config.yml or the shared Settings later sessions and subagents start from; only the
 * settings panel's explicit `persist` writes durable state, and that write must win over an earlier session
 * override (#11431, #11555).
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

let tempDir: TempDir;
let authStorage: AuthStorage;
let settings: Settings;
let session: AgentSession;
let configPath: string;

beforeEach(async () => {
	tempDir = TempDir.createSync("@proto-auto-scope-");
	const agentDir = tempDir.path();
	configPath = path.join(agentDir, "config.yml");
	authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
	session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: SessionManager.inMemory(agentDir),
		settings,
		modelRegistry: new ModelRegistry(authStorage),
	});
});

afterEach(async () => {
	await session.dispose();
	authStorage.close();
	await tempDir.remove().catch(() => {});
});

it("applies the toggles to the session without writing global config", async () => {
	session.setAutoCompactionEnabled(false);
	session.setAutoRetryEnabled(false);
	await settings.flush();

	expect(session.autoCompactionEnabled).toBe(false);
	expect(session.autoRetryEnabled).toBe(false);
	expect(await Bun.file(configPath).exists()).toBe(false);
});

it("a persisted toggle is saved and replaces an earlier session override", async () => {
	session.setAutoCompactionEnabled(false);
	session.setAutoRetryEnabled(false);
	session.setAutoCompactionEnabled(true, true);
	session.setAutoRetryEnabled(true, true);
	await settings.flush();

	expect(session.autoCompactionEnabled).toBe(true);
	expect(session.autoRetryEnabled).toBe(true);
	const onDisk = Bun.YAML.parse(await Bun.file(configPath).text()) as {
		compaction?: { enabled?: boolean };
		retry?: { enabled?: boolean };
	};
	expect(onDisk.compaction?.enabled).toBe(true);
	expect(onDisk.retry?.enabled).toBe(true);
});

it("queue-mode changes reach only the live agent, not global config or the shared Settings", async () => {
	session.setSteeringMode("all");
	session.setFollowUpMode("all");
	session.setInterruptMode("wait");
	await settings.flush();

	expect([session.steeringMode, session.followUpMode, session.interruptMode]).toEqual(["all", "all", "wait"]);
	// Later sessions and subagent settings snapshots initialize from these.
	expect([settings.get("steeringMode"), settings.get("followUpMode"), settings.get("interruptMode")]).toEqual([
		"one-at-a-time",
		"one-at-a-time",
		"immediate",
	]);
	expect(await Bun.file(configPath).exists()).toBe(false);
});

it("a persisted queue-mode change is saved to global config", async () => {
	session.setSteeringMode("all", true);
	await settings.flush();

	expect(settings.get("steeringMode")).toBe("all");
	expect(await Bun.file(configPath).text()).toContain("steeringMode: all");
});
