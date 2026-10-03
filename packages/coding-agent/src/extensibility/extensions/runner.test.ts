import { afterEach, expect, test, vi } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { SessionManager } from "../../session/session-manager";
import { SessionProviderBoundary } from "../../session/session-provider-boundary";
import { ExtensionRunner } from "./runner";
import type { Extension, ExtensionRuntime, InputEventResult, ToolCallEventResult, ToolResultEvent } from "./types";
import { ExtensionToolWrapper } from "./wrapper";

type TestHandler = (...args: unknown[]) => Promise<unknown>;

function makeExtension(handlers: Record<string, TestHandler[]>): Extension {
	return {
		path: "/test/extension.ts",
		resolvedPath: "/test/extension.ts",
		handlers: new Map(Object.entries(handlers)),
		tools: new Map(),
		toolRegistrationListeners: new Set(),
		assistantThinkingRenderers: [],
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

function makeRunner(extension: Extension, toolCallTimeoutMs = 25): ExtensionRunner {
	const runtime = { flagValues: new Map() } as unknown as ExtensionRuntime;
	const sessionManager = {
		getCwd: () => process.cwd(),
		getSessionId: () => "extension-runner-test",
	} as unknown as SessionManager;
	const settings = {
		get: (key: string) => (key === "extensionHandlers.toolCallTimeoutMs" ? toolCallTimeoutMs : undefined),
	} as unknown as Settings;
	return new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, {} as ModelRegistry, settings);
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("an async handler timeout quarantines its extension and discards its late result", async () => {
	vi.useFakeTimers();
	const late = Promise.withResolvers<ToolCallEventResult>();
	let toolCallCount = 0;
	let inputCount = 0;
	const extension = makeExtension({
		tool_call: [
			async () => {
				toolCallCount++;
				return await late.promise;
			},
		],
		input: [
			async () => {
				inputCount++;
				return { text: "late mutation" } satisfies InputEventResult;
			},
		],
	});
	const runner = makeRunner(extension);
	const errors: string[] = [];
	runner.onError(error => errors.push(error.error));

	const pending = runner.emitToolCall({
		type: "tool_call",
		toolName: "read",
		toolCallId: "call-1",
		input: {},
	});
	await Promise.resolve();
	vi.advanceTimersByTime(26);
	const timedOut = await pending;

	expect(timedOut).toEqual({
		block: true,
		reason: "Extension /test/extension.ts timed out after 25ms",
	});
	expect(errors).toEqual(["handler timed out after 25ms"]);
	late.resolve({ block: false, input: { changed: true } });
	await Promise.resolve();

	expect(await runner.emitInput("original", undefined, "interactive")).toEqual({});
	expect(toolCallCount).toBe(1);
	expect(inputCount).toBe(0);
});

test("normal extension dispatch still applies a handler result", async () => {
	const extension = makeExtension({
		input: [
			async event => {
				const input = event as { text: string };
				return { text: input.text.toUpperCase() } satisfies InputEventResult;
			},
		],
	});
	const runner = makeRunner(extension);

	expect(await runner.emitInput("hello", undefined, "interactive")).toEqual({ text: "HELLO" });
});

test("context usage and compaction work when the host provides no command actions", async () => {
	const runner = makeRunner(makeExtension({}));
	const usage = { tokens: 1200, contextWindow: 8000, percent: 15 };
	const compact = vi.fn(async () => {});

	runner.initialize(
		{
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: () => {},
			setLabel: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: async () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => undefined,
			setThinkingLevel: () => {},
			getSessionName: () => undefined,
			setSessionName: async () => {},
		},
		{
			getModel: () => undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => usage,
			compact,
			getSystemPrompt: () => [],
		},
	);

	expect(runner.createContext().getContextUsage()).toEqual(usage);
	await runner.createContext().compact("preserve current task");
	expect(compact).toHaveBeenCalledWith("preserve current task", true);
});

test("a tool-reported error stays an error through extension result rewrites", async () => {
	const extension = makeExtension({
		tool_result: [
			async event => {
				const result = event as ToolResultEvent;
				return { content: [{ type: "text", text: result.isError ? "observed failure" : "observed success" }] };
			},
		],
	});
	const tool: AgentTool = {
		name: "flagged",
		label: "Flagged",
		description: "returns a non-throwing failure",
		parameters: {} as never,
		execute: async () => ({ content: [{ type: "text", text: "reported failure" }], isError: true }),
	};
	const wrapper = new ExtensionToolWrapper(tool, makeRunner(extension));

	const result = await wrapper.execute("call-reported-failure", {} as never);

	expect(result.content).toEqual([{ type: "text", text: "observed failure" }]);
	expect(result.isError).toBe(true);
});

test("cancelling a side request releases a stalled provider hook without quarantining its extension", async () => {
	for (const phase of ["before_provider_request", "after_provider_response"] as const) {
		const entered = Promise.withResolvers<void>();
		const held = Promise.withResolvers<undefined>();
		let calls = 0;
		const runner = makeRunner(
			makeExtension({
				[phase]: [
					async () => {
						calls++;
						if (calls === 1) {
							entered.resolve();
							return held.promise;
						}
						return undefined;
					},
				],
			}),
		);
		const boundary = new SessionProviderBoundary({
			agent: new Agent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: () => undefined,
			transformContext: messages => messages,
			convertToLlm: () => [],
			onPayload: (payload, model, signal) => runner.emitBeforeProviderRequest(payload, model, signal),
			onResponse: (response, model, signal) => runner.emitAfterProviderResponse(response, model, signal),
			onSseEvent: undefined,
			obfuscator: undefined,
		});
		const controller = new AbortController();
		const options = boundary.prepareSimpleStreamOptions({ signal: controller.signal });
		const invoke = () =>
			phase === "before_provider_request"
				? options.onPayload?.({ request: 1 })
				: options.onResponse?.({ status: 200, headers: {} });
		const pending = invoke();
		await entered.promise;
		controller.abort();
		try {
			await pending;
			expect(calls).toBe(1);
			if (phase === "before_provider_request") await runner.emitBeforeProviderRequest({ request: 2 });
			else await runner.emitAfterProviderResponse({ status: 200, headers: {} });
			expect(calls).toBe(2);
		} finally {
			held.resolve(undefined);
		}
	}
});
