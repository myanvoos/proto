import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "../config/settings";
import { AgentProtocolHandler } from "../internal-urls/agent-protocol";
import { registerArtifactsDir } from "../internal-urls/registry-helpers";
import type { InternalUrl } from "../internal-urls/types";
import * as sdkModule from "../sdk";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { emptySubagentUsageTotals } from "../session/session-entries";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";
import { EventBus } from "../utils/event-bus";
import { runSubprocess } from "./executor";
import type { AgentDefinition } from "./types";

const PROVIDER_FAILURE = "usage_limit_reached: monthly quota exhausted";

function failingSession(failure: Partial<AssistantMessage>): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const message = {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "fixture",
		model: "fixture",
		stopReason: "error",
		timestamp: 1,
		usage: {
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...failure,
	} as AssistantMessage;
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
		setIrcWakeTurnObserver: () => {},
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
