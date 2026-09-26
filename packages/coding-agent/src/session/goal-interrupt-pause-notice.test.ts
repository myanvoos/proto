/**
 * An Esc interrupt pauses the active goal, but the model was never told: after "go on" it kept working on a goal it
 * believed active while continuation nudges and budget accounting had stopped. The next user turn now carries a
 * one-shot reminder to resume the goal or leave it paused.
 */
import { afterEach, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { renderGoalPrompt } from "../goals/runtime";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "./messages";
import { SessionManager } from "./session-manager";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
});

/** A session whose active goal an Esc interrupt paused mid-turn; every later model call answers "ok". */
async function interruptedGoalSession(): Promise<{ session: AgentSession; mock: MockModel; reminder: string }> {
	const started = Promise.withResolvers<void>();
	const mock = createMockModel({
		responses: [
			() => {
				started.resolve();
				return { content: ["working"], delayMs: 60_000 };
			},
		],
		handler: { content: ["ok"] },
	});
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5"), systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage),
	});
	cleanup = async () => {
		await session.dispose();
		authStorage.close();
	};

	await session.goalRuntime.createGoal({ objective: "Ship the widget" });
	const run = session.prompt("start");
	await started.promise;
	await session.abort({ reason: USER_INTERRUPT_LABEL });
	await run;

	const goal = session.getGoalModeState()?.goal;
	if (goal?.status !== "paused") throw new Error(`expected the interrupt to pause the goal, got ${goal?.status}`);
	return { session, mock, reminder: renderGoalPrompt("interrupt-paused", goal) };
}

/** Number of messages in a model call's context that carry the reminder. */
function reminderCount(context: Context, reminder: string): number {
	return context.messages.filter(message =>
		typeof message.content === "string"
			? message.content.includes(reminder)
			: message.content.some(part => part.type === "text" && part.text.includes(reminder)),
	).length;
}

it("tells the model once, on the next user turn, that an interrupt paused its goal", async () => {
	const { session, mock, reminder } = await interruptedGoalSession();

	await session.prompt("background job finished", { synthetic: true });
	await session.prompt("go on");
	await session.prompt("status?");

	// Model calls: interrupted "start", hidden non-user turn, "go on" (reminder injected), "status?" (history only).
	expect(mock.calls.map(call => reminderCount(call.context, reminder))).toEqual([0, 0, 1, 1]);
});

it("does not remind about a goal resumed before the next user turn", async () => {
	const { session, mock, reminder } = await interruptedGoalSession();

	await session.goalRuntime.resumeGoal();
	await session.prompt("go on");

	expect(mock.calls.map(call => reminderCount(call.context, reminder))).toEqual([0, 0]);
});
