import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../config/settings";
import * as sdkModule from "../sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../session/agent-session";
import { EventBus } from "../utils/event-bus";
import { runSubprocess } from "./executor";
import { type AgentDefinition, type SubagentProgressPayload, WORKER_SUBAGENT_PROGRESS_CHANNEL } from "./types";

function createMockSession(onPrompt: (emit: (event: AgentSessionEvent) => void) => void): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent): void => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			onPrompt(emit);
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		getAsyncJobOwnerId: () => undefined,
		subscribeRunState: () => () => {},
	};
	return session as unknown as AgentSession;
}

function yieldEmittingSession(): AgentSession {
	return createMockSession(emit => {
		emit({
			type: "tool_execution_end",
			toolCallId: "tool-progress-projection",
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { complete: true } },
			},
			isError: false,
		});
	});
}

function createSessionResult(session: AgentSession): sdkModule.CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {
			extensions: [],
			errors: [],
			runtime: {} as unknown,
		} as unknown as sdkModule.LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

const baseAgent: AgentDefinition = {
	name: "worker",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("subagent progress event projection", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps yield output in the run result while omitting it from progress events", async () => {
		const session = yieldEmittingSession();
		const eventBus = new EventBus();
		const progressPayloads: SubagentProgressPayload[] = [];
		eventBus.on(WORKER_SUBAGENT_PROGRESS_CHANNEL, data => {
			progressPayloads.push(data as SubagentProgressPayload);
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id: "progress-projection",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as never,
			eventBus,
		});

		expect(result.exitCode).toBe(0);
		expect(result.extractedToolData?.yield).toEqual([{ data: { complete: true }, status: "success" }]);
		expect(progressPayloads.length).toBeGreaterThan(0);
		expect(progressPayloads.every(payload => !Object.hasOwn(payload.progress, "extractedToolData"))).toBe(true);
	});
});
