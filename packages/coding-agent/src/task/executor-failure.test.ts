import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "../config/settings";
import { AgentProtocolHandler } from "../internal-urls/agent-protocol";
import { registerArtifactsDir } from "../internal-urls/registry-helpers";
import type { InternalUrl } from "../internal-urls/types";
import { registerWakeTurnOwner } from "../orchestrator/wake-turns";
import * as sdkModule from "../sdk";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { CustomMessage } from "../session/messages";
import { emptySubagentUsageTotals } from "../session/session-entries";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";
import { EventBus } from "../utils/event-bus";
import { runSubprocess } from "./executor";
import type { AgentDefinition, SingleResult } from "./types";

const PROVIDER_FAILURE = "usage_limit_reached: monthly quota exhausted";

function assistantMessage(fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "fixture",
		model: "fixture",
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...fields,
	} as AssistantMessage;
}

function failingSession(failure: Partial<AssistantMessage>): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const message = assistantMessage({ stopReason: "error", ...failure });
	return {
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
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			for (const listener of listeners) listener({ type: "message_end", message } as AgentSessionEvent);
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => message,
		abort: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose: async () => {},
		setWakeTurnObserver: () => {},
		getAsyncJobOwnerId: () => undefined,
		subscribeRunState: () => () => {},
	} as unknown as AgentSession;
}

function sessionResult(session: AgentSession): sdkModule.CreateAgentSessionResult {
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

const agent: AgentDefinition = { name: "worker", description: "test", systemPrompt: "test", source: "bundled" };

afterEach(() => {
	vi.restoreAllMocks();
});

test.each([
	["no partial output", undefined],
	["partial assistant output", "partial analysis before the failure"],
])("a provider-failed turn stays recoverable through its artifact (%s)", async (_label, partial) => {
	const content: AssistantMessage["content"] = partial ? [{ type: "text", text: partial }] : [];
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
		sessionResult(failingSession({ content, errorMessage: PROVIDER_FAILURE })),
	);
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-failure-"));
	const unregister = registerArtifactsDir(dir);
	const id = "provider-failure";
	try {
		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "do work",
			index: 0,
			id,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as never,
			eventBus: new EventBus(),
			artifactsDir: dir,
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.aborted).toBeFalsy();
		expect(result.error).toContain(PROVIDER_FAILURE);
		expect(result.output).toContain(PROVIDER_FAILURE);
		expect(result.outputPath).toBe(path.join(dir, `${id}.md`));
		const artifact = await Bun.file(result.outputPath!).text();
		expect(artifact).toContain(PROVIDER_FAILURE);
		if (partial) expect(artifact).toContain(partial);
		expect(result.outputMeta?.charCount).toBe(artifact.length);

		const url = Object.assign(new URL(`agent://${id}`), { rawHost: id }) satisfies InternalUrl;
		const resource = await new AgentProtocolHandler().resolve(url);
		expect(resource.sourcePath).toBe(result.outputPath);
		expect(resource.content).toContain(PROVIDER_FAILURE);
	} finally {
		unregister();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("an aborted turn keeps its cancellation reason instead of a failure notice", async () => {
	const aborted = { stopReason: "aborted" as const, errorMessage: "cancelled by operator" };
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult(failingSession(aborted)));
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-abort-"));
	try {
		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "do work",
			index: 0,
			id: "aborted-turn",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as never,
			eventBus: new EventBus(),
			artifactsDir: dir,
		});
		expect(result.aborted).toBe(true);
		expect(result.output).not.toContain("SYSTEM ERROR");
		expect(await Bun.file(result.outputPath!).text()).not.toContain("SYSTEM ERROR");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// Regression: a worker answered, a fleet message then woke it, and `orchestrate_kill` cancelled that turn before it
// produced anything. The empty turn overwrote `<id>.md`, so `agent://<id>` came back empty.
test("a killed turn that produced nothing keeps the previous answer at agent://<id>", async () => {
	const id = "killed-wake-turn";
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent): void => {
		for (const listener of [...listeners]) listener(event);
	};
	let wakeObserver:
		| ((records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined)
		| undefined;
	const yieldCall = assistantMessage({
		content: [{ type: "toolCall", id: "yield-1", name: "yield", arguments: { result: { data: "PONG-1" } } }],
		stopReason: "toolUse",
	});
	let lastAssistant = yieldCall;
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
			emit({ type: "message_end", message: yieldCall } as AgentSessionEvent);
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-1",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: "PONG-1" },
				},
				isError: false,
			} as AgentSessionEvent);
			emit({ type: "agent_end", messages: [yieldCall] } as AgentSessionEvent);
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => lastAssistant,
		abort: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose: async () => {},
		setWakeTurnObserver: (observer: typeof wakeObserver) => {
			wakeObserver = observer;
		},
		getAsyncJobOwnerId: () => undefined,
		subscribeRunState: () => () => {},
	} as unknown as AgentSession;
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult(session));
	const wakeTurn = Promise.withResolvers<SingleResult>();
	using _owner = {
		[Symbol.dispose]: registerWakeTurnOwner(id, () => ({
			progress: () => {},
			settle: result => wakeTurn.resolve(result),
			fail: error => wakeTurn.reject(error),
		})),
	};
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-killed-turn-"));
	const unregister = registerArtifactsDir(dir);
	try {
		const answered = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "Reply PONG-1",
			index: 0,
			id,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as never,
			eventBus: new EventBus(),
			artifactsDir: dir,
		});
		expect(answered.output).toBe("PONG-1");

		const finishWakeTurn = wakeObserver?.([
			{ role: "custom", customType: "irc:incoming", content: "ping", display: true, timestamp: 2 },
		] as CustomMessage[]);
		expect(finishWakeTurn).toBeDefined();
		const killed = assistantMessage({ stopReason: "aborted", errorMessage: "Request was aborted" });
		lastAssistant = killed;
		emit({ type: "message_end", message: killed } as AgentSessionEvent);
		emit({ type: "agent_end", messages: [killed] } as AgentSessionEvent);
		await finishWakeTurn?.();
		const killedTurn = await wakeTurn.promise;

		const url = Object.assign(new URL(`agent://${id}`), { rawHost: id }) satisfies InternalUrl;
		const resource = await new AgentProtocolHandler().resolve(url);
		expect(resource.content).toBe("PONG-1");
		expect(resource.sourcePath).toBe(answered.outputPath);
		// The killed turn reports itself truthfully: aborted, no output of its own, no counts for a write that
		// did not happen, and a path to the output that was kept.
		expect(killedTurn.aborted).toBe(true);
		expect(killedTurn.output).toBe("");
		expect(killedTurn.outputPath).toBe(answered.outputPath);
		expect(killedTurn.outputMeta).toBeUndefined();
	} finally {
		unregister();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("history renders a provider failure that produced no assistant content", () => {
	const usage = {
		input: 1,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const markdown = formatSessionHistoryMarkdown([
		{ role: "user", content: "do work", timestamp: 1 },
		{
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "fixture",
			model: "fixture",
			stopReason: "error",
			errorMessage: PROVIDER_FAILURE,
			usage,
			timestamp: 2,
		},
		{
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "fixture",
			model: "fixture",
			stopReason: "stop",
			usage,
			timestamp: 3,
		},
	]);
	expect(markdown).toContain("## user");
	expect(markdown).toContain(PROVIDER_FAILURE);
	expect(markdown.match(/## assistant/g)).toHaveLength(1);
});
