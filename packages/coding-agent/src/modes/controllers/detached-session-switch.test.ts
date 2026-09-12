import { afterEach, beforeEach, expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import type { InteractiveModeContext } from "../../modes/types";
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { AgentSession } from "../../session/agent-session";
import { AuthStorage } from "../../session/auth-storage";
import { detachedSessionHolder } from "../../session/detached-session-holder";
import { SessionManager } from "../../session/session-manager";
import { SelectorController } from "./selector-controller";

interface StreamingSession {
	session: AgentSession;
	file: string;
	release(): void;
}

function answer(model: Model, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function createStreamingSession(
	dir: string,
	model: Model,
	modelRegistry: ModelRegistry,
	settings: Settings,
	text: string,
): StreamingSession {
	const manager = SessionManager.create(dir, dir);
	const gate = Promise.withResolvers<void>();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: () => {
			const stream = createAssistantMessageEventStream();
			void gate.promise.then(() => stream.push({ type: "done", reason: "stop", message: answer(model, text) }));
			return stream;
		},
	});
	return {
		session: new AgentSession({ agent, sessionManager: manager, settings, modelRegistry }),
		file: manager.getSessionFile()!,
		release: () => gate.resolve(),
	};
}

async function waitForStreaming(session: AgentSession): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt++) {
		if (session.isStreaming) return;
		await Bun.sleep(1);
	}
	throw new Error("Session did not begin streaming");
}

let tempDir: TempDir;
let authStorage: AuthStorage;

beforeEach(async () => {
	tempDir = TempDir.createSync("detached-session-switch-");
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	AgentRegistry.resetGlobalForTests();
	await detachedSessionHolder.disposeAll();
});

afterEach(async () => {
	await detachedSessionHolder.disposeAll();
	AgentRegistry.resetGlobalForTests();
	authStorage.close();
	tempDir.removeSync();
});

test("reattaching a detached turn restores its main ownership and live fleet", async () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"session.detachedMainSessions": true,
	});
	const modelRegistry = new ModelRegistry(authStorage);
	const a = createStreamingSession(tempDir.path(), model, modelRegistry, settings, "A done");
	const b = createStreamingSession(tempDir.path(), model, modelRegistry, settings, "B done");
	const runA = a.session.prompt("run A");
	const runB = b.session.prompt("run B");
	await Promise.all([waitForStreaming(a.session), waitForStreaming(b.session)]);

	const registry = AgentRegistry.global();
	const fleetA = `${a.file.slice(0, -".jsonl".length)}/fleet`;
	const fleetB = `${b.file.slice(0, -".jsonl".length)}/fleet`;
	registry.register({
		id: MAIN_AGENT_ID,
		displayName: "main",
		kind: "main",
		fleetRoot: fleetA,
		sessionFile: a.file,
		session: a.session,
	});
	registry.register({
		id: "worker-a",
		displayName: "worker-a",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		fleetRoot: fleetA,
		status: "running",
		session: null,
	});
	registry.register({
		id: MAIN_AGENT_ID,
		displayName: "main",
		kind: "main",
		fleetRoot: fleetB,
		sessionFile: b.file,
		session: b.session,
	});
	registry.register({
		id: "worker-b",
		displayName: "worker-b",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		fleetRoot: fleetB,
		status: "running",
		session: null,
	});
	detachedSessionHolder.park(a.file, a.session, a.session.sessionManager);

	const actions: string[] = [];
	const mutable = {
		session: b.session,
		agent: b.session.agent,
		settings,
		eventBus: undefined,
		mcpManager: undefined,
		getToolUIContext: () => undefined,
		attachSessionView: async () => {
			actions.push("attach");
		},
		clearTransientSessionUi: () => actions.push("clear"),
		applyCwdChange: async () => {},
		renderInitialMessages: async () => {},
		reloadTodos: async () => {},
		updateEditorBorderColor: () => {},
		showStatus: () => {},
		showError: () => {},
	};
	Object.defineProperty(mutable, "sessionManager", {
		get: () => mutable.session.sessionManager,
	});
	const ctx = mutable as unknown as InteractiveModeContext;

	try {
		expect(await new SelectorController(ctx).handleResumeSession(a.file, { settingsFlushed: true })).toBe(true);

		expect(ctx.session).toBe(a.session);
		expect(a.session.isStreaming).toBe(true);
		expect(b.session.isStreaming).toBe(true);
		expect(registry.get(MAIN_AGENT_ID)?.session).toBe(a.session);
		expect(registry.get(MAIN_AGENT_ID)?.fleetRoot).toBe(fleetA);
		expect(registry.listVisibleTo(MAIN_AGENT_ID).map(ref => ref.id)).toContain("worker-a");
		expect(registry.listVisibleTo(MAIN_AGENT_ID).map(ref => ref.id)).not.toContain("worker-b");
		expect(actions).toEqual(["clear", "attach"]);
	} finally {
		a.release();
		b.release();
		await Promise.allSettled([runA, runB]);
		await a.session.dispose();
		await b.session.dispose();
	}
});

test("switching away keeps an idle main detached while its worker is running", async () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model");
	const settings = Settings.isolated({ "session.detachedMainSessions": true });
	const modelRegistry = new ModelRegistry(authStorage);
	const a = createStreamingSession(tempDir.path(), model, modelRegistry, settings, "A done");
	const b = createStreamingSession(tempDir.path(), model, modelRegistry, settings, "B done");
	const registry = AgentRegistry.global();
	const fleetA = `${a.file.slice(0, -".jsonl".length)}/fleet`;
	const fleetB = `${b.file.slice(0, -".jsonl".length)}/fleet`;
	registry.register({
		id: MAIN_AGENT_ID,
		displayName: "main",
		kind: "main",
		fleetRoot: fleetA,
		sessionFile: a.file,
		session: a.session,
	});
	registry.register({
		id: MAIN_AGENT_ID,
		displayName: "main",
		kind: "main",
		fleetRoot: fleetB,
		sessionFile: b.file,
		session: b.session,
	});
	registry.register({
		id: "worker-b",
		displayName: "worker-b",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		fleetRoot: fleetB,
		status: "running",
		session: null,
	});
	detachedSessionHolder.park(a.file, a.session, a.session.sessionManager);
	const mutable = {
		session: b.session,
		agent: b.session.agent,
		settings,
		eventBus: undefined,
		mcpManager: undefined,
		getToolUIContext: () => undefined,
		attachSessionView: async () => {},
		clearTransientSessionUi: () => {},
		applyCwdChange: async () => {},
		renderInitialMessages: async () => {},
		reloadTodos: async () => {},
		updateEditorBorderColor: () => {},
		showStatus: () => {},
		showError: () => {},
	};
	Object.defineProperty(mutable, "sessionManager", {
		get: () => mutable.session.sessionManager,
	});

	try {
		const ctx = mutable as unknown as InteractiveModeContext;
		expect(await new SelectorController(ctx).handleResumeSession(a.file, { settingsFlushed: true })).toBe(true);

		expect(ctx.session).toBe(a.session);
		expect(detachedSessionHolder.peek(b.file)?.session).toBe(b.session);
		expect(b.session.isDisposed).toBe(false);
		expect(registry.getInFleet("worker-b", fleetB)?.status).toBe("running");
	} finally {
		await a.session.dispose();
		await detachedSessionHolder.disposeAll();
	}
});
