import { afterEach, expect, test, vi } from "bun:test";
import { Settings } from "../config/settings";
import * as sdkModule from "../sdk";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { ASYNC_RESULT_MESSAGE_TYPE } from "../session/async-job-delivery";
import { emptySubagentUsageTotals } from "../session/session-entries";
import { EventBus } from "../utils/event-bus";
import { runSubprocess } from "./executor";
import type { AgentDefinition } from "./types";

type Emit = (event: AgentSessionEvent) => void;
type Turn = (emit: Emit) => void;

const agent: AgentDefinition = { name: "worker", description: "test", systemPrompt: "test", source: "bundled" };

function yieldTurn(data: unknown): Turn {
	return emit => {
		emit({ type: "tool_execution_start", toolCallId: "call", toolName: "yield" } as unknown as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "call",
			toolName: "yield",
			result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success", data } },
			isError: false,
		} as unknown as AgentSessionEvent);
	};
}

/** A turn that answers with prose instead of a `yield` — the shape that leaves a stale report. */
const proseTurn: Turn = () => {};

/**
 * A worker that owns a background job. `prompt` runs the next scripted turn; `settleAsyncWork`
 * delivers the job result the way the session injects it, then runs the turn the worker takes in
 * response. Extra prompts past the script answer with prose, so an unbounded chase would show up
 * as an unbounded prompt count.
 */
function asyncJobSession(turns: Turn[]): { session: AgentSession; prompts: () => number } {
	const listeners: Emit[] = [];
	const emit: Emit = event => {
		for (const listener of listeners) listener(event);
	};
	let next = 0;
	let promptCount = 0;
	let jobPending = true;
	const runNext = (): void => {
		const turn = turns[next++] ?? proseTurn;
		turn(emit);
	};
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {}, getSubagentUsage: () => emptySubagentUsageTotals() },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: Emit) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			promptCount++;
			runNext();
		},
		hasPendingAsyncWork: () => jobPending,
		getAsyncJobSnapshot: () => ({ running: [{ id: "job-1", label: "child worker" }] }),
		settleAsyncWork: async () => {
			jobPending = false;
			emit({
				type: "message_start",
				message: { role: "custom", customType: ASYNC_RESULT_MESSAGE_TYPE },
			} as unknown as AgentSessionEvent);
			runNext();
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => ({ role: "assistant", content: [], stopReason: "stop" }),
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		getAsyncJobOwnerId: () => undefined,
		subscribeRunState: () => () => {},
	};
	return { session: session as unknown as AgentSession, prompts: () => promptCount };
}

function run(session: AgentSession, id: string) {
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: {
			extensions: [],
			errors: [],
			runtime: {} as unknown,
		} as unknown as sdkModule.LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	});
	return runSubprocess({
		cwd: "/tmp",
		agent,
		task: "spawn a child and report",
		index: 0,
		id,
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as never,
		eventBus: new EventBus(),
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

// The worker yields, is told its job is still running, yields again while it waits, and yields once
// more when the result lands. Only the last yield covers the result, and that is the one delivered.
test("a worker that re-yields after its background result lands completes with the refreshed report", async () => {
	const { session, prompts } = asyncJobSession([
		yieldTurn({ phase: "one" }),
		proseTurn,
		yieldTurn({ phase: "two", covered: "child result" }),
	]);

	const result = await run(session, "async-yield-refreshed");

	expect(result.exitCode).toBe(0);
	expect(result.error).toBeUndefined();
	expect(result.output).toContain("child result");
	expect(result.extractedToolData?.yield).toEqual([
		{ data: { phase: "one" }, status: "success" },
		{ data: { phase: "two", covered: "child result" }, status: "success" },
	]);
	// One prompt for the task, one for the still-running notice: the result itself is not a prompt.
	expect(prompts()).toBe(2);
});

// Regression: a stale report must be reported as stale, the chase for a fresh one must be bounded,
// and the report the worker did produce must still reach the parent instead of being thrown away.
test("a worker that never covers its background result is failed, bounded, and still reports", async () => {
	const { session, prompts } = asyncJobSession([yieldTurn({ phase: "one" })]);

	const result = await run(session, "async-yield-stale");

	expect(result.exitCode).not.toBe(0);
	expect(result.error).toContain("Background job results arrived after the subagent's last yield");
	expect(result.output).toContain("phase");
	expect(result.extractedToolData?.yield).toEqual([{ data: { phase: "one" }, status: "success" }]);
	// task + still-running notice + the 3 yield reminders, then it stops: the chase is bounded.
	expect(prompts()).toBe(5);
});
