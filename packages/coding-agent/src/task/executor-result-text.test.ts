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

// Regression: a schema-bearing yield without data reported a "valid" structured result built from the warning text,
// and strict mode completed the run instead of failing it.
test.each(["permissive", "strict"] as const)("a %s schema run that yields no data is an invalid result", mode => {
	const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
	const result = finalizeSubprocessOutput({
		rawOutput: "",
		exitCode: 0,
		stderr: "",
		doneAborted: false,
		signalAborted: false,
		yieldItems: [{ status: "success" }],
		outputSchema: schema,
		outputSchemaMode: mode,
		outputSchemaSource: "agent",
	});
	expect(result.structuredOutput).toMatchObject({ status: "invalid", mode });
	expect(result.exitCode).toBe(mode === "strict" ? 1 : 0);
	if (mode === "strict") expect(result.stderr).toBe("schema_violation: missing required fields: answer");
});

// Regression: a worker re-yielding a schema-declared scalar section (a revised `explanation` after its jobs settled)
// assembled `["A", "B"]`, which the schema rejected; scalars keep the latest value, arrays still accumulate.
test("a repeated scalar section keeps its latest value while array sections accumulate", () => {
	const output = finalize(
		[
			{ status: "success", type: ["findings"], data: { title: "first" } },
			{ status: "success", type: ["findings"], data: { title: "second" } },
			{ status: "success", type: ["explanation"], data: "Before jobs settled." },
			{ status: "success", type: "result" },
			{ status: "success", type: ["explanation"], data: "After jobs settled." },
			{ status: "success", type: "result" },
		],
		{
			properties: { explanation: { type: "string" } },
			optionalProperties: { findings: { elements: { properties: { title: { type: "string" } } } } },
		},
	);
	expect(JSON.parse(output)).toEqual({
		findings: [{ title: "first" }, { title: "second" }],
		explanation: "After jobs settled.",
	});
});

test("section shapes come from JTD discriminator variants", () => {
	const output = finalize(
		[
			{ status: "success", type: ["kind"], data: "review" },
			{ status: "success", type: ["verdict"], data: "draft" },
			{ status: "success", type: ["notes"], data: "only note" },
			{ status: "success", type: ["verdict"], data: "final" },
			{ status: "success", type: "result" },
		],
		{
			discriminator: "kind",
			mapping: {
				review: { properties: { verdict: { type: "string" }, notes: { elements: { type: "string" } } } },
				skip: { properties: { verdict: { type: "string" } } },
			},
		},
	);
	expect(JSON.parse(output)).toEqual({ kind: "review", verdict: "final", notes: ["only note"] });
});

test("a replaced scalar section drops the discarded value's schema override", () => {
	const result = finalizeSubprocessOutput({
		rawOutput: "",
		exitCode: 0,
		stderr: "",
		doneAborted: false,
		signalAborted: false,
		outputSchemaMode: "strict",
		outputSchemaSource: "caller",
		outputSchema: { type: "object", required: ["explanation"], properties: { explanation: { type: "string" } } },
		yieldItems: [
			{ status: "success", type: ["explanation"], data: 42, schemaOverridden: true },
			{ status: "success", type: "result" },
			{ status: "success", type: ["explanation"], data: "Corrected after jobs settled." },
			{ status: "success", type: "result" },
		],
	});
	expect(result.exitCode).toBe(0);
	expect(result.structuredOutput).toEqual({
		source: "caller",
		mode: "strict",
		status: "valid",
		data: { explanation: "Corrected after jobs settled." },
	});
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
// text; jobs wait reported the turn as "24ack from Main (dogfood fleet send test)".
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
		getToolByName: () => undefined,
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

async function runDataLessYield(id: string, turns: AssistantMessage[]): Promise<SingleResult> {
	const yieldCall = assistant("", [
		{ type: "toolCall", id: "yield-1", name: "yield", arguments: { result: {}, type: "result" } },
	]);
	const messages = [...turns, yieldCall];
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
			for (const message of messages) emit({ type: "message_end", message } as AgentSessionEvent);
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
			emit({ type: "agent_end", messages } as AgentSessionEvent);
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => yieldCall,
		getToolByName: () => undefined,
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

	return runSubprocess({
		cwd: "/tmp",
		agent: { name: "worker", description: "test", systemPrompt: "test", source: "bundled" },
		task: "fix the bugs",
		index: 0,
		id,
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as never,
		eventBus: new EventBus(),
	});
}

// Regression: workers that wrote their report and then called `yield {type: "result"}` without data were marked
// failed with "Subagent called yield with null data." followed by all their narration glued together, because the
// data-less yield looked for text on the session's last assistant message — the text-less yield call itself.
test("a data-less terminal yield adopts the run's final answer, without earlier narration", async () => {
	const result = await runDataLessYield("last-turn-yield", [
		assistant("Now reproduce items first. Let me write a scratch repro script."),
		assistant("All three items fixed; tests pass."),
	]);

	expect(result.exitCode).toBe(0);
	expect(result.output).toBe("All three items fixed; tests pass.");
});

// A turn that started more work is narration, not a report: a later text-less finalize must not pass it (or an
// earlier report it invalidated) off as the completed result.
test("a data-less terminal yield never adopts narration from a turn that resumed work", async () => {
	const staleReport = "Everything is done; nothing left to change.";
	const narration = "Actually one more fix.";
	const result = await runDataLessYield("resumed-work-yield", [
		assistant(staleReport),
		assistant(narration, [
			{ type: "text", text: narration },
			{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "bun test" } },
		]),
	]);

	expect(result.output).toContain("Subagent called yield with null data.");
	expect(result.output).not.toBe(staleReport);
	expect(result.output).not.toBe(narration);
});
