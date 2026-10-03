import { afterEach, expect, test, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "../config/settings";
import * as sdkModule from "../sdk";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { emptySubagentUsageTotals } from "../session/session-entries";
import { EventBus } from "../utils/event-bus";
import { runSubprocess } from "./executor";

type Emit = (event: AgentSessionEvent) => void;

const MAX_SECTION_TURNS = 50;

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "fixture",
		model: "fixture",
		stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
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

function emitSectionTurn(emit: Emit, turn: number): void {
	const toolCallId = `section-${turn}`;
	emit({
		type: "message_end",
		message: assistant([
			{
				type: "toolCall",
				id: toolCallId,
				name: "yield",
				arguments: { type: ["findings"], data: `finding ${turn}` },
			},
		]),
	} as AgentSessionEvent);
	emit({
		type: "tool_execution_end",
		toolCallId,
		toolName: "yield",
		result: {
			content: [{ type: "text", text: "Section recorded." }],
			details: { status: "success", type: ["findings"], data: `finding ${turn}` },
		},
		isError: false,
	} as AgentSessionEvent);
}

afterEach(() => {
	vi.restoreAllMocks();
});

// Regression: the reminder ladder's final retry pins `toolChoice` to `yield` for every request of its prompt, and an
// incremental section satisfies the pin without ending the turn — a model answering with sections looped forever.
test("the forced final reminder ends the run at the first accepted section", async () => {
	const listeners: Emit[] = [];
	const emit: Emit = event => {
		for (const listener of [...listeners]) listener(event);
	};
	let prompts = 0;
	let sectionTurns = 0;
	let aborted = false;
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {}, getSubagentUsage: () => emptySubagentUsageTotals() },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		getToolByName: () => undefined,
		subscribe: (listener: Emit) => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		prompt: async () => {
			prompts++;
			// The task and the first two reminders get prose; the final (pinned) reminder keeps answering with sections.
			if (prompts < 4) {
				emit({
					type: "message_end",
					message: assistant([{ type: "text", text: "still working" }]),
				} as AgentSessionEvent);
				return true;
			}
			while (!aborted && sectionTurns < MAX_SECTION_TURNS) {
				emitSectionTurn(emit, ++sectionTurns);
			}
			return true;
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {
			aborted = true;
		},
		hasPendingAsyncWork: () => false,
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
		task: "investigate",
		index: 0,
		id: "pinned-sections",
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as never,
		eventBus: new EventBus(),
	});

	expect(result.error).toBeUndefined();
	expect(prompts).toBe(4);
	expect(sectionTurns).toBe(1);
	expect(result.exitCode).toBe(0);
	expect(result.output).toContain("finding 1");
});
