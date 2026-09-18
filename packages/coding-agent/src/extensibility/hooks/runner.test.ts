import { afterEach, expect, spyOn, test, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "../../config/model-registry";
import type { SessionManager } from "../../session/session-manager";
import type { LoadedHook } from "./loader";
import { HOOK_HANDLER_TIMEOUT_MS, HookRunner } from "./runner";
import { HookToolWrapper } from "./tool-wrapper";
import type { ToolCallEventResult } from "./types";

type TestHandler = (...args: unknown[]) => Promise<unknown>;

function makeHook(handlers: Record<string, TestHandler[]>): LoadedHook {
	return {
		path: "/test/hook.ts",
		resolvedPath: "/test/hook.ts",
		handlers: new Map(Object.entries(handlers)),
		messageRenderers: new Map(),
		commands: new Map(),
		setSendMessageHandler: () => {},
		setAppendEntryHandler: () => {},
	};
}

function makeRunner(hook: LoadedHook): HookRunner {
	return new HookRunner([hook], process.cwd(), {} as SessionManager, {} as ModelRegistry);
}

function makeTool(): AgentTool {
	return {
		name: "probe",
		label: "Probe",
		description: "test tool",
		parameters: {},
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
	} as unknown as AgentTool;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("tool_call hook errors use the runner error channel instead of escaping", async () => {
	const runner = makeRunner(
		makeHook({
			tool_call: [
				async () => {
					throw new Error("hook exploded");
				},
			],
		}),
	);
	const errors: string[] = [];
	runner.onError(error => errors.push(error.error));

	expect(
		await runner.emitToolCall({ type: "tool_call", toolName: "probe", toolCallId: "call-1", input: {} }),
	).toBeUndefined();
	expect(errors).toEqual(["hook exploded"]);
});

test("HookToolWrapper passes the tool abort signal into tool_call dispatch", async () => {
	const runner = makeRunner(makeHook({ tool_call: [async () => undefined] }));
	const emitToolCall = spyOn(runner, "emitToolCall");
	const wrapper = new HookToolWrapper(makeTool(), runner);
	const controller = new AbortController();

	await wrapper.execute("call-1", {}, controller.signal);

	expect(emitToolCall).toHaveBeenCalledWith(
		{ type: "tool_call", toolName: "probe", toolCallId: "call-1", input: {} },
		controller.signal,
	);
});

test("normal tool_call hooks can still transform tool input", async () => {
	const result: ToolCallEventResult = { input: { transformed: true } };
	const runner = makeRunner(makeHook({ tool_call: [async () => result] }));

	expect(await runner.emitToolCall({ type: "tool_call", toolName: "probe", toolCallId: "call-1", input: {} })).toEqual(
		result,
	);
});

test("a never-settling async hook times out, reports, and is quarantined", async () => {
	vi.useFakeTimers();
	const late = Promise.withResolvers<ToolCallEventResult>();
	let toolCalls = 0;
	let laterEventCalls = 0;
	const runner = makeRunner(
		makeHook({
			tool_call: [
				async () => {
					toolCalls++;
					return await late.promise;
				},
			],
			agent_start: [
				async () => {
					laterEventCalls++;
				},
			],
		}),
	);
	const errors: string[] = [];
	runner.onError(error => errors.push(error.error));

	const pending = runner.emitToolCall({ type: "tool_call", toolName: "probe", toolCallId: "call-1", input: {} });
	await Promise.resolve();
	vi.advanceTimersByTime(HOOK_HANDLER_TIMEOUT_MS + 1);

	expect(await pending).toBeUndefined();
	expect(errors).toEqual([`handler timed out after ${HOOK_HANDLER_TIMEOUT_MS}ms`]);
	late.resolve({ block: true, reason: "too late" });
	await Promise.resolve();
	await runner.emit({ type: "agent_start" });
	expect(toolCalls).toBe(1);
	expect(laterEventCalls).toBe(0);
});

test("aborting tool_call dispatch stops waiting for a hook that ignores cancellation", async () => {
	const late = Promise.withResolvers<ToolCallEventResult>();
	let calls = 0;
	const runner = makeRunner(
		makeHook({
			tool_call: [
				async () => {
					calls++;
					return await late.promise;
				},
			],
		}),
	);
	const errors: string[] = [];
	runner.onError(error => errors.push(error.error));
	const controller = new AbortController();

	const pending = runner.emitToolCall(
		{ type: "tool_call", toolName: "probe", toolCallId: "call-1", input: {} },
		controller.signal,
	);
	await Promise.resolve();
	controller.abort();

	expect(await pending).toBeUndefined();
	expect(calls).toBe(1);
	expect(errors).toEqual([]);
	late.resolve({ block: true, reason: "too late" });
});
