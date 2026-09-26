import { afterEach, expect, test, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { Settings } from "../config/settings";
import { registerWakeTurnOwner } from "../orchestrator/wake-turns";
import * as sdkModule from "../sdk";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { CustomMessage } from "../session/messages";
import { emptySubagentUsageTotals } from "../session/session-entries";
import type { ToolSession } from "../tools";
import { YieldTool } from "../tools/yield";
import { EventBus } from "../utils/event-bus";
import { attachWakeTurnMonitor, finalizeSubprocessOutput, runSubprocess } from "./executor";
import type { SingleResult, YieldItem } from "./types";

afterEach(() => {
	vi.restoreAllMocks();
});

function finalize(yieldItems: YieldItem[], outputSchema?: unknown): string {
	return finalizeSubprocessOutput({
		rawOutput: "",
		exitCode: 0,
		stderr: "",
		doneAborted: false,
		signalAborted: false,
		yieldItems,
		outputSchema,
	}).rawOutput;
}

// Regression: agent("Reply with exactly: handle-ok") returned '{"text": "handle-ok"}' because the schemaless
// yield tool only accepted an object, forcing the model to invent a wrapper around its plain answer.
test("a schemaless yield accepts a plain-text answer as result.data", () => {
	const tool = new YieldTool({} as unknown as ToolSession);
	const args = validateToolArguments(tool, {
		type: "toolCall",
		id: "call-1",
		name: "yield",
		arguments: { result: { data: "handle-ok" } },
	});
	expect(args).toEqual({ result: { data: "handle-ok" } });
});

// Regression: a schemaless `result.data: "second"` surfaced as the JSON literal '"second"'.
test("a schemaless string result is returned as the plain answer, not a JSON encoding", () => {
	expect(finalize([{ status: "success", data: "second" }])).toBe("second");
});

test("a result produced under an output schema stays JSON-encoded", () => {
	const schema = { type: "string" };
	expect(finalize([{ status: "success", data: "second" }], schema)).toBe('"second"');
});

function assistant(text: string, content: AssistantMessage["content"] = [{ type: "text", text }]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "fixture",
		model: "fixture",
		stopReason: "stop",
		timestamp: 1,
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

// Regression: a worker woken by a fleet message answered "24", was then steered and answered with the message
// text; orchestrate_wait reported the turn as "24ack from Main (dogfood fleet send test)".
test("a wake turn's result is only its final answer, not every reply glued together", async () => {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	let wakeObserver:
		| ((records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined)
		| undefined;
	const first = assistant("24");
	const final = assistant("ack from Main (dogfood fleet send test)");
	const session = {
		sessionManager: { getSubagentUsage: () => emptySubagentUsageTotals() },
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		setWakeTurnObserver: (observer: typeof wakeObserver) => {
			wakeObserver = observer;
		},
		getLastAssistantMessage: () => final,
	} as unknown as AgentSession;
	const settled = Promise.withResolvers<SingleResult>();
	using _owner = {
		[Symbol.dispose]: registerWakeTurnOwner("wake-final-answer", () => ({
			progress: () => {},
			settle: result => settled.resolve(result),
			fail: error => settled.reject(error),
		})),
	};
	attachWakeTurnMonitor(session, {
		id: "wake-final-answer",
		agent: { name: "worker", description: "test", systemPrompt: "test", source: "bundled" },
	});

	const finish = wakeObserver?.([
		{ role: "custom", customType: "irc:incoming", content: "ack from Main", display: true, timestamp: 1 },
	] as CustomMessage[]);
	const emit = (event: AgentSessionEvent): void => {
		for (const listener of [...listeners]) listener(event);
	};
	emit({ type: "message_end", message: first } as AgentSessionEvent);
	emit({ type: "message_end", message: final } as AgentSessionEvent);
	emit({ type: "agent_end", messages: [first, final] } as AgentSessionEvent);
	await finish?.();

	expect((await settled.promise).output).toBe("ack from Main (dogfood fleet send test)");
});

// Regression: workers that wrote their report and then called `yield {type: "result"}` without data were marked
// failed with "Subagent called yield with null data." followed by all their narration glued together, because the
// data-less yield looked for text on the session's last assistant message — the text-less yield call itself.
test("a data-less terminal yield adopts the run's final answer, without earlier narration", async () => {
	const narration = assistant("Now reproduce items first. Let me write a scratch repro script.");
	const report = assistant("All three items fixed; tests pass.");
	const yieldCall = assistant("", [
		{ type: "toolCall", id: "yield-1", name: "yield", arguments: { result: {}, type: "result" } },
	]);
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent): void => {
		for (const listener of [...listeners]) listener(event);
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
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		prompt: async () => {
			for (const message of [narration, report, yieldCall])
				emit({ type: "message_end", message } as AgentSessionEvent);
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-1",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", type: "result", useLastTurn: true },
				},
				isError: false,
			} as AgentSessionEvent);
			emit({ type: "agent_end", messages: [narration, report, yieldCall] } as AgentSessionEvent);
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => yieldCall,
		abort: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose: async () => {},
		setWakeTurnObserver: () => {},
		getAsyncJobOwnerId: () => undefined,
		subscribeRunState: () => () => {},
	} as unknown as AgentSession;
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} },
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} as unknown as sdkModule.CreateAgentSessionResult);

	const result = await runSubprocess({
		cwd: "/tmp",
		agent: { name: "worker", description: "test", systemPrompt: "test", source: "bundled" },
		task: "fix the bugs",
		index: 0,
		id: "last-turn-yield",
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as never,
		eventBus: new EventBus(),
	});

	expect(result.exitCode).toBe(0);
	expect(result.output).toBe("All three items fixed; tests pass.");
});
