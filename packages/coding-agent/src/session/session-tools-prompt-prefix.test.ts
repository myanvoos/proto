import { afterEach, expect, test } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";
import { SessionTools, type SessionToolsHost } from "./session-tools";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0)) await dispose();
});

function capability(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [] }),
	};
}

async function harness(restored?: readonly string[]) {
	const auth = await AuthStorage.create(":memory:");
	const manager = SessionManager.inMemory("/project");
	disposers.push(async () => {
		await manager.close();
		auth.close();
	});
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Missing Anthropic fixture model");
	const model = { ...bundled, thinking: { ...bundled.thinking!, prefixBinding: true } };
	const reply: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: 1,
		stopReason: "stop",
		content: [{ type: "text", text: "retained reply" }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	if (restored) {
		manager.appendCustomEntry("system-prompt", [...restored]);
		manager.appendMessage(reply);
	}
	const one = capability("one");
	const two = capability("two");
	const three = capability("three");
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: [model.id, "one"],
			messages: manager.buildSessionContext().messages,
			tools: [one],
		},
	});
	let cacheClears = 0;
	let gate: Promise<void> | undefined;
	const buildStarted = Promise.withResolvers<void>();
	const host: SessionToolsHost = {
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ includeModelInPrompt: true }),
		modelRegistry: new ModelRegistry(auth),
		extensionRunner: () => undefined,
		agentKind: () => "main",
		isDisposed: () => false,
		isStreaming: () => false,
		queuedMessageCount: () => 0,
		model: () => agent.state.model,
		clearInheritedProviderPromptCacheKey: () => {
			cacheClears++;
		},
		emitNotice: () => {},
		notifyCommandMetadataChanged: () => {},
		localProtocolOptions: () => ({}),
	};
	const tools = new SessionTools(host, {
		toolRegistry: new Map([
			[one.name, one],
			[two.name, two],
			[three.name, three],
		]),
		baseSystemPrompt: agent.state.systemPrompt,
		rebuildSystemPrompt: async names => {
			if (gate) buildStarted.resolve();
			await gate;
			return { systemPrompt: [agent.state.model!.id, names.join(",")] };
		},
	});
	return {
		tools,
		agent,
		manager,
		reply,
		model,
		cacheClears: () => cacheClears,
		waitForBuild: () => buildStarted.promise,
		setGate: (pending: Promise<void>) => {
			gate = pending;
		},
	};
}

test("a resumed tool roster may restore only the exact prompt blocks that produced its reply and keeps its inherited cache key", async () => {
	const id = getBundledModel("anthropic", "claude-sonnet-4-5")!.id;
	const state = await harness([id, "one,two"]);
	await state.tools.applyActiveToolsByName(["one"]);
	await state.tools.applyActiveToolsByName(["one", "two"]);
	expect(state.agent.state.systemPrompt).toEqual([id, "one,two"]);
	expect(state.cacheClears()).toBe(0);
	await state.tools.applyActiveToolsByName(["one", "two", "three"]);
	expect(state.agent.state.systemPrompt).toEqual([id, "one,two"]);
	expect(state.agent.state.tools.map(tool => tool.name)).toContain("three");
});

test("a model call capturing the prefix while a roster rebuild awaits prevents the late rebuild from changing it", async () => {
	const id = getBundledModel("anthropic", "claude-sonnet-4-5")!.id;
	const state = await harness([id, "one,two"]);
	await state.tools.applyActiveToolsByName(["one"]);
	const gate = Promise.withResolvers<void>();
	state.setGate(gate.promise);
	const rebuilding = state.tools.applyActiveToolsByName(["one", "two"]);
	await state.waitForBuild();
	state.tools.recordPrimaryModelCall(state.agent.state.systemPrompt);
	gate.resolve();
	await rebuilding;
	expect(state.agent.state.systemPrompt).toEqual([id, "one"]);
});

test("only provider-output replies record their captured base, not hook overrides or calls stopped before output", async () => {
	const state = await harness();
	const base = ["base", "separate block"];
	state.tools.setTurnSystemPromptOverride(["per-turn override"], base);
	state.tools.recordPrimaryModelCall(state.agent.state.systemPrompt);
	const empty = { ...state.reply, content: [] };
	state.tools.bindReplyToCapturedPrompt(empty);
	state.tools.recordReplyPrompt(empty);
	expect(state.tools.recordedPromptBlocks()).toBeUndefined();
	state.tools.recordPrimaryModelCall(state.agent.state.systemPrompt);
	state.tools.bindReplyToCapturedPrompt(state.reply);
	state.tools.recordReplyPrompt(state.reply);
	state.manager.appendMessage(state.reply);
	expect(state.tools.recordedPromptBlocks()).toEqual(base);
	expect(state.manager.getCustomEntries("system-prompt").map(entry => entry.data)).toEqual([base]);
});

test("rewind carries exact prompt boundaries onto its new branch and disposal drops restoration permission", async () => {
	const state = await harness(["first", "second"]);
	await state.tools.applyActiveToolsByName(["one"]);
	const checkpoint = state.manager.getLeafId()!;
	state.tools.recordPromptBlocks(["firstsecond"]);
	const exploration = state.tools.recordedPromptBlocks();
	state.manager.branchWithSummary(checkpoint, "rewound");
	expect(state.tools.recordedPromptBlocks()).toEqual(["first", "second"]);
	state.tools.recordPromptBlocks(exploration);
	expect(state.tools.recordedPromptBlocks()).toEqual(["firstsecond"]);
	state.tools.releasePromptBindings();
	await state.tools.applyActiveToolsByName(["one", "two"]);
	expect(state.agent.state.systemPrompt).toEqual([state.model.id, "one"]);
});

test("retry fallback preserves the rendered model prefix while a deliberate model change refreshes it", async () => {
	const state = await harness();
	await state.tools.applyActiveToolsByName(["one"]);
	state.agent.setModel({ ...state.model, id: "different-model" });
	await state.tools.syncAfterModelChange({ retryFallback: true });
	expect(state.agent.state.systemPrompt[0]).toBe(state.model.id);
	await state.tools.syncAfterModelChange();
	expect(state.agent.state.systemPrompt[0]).toBe("different-model");
});

test("an actual model request re-records its exact post-hook base blocks without losing the revival tool contract", async () => {
	const auth = await AuthStorage.create(":memory:");
	auth.setRuntimeApiKey("anthropic", "test-key");
	const manager = SessionManager.inMemory("/project");
	manager.appendSessionInit({
		systemPrompt: "legacy initial prompt",
		task: "work",
		tools: ["bash", "read"],
		mountedTools: ["read"],
	});
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["original"], tools: [] },
		streamFn: createMockModel({ responses: [{ content: ["finished"] }] }).stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(auth),
	});
	const exact = ["post-hook", "separate block"];
	agent.addBeforeModelCallHook(() => {
		agent.setSystemPrompt(exact);
	});
	try {
		await agent.prompt({ role: "user", content: "run the request", timestamp: 1 });
		await session.waitForIdle();
		expect(manager.getSessionInit()).toMatchObject({
			systemPrompt: exact,
			tools: ["bash", "read"],
			mountedTools: ["read"],
		});
		expect(manager.getEntries().filter(entry => entry.type === "session_init")).toHaveLength(2);
	} finally {
		await session.dispose();
		auth.close();
	}
});
