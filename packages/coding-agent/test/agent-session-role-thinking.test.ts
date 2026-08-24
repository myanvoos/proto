import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession role model thinking behavior", () => {
	let tempDir: TempDir;
	let fixtureDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let sessionSettings: Settings;

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-role-thinking-fixture-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-role-thinking-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		tempDir.removeSync();
	});

	afterAll(() => {
		authStorage.close();
		fixtureDir.removeSync();
	});

	function getAnthropicModelOrThrow(id: string) {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	async function createSession(options: {
		initialModelId: string;
		initialThinkingLevel: Effort;
		modelRoles: Record<string, string>;
		runtimeApiKeys?: Record<string, string>;
	}) {
		const model = getAnthropicModelOrThrow(options.initialModelId);
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: options.initialThinkingLevel,
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const runtimeApiKeys = options.runtimeApiKeys ?? {};
		for (const provider in runtimeApiKeys) {
			authStorage.setRuntimeApiKey(provider, runtimeApiKeys[provider]);
		}

		sessionSettings = Settings.isolated();
		for (const [role, modelRoleValue] of Object.entries(options.modelRoles)) {
			sessionSettings.setModelRole(role, modelRoleValue);
		}
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});
	}

	it("re-applies explicit role thinking each time that role is selected", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				slow: `${slowModel.provider}/${slowModel.id}:off`,
			},
		});

		const firstSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(firstSwitch?.role).toBe("slow");
		expect(firstSwitch?.model.id).toBe(slowModel.id);
		expect(firstSwitch?.thinkingLevel).toBe("off");
		expect(session.thinkingLevel).toBe("off");

		session.setThinkingLevel(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);

		const secondSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(secondSwitch?.role).toBe("default");
		expect(secondSwitch?.model.id).toBe(defaultModel.id);
		expect(session.thinkingLevel).toBe(Effort.High);

		const thirdSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(thirdSwitch?.role).toBe("slow");
		expect(thirdSwitch?.model.id).toBe(slowModel.id);
		expect(thirdSwitch?.thinkingLevel).toBe("off");
		expect(session.thinkingLevel).toBe("off");
	});

	it("preserves current thinking when switching into default/no-suffix role", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Low,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				slow: `${slowModel.provider}/${slowModel.id}:high`,
			},
		});

		const toSlow = await session.cycleRoleModels(["default", "slow"]);
		expect(toSlow?.role).toBe("slow");
		expect(toSlow?.thinkingLevel).toBe(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);

		// `medium` is supported on both ladders (4-6 dropped `minimal`), so the
		// selection survives the role switch unclamped.
		session.setThinkingLevel(Effort.Medium);
		expect(session.thinkingLevel).toBe(Effort.Medium);

		const toDefault = await session.cycleRoleModels(["default", "slow"]);
		expect(toDefault?.role).toBe("default");
		expect(toDefault?.model.id).toBe(defaultModel.id);
		expect(toDefault?.thinkingLevel).toBe(Effort.Medium);
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	it("applies slow role thinking when roles share the same model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const smolModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const slowModel = getAnthropicModelOrThrow("claude-opus-4-5");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Medium,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				smol: `${smolModel.provider}/${smolModel.id}:low`,
				slow: `${slowModel.provider}/${slowModel.id}:high`,
			},
		});

		const toSmol = await session.cycleRoleModels(["slow", "default", "smol"]);
		expect(toSmol?.role).toBe("smol");
		expect(toSmol?.thinkingLevel).toBe(Effort.Low);
		expect(session.thinkingLevel).toBe(Effort.Low);

		const toSlow = await session.cycleRoleModels(["slow", "default", "smol"]);
		expect(toSlow?.role).toBe("slow");
		expect(toSlow?.model.id).toBe(slowModel.id);
		expect(toSlow?.thinkingLevel).toBe(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("preserves explicit role thinking when updating default model despite unresolved previous model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: "anthropic/nonexistent-model:off",
			},
		});

		await session.setModel(slowModel, "default", { persist: true });

		expect(sessionSettings.getModelRole("default")).toBe(`${slowModel.provider}/${slowModel.id}:off`);
	});

	it("clamps unsupported selections from model metadata", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		session.setThinkingLevel(Effort.XHigh);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(session.getAvailableThinkingLevels()).not.toContain("xhigh");
	});

	it("clamps max selections down to the ladder ceiling on models without a max tier", async () => {
		// Budget-mode sonnet-4-5 tops out at xhigh; a max request must clamp down.
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		session.setThinkingLevel(Effort.Max);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		expect(session.getAvailableThinkingLevels()).not.toContain("max");
	});

	it("cycles through off before wrapping back to effort levels", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.High,
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		expect(session.cycleThinkingLevel()).toBe("off");
		expect(session.thinkingLevel).toBe("off");
		expect(agent.state.disableReasoning).toBe(true);

		const firstEffort = session.getAvailableThinkingLevels()[0];
		expect(firstEffort).toBeDefined();
		expect(session.cycleThinkingLevel()).toBe(firstEffort);
		expect(session.thinkingLevel).toBe(firstEffort);
		expect(agent.state.disableReasoning).toBe(false);

		// Re-setting the same level writes no duplicate receipt.
		const receiptCount = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "thinking_level_change").length;
		session.setThinkingLevel(firstEffort);
		expect(session.sessionManager.getEntries().filter(entry => entry.type === "thinking_level_change")).toHaveLength(
			receiptCount,
		);
	});

	it("cycles through max as the final tier on a max-capable model", async () => {
		const model = getAnthropicModelOrThrow("claude-opus-4-7");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.XHigh,
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		const available = session.getAvailableThinkingLevels();
		expect(available.at(-1)).toBe(Effort.Max);

		session.setThinkingLevel(Effort.XHigh);
		expect(session.cycleThinkingLevel()).toBe(Effort.Max);
		expect(session.thinkingLevel).toBe(Effort.Max);
		// max is the last tier: the wheel wraps back to off.
		expect(session.cycleThinkingLevel()).toBe("off");
	});

	it("applies matching role thinking to temporary model picks", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const temporaryModel = getBundledModel("google-antigravity", "gemini-3.5-flash");
		if (!temporaryModel) throw new Error("Expected google-antigravity model gemini-3.5-flash to exist");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Low,
			modelRoles: {
				smol: `${temporaryModel.provider}/${temporaryModel.id}:high`,
			},
			runtimeApiKeys: {
				[temporaryModel.provider]: "test-key",
			},
		});

		const roleResolved = session.resolveRoleModelWithThinking("smol");
		expect(roleResolved.model?.id).toBe(temporaryModel.id);
		expect(roleResolved.thinkingLevel).toBe(Effort.High);

		const roleThinkingLevel = session.resolveTemporaryModelThinkingLevel(temporaryModel);
		await session.setModelTemporary(temporaryModel, roleThinkingLevel);

		expect(session.model?.provider).toBe(temporaryModel.provider);
		expect(session.model?.id).toBe(temporaryModel.id);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("ignores a stale recorded role and cycles from the active model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				slow: `${slowModel.provider}/${slowModel.id}`,
			},
		});

		// Record a model_change for the "slow" role WITHOUT switching the
		// active model — the session still runs the default model. This is the
		// stale state left behind when the model is changed through another
		// surface (alt+m, temporary model, /model) after a role cycle.
		session.sessionManager.appendModelChange(`${slowModel.provider}/${slowModel.id}`, "slow");
		expect(session.sessionManager.getLastModelChangeRole()).toBe("slow");
		expect(session.model?.id).toBe(defaultModel.id);

		// The recorded role's resolved model (4-6) no longer equals the active
		// model (4-5), so the cycle position must fall back to model equality
		// and point at "default" — not trust the stale "slow" slot.
		const cycle = session.getRoleModelCycle(["default", "slow"]);
		if (!cycle) throw new Error("Expected a resolved role model cycle");
		expect(cycle.models.map(entry => entry.role)).toEqual(["default", "slow"]);
		expect(cycle.currentIndex).toBe(0);
		expect(cycle.models[cycle.currentIndex]?.role).toBe("default");

		// Cycling advances from the ACTIVE model's position: default → slow.
		// With the stale slot trusted, the cycle would compute slow → default
		// and "switch" right back onto the model already running.
		const result = await session.cycleRoleModels(["default", "slow"]);
		expect(result?.role).toBe("slow");
		expect(result?.model.id).toBe(slowModel.id);
		expect(session.model?.id).toBe(slowModel.id);
	});
});
