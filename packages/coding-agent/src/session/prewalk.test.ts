import { expect, test } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ThinkingLevel } from "../thinking";
import { PREWALK_PLAN_MESSAGE_TYPE } from "./messages";
import { PrewalkCoordinator, type PrewalkCoordinatorHost } from "./prewalk";
import type { SessionManager } from "./session-manager";

const bundled = getBundledModel("openai", "gpt-4.1");
if (!bundled) throw new Error("Missing test model");
const source: Model = bundled;
const target: Model = { ...source, id: "prewalk-target" };

function fixture() {
	const agent = new Agent({ initialState: { model: source, tools: [], messages: [] } });
	const selections: Model[] = [];
	const warnings: string[] = [];
	let level: ThinkingLevel | undefined;
	let failRestore = false;
	const host: PrewalkCoordinatorHost = {
		agent,
		sessionManager: {} as SessionManager,
		model: () => agent.state.model,
		configuredThinkingLevel: () => level,
		restoreThinkingLevel: value => {
			level = value;
		},
		resolveDefaultPrewalk: () => ({ target }),
		emitNotice: (kind, message) => {
			if (kind === "warning") warnings.push(message);
		},
		setModelTemporary: async (model, thinking) => {
			if (failRestore && model === source) throw new Error("No API key");
			agent.setModel(model);
			level = thinking;
			selections.push(model);
		},
		setActiveToolsByName: async () => {},
		runToolRegistryMutation: run => run(),
		getActiveToolNames: () => [],
		getEnabledToolNames: () => [],
		waitForSessionMessagePersistence: async () => {},
	};
	const coordinator = new PrewalkCoordinator(host);
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "Implementing" }],
		api: source.api,
		provider: source.provider,
		model: source.id,
		usage: {
			input: 0,
			output: 0,
			totalTokens: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "edit",
		toolName: "edit",
		content: [{ type: "text", text: "edited" }],
		isError: false,
		timestamp: 2,
	};
	return {
		agent,
		coordinator,
		selections,
		warnings,
		failRestore: () => {
			failRestore = true;
		},
		handoff: async () => {
			coordinator.arm(target);
			await coordinator.advanceAtTurnEnd(agent.state.messages, {
				message,
				toolResults: [result],
				additionalMessages: [],
				willContinue: false,
			});
		},
	};
}

test("disarming cancels pending guidance but retains delivered continuation and other queued input", () => {
	const f = fixture();
	f.coordinator.arm(target);
	const delivered: AgentMessage = {
		role: "custom",
		customType: "prewalk-continue",
		content: "continue",
		attribution: "agent",
		display: false,
		timestamp: 1,
	};
	f.agent.appendMessage(delivered);
	f.agent.appendMessage({ ...delivered, customType: PREWALK_PLAN_MESSAGE_TYPE });
	f.agent.steer(delivered);
	const user: AgentMessage = { role: "user", content: "operator steer", timestamp: 3 };
	f.agent.steer(user);
	f.agent.followUp(user);
	f.coordinator.disarm();
	expect(f.coordinator.state).toBeUndefined();
	expect(f.agent.state.messages).toEqual([delivered]);
	expect(f.agent.peekSteeringQueue()).toEqual([user]);
	expect(f.agent.peekFollowUpQueue()).toEqual([user]);
	expect(f.selections).toEqual([]);
});

test("a configured new session restores its planning model and re-arms without queuing into an empty transcript", async () => {
	const f = fixture();
	await f.handoff();
	expect(f.agent.state.model).toBe(target);
	f.agent.clearAllQueues();
	await f.coordinator.resetForNewSession(true);
	expect(f.selections).toEqual([target, source]);
	expect(f.coordinator.state?.target).toBe(target);
	expect(f.agent.peekSteeringQueue()).toEqual([]);
});

test("an explicit selection owns the model even when it reselects the prewalk target", async () => {
	const f = fixture();
	await f.handoff();
	f.coordinator.releaseHandoff();
	await f.coordinator.resetForNewSession(true);
	expect(f.selections).toEqual([target]);
	expect(f.coordinator.state).toBeUndefined();
});

test("a planning-model restore failure warns but still completes new-session setup", async () => {
	const f = fixture();
	await f.handoff();
	f.failRestore();
	await f.coordinator.resetForNewSession(true);
	expect(f.warnings).toHaveLength(1);
	expect(f.warnings[0]).toContain("No API key");
	expect(f.coordinator.state).toBeUndefined();
});

test("a new session with prewalk disabled never restores or rearms a completed handoff", async () => {
	const f = fixture();
	await f.handoff();
	await f.coordinator.resetForNewSession(false);
	expect(f.selections).toEqual([target]);
	expect(f.coordinator.state).toBeUndefined();
});
