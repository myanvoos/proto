import { afterEach, expect, test, vi } from "bun:test";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { SessionManager } from "../../session/session-manager";
import { ExtensionRunner } from "./runner";
import type { Extension, ExtensionRuntime, InputEventResult, ToolCallEventResult } from "./types";

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
