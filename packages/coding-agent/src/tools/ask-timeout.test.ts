import { afterEach, expect, test, vi } from "bun:test";
import { type AgentToolContext, TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAskDialogResult, ExtensionUIContext } from "../extensibility/extensions";
import { AskDialogComponent } from "../modes/components/ask-dialog";
import { initThemeSync } from "../modes/theme/theme";
import type { ToolSession } from ".";
import { AskTool, type AskToolInput, recoverAskInput } from "./ask";

initThemeSync();
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
const questions: AskToolInput["questions"] = [
	{ id: "q1", question: "Publish?", options: [{ label: "Yes" }, { label: "No" }], recommended: 0 },
	{ id: "q2", question: "Spend?", options: [{ label: "Yes" }, { label: "No" }] },
];
function fixture(ui: Partial<ExtensionUIContext>, configured = 0) {
	const abort = vi.fn();
	const context = { hasUI: true, ui, abort } as unknown as AgentToolContext;
	const tool = new AskTool({ hasUI: false, settings: { get: () => configured } } as unknown as ToolSession);
	return {
		abort,
		run: (params: AskToolInput, signal?: AbortSignal) => tool.execute("test", params, signal, undefined, context),
	};
}

test("fallback expiry never fabricates the recommended approval and does not abort the turn", async () => {
	vi.useFakeTimers();
	const pending = Promise.withResolvers<string | undefined>();
	const { run, abort } = fixture({ select: () => pending.promise }, 10);
	const result = run({ questions: [questions[0]!], timeout: 1 });
	vi.advanceTimersByTime(1000);
	expect((await result).details).toMatchObject({ timedOut: true, selectedOptions: [] });
	expect(abort).not.toHaveBeenCalled();
	pending.resolve("Yes");
});

test("a rich host timeout cannot disguise an auto-selected recommendation as user approval", async () => {
	const { run, abort } = fixture({
		askDialog: async () => ({
			kind: "timeout",
			results: [
				{
					id: "q1",
					question: "Publish?",
					options: ["Yes", "No"],
					multi: false,
					selectedOptions: ["Yes"],
					timedOut: true,
				},
			],
		}),
	});
	const result = await run({ questions: [questions[0]!] });
	expect(result.details).toMatchObject({ timedOut: true, selectedOptions: [] });
	expect(result.content).toEqual([{ type: "text", text: "Ask timed out: no response received." }]);
	expect(abort).not.toHaveBeenCalled();
});

test("one fallback form deadline preserves confirmed earlier answers and covers the custom editor", async () => {
	vi.useFakeTimers();
	const secondPresented = Promise.withResolvers<void>();
	const editorPresented = Promise.withResolvers<void>();
	const edit = Promise.withResolvers<string | undefined>();
	let step = 0;
	const { run } = fixture({
		select: async () => {
			if (step++ === 0) return "No";
			secondPresented.resolve();
			return "Other (type your own)";
		},
		editor: () => {
			editorPresented.resolve();
			return edit.promise;
		},
	});
	const result = run({ questions, timeout: 1 });
	await secondPresented.promise;
	vi.advanceTimersByTime(600);
	await editorPresented.promise;
	vi.advanceTimersByTime(400);
	expect((await result).details).toMatchObject({
		timedOut: true,
		results: [
			{ id: "q1", selectedOptions: ["No"] },
			{ id: "q2", selectedOptions: [], timedOut: true },
		],
	});
	edit.resolve("Yes");
});

test("explicit zero disables the configured deadline and omitted timeout retains it", async () => {
	vi.useFakeTimers();
	let pending = Promise.withResolvers<string | undefined>();
	const { run } = fixture({ select: () => pending.promise }, 1);
	const disabled = run({ questions: [questions[0]!], timeout: 0 });
	vi.advanceTimersByTime(5000);
	pending.resolve("No");
	expect((await disabled).details?.selectedOptions).toEqual(["No"]);
	pending = Promise.withResolvers<string | undefined>();
	const configured = run({ questions: [questions[0]!] });
	vi.advanceTimersByTime(1000);
	expect((await configured).details?.timedOut).toBe(true);
});

test("manual cancellation aborts the turn but an external interrupt does not", async () => {
	const manual = fixture({ select: async () => undefined });
	await expect(manual.run({ questions: [questions[0]!] })).rejects.toThrow("cancelled by the user");
	expect(manual.abort).toHaveBeenCalledTimes(1);
	const waiting = Promise.withResolvers<string | undefined>();
	const external = fixture({ select: () => waiting.promise });
	const controller = new AbortController();
	const result = external.run({ questions: [questions[0]!] }, controller.signal);
	controller.abort(TOOL_INTERRUPT_ABORT_REASON);
	await expect(result).rejects.toThrow("interrupted by message");
	expect(external.abort).not.toHaveBeenCalled();
	waiting.resolve("Yes");
});

test("rich expiry closes an active editor, ignores late input, and retains only confirmed questions", async () => {
	vi.useFakeTimers();
	const editor = Promise.withResolvers<string | undefined>();
	const submitted = Promise.withResolvers<ExtensionAskDialogResult>();
	const dialog = new AskDialogComponent(
		questions,
		{ onSubmit: submitted.resolve, onCancel: vi.fn(), onPrompt: () => editor.promise },
		{ timeout: 1000 },
	);
	dialog.handleInput("\x1b[B");
	dialog.handleInput("\r");
	vi.advanceTimersByTime(600);
	dialog.handleInput("\x1b[B");
	dialog.handleInput("\x1b[B");
	dialog.handleInput("\r");
	vi.advanceTimersByTime(400);
	const result = await submitted.promise;
	expect(result).toMatchObject({
		kind: "timeout",
		results: [
			{ id: "q1", selectedOptions: ["No"] },
			{ id: "q2", selectedOptions: [], timedOut: true },
		],
	});
	editor.resolve("Yes");
	await Promise.resolve();
	dialog.handleInput("\r");
	expect(result).toMatchObject({ results: [{ selectedOptions: ["No"] }, { selectedOptions: [] }] });
});

test("tool and real rich dialog agree on confirmed partial answers at the same deadline", async () => {
	vi.useFakeTimers();
	let dialog: AskDialogComponent | undefined;
	const { run } = fixture({
		askDialog: (items, options) => {
			const pending = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
			dialog = new AskDialogComponent(
				items,
				{ onSubmit: pending.resolve, onCancel: () => pending.resolve(undefined), onPrompt: vi.fn() },
				{ timeout: options?.timeout },
			);
			return pending.promise;
		},
	});
	const result = run({ questions, timeout: 1 });
	dialog?.handleInput("\x1b[B");
	dialog?.handleInput("\r");
	vi.advanceTimersByTime(1000);
	expect((await result).details).toMatchObject({
		timedOut: true,
		results: [{ selectedOptions: ["No"] }, { selectedOptions: [], timedOut: true }],
	});
});

test("rich multi-select toggles are not confirmation and navigation never refreshes the deadline", async () => {
	vi.useFakeTimers();
	const submitted = vi.fn();
	const dialog = new AskDialogComponent(
		[{ ...questions[0]!, multi: true }],
		{ onSubmit: submitted, onCancel: vi.fn(), onPrompt: vi.fn() },
		{ timeout: 1000 },
	);
	dialog.handleInput(" ");
	vi.advanceTimersByTime(600);
	dialog.handleInput("\x1b[B");
	vi.advanceTimersByTime(400);
	expect(submitted.mock.calls[0]?.[0]).toMatchObject({
		kind: "timeout",
		results: [{ selectedOptions: [], timedOut: true }],
	});
});

test("a completed dialog timer and late answer cannot cancel the next dialog", async () => {
	vi.useFakeTimers();
	const old = Promise.withResolvers<string | undefined>();
	let current = old;
	const { run } = fixture({ select: () => current.promise });
	const first = run({ questions: [questions[0]!], timeout: 1 });
	vi.advanceTimersByTime(1000);
	await first;
	current = Promise.withResolvers<string | undefined>();
	const second = run({ questions: [questions[0]!], timeout: 2 });
	old.resolve("Yes");
	vi.advanceTimersByTime(1000);
	current.resolve("No");
	expect((await second).details).toMatchObject({ selectedOptions: ["No"] });
});

test("persisted asks with per-call deadlines reopen while malformed legacy args fail closed", async () => {
	const recovered = recoverAskInput({ questions: [questions[0]!], timeout: 0 });
	if (!recovered) throw new Error("Persisted ask was rejected");
	vi.useFakeTimers();
	const answer = Promise.withResolvers<string | undefined>();
	const { run } = fixture({ select: () => answer.promise }, 1);
	const pending = run(recovered);
	vi.advanceTimersByTime(2000);
	answer.resolve("No");
	expect((await pending).details?.selectedOptions).toEqual(["No"]);
	expect(recoverAskInput({ questions: [questions[0]!], timeout: -1 })).toBeUndefined();
	expect(recoverAskInput({ questions: [{ question: "Legacy?", options: ["Yes"] }] })).toBeUndefined();
});

test("fallback multi-select toggles expire without turning a draft into a confirmed answer", async () => {
	vi.useFakeTimers();
	const toggled = Promise.withResolvers<void>();
	const waiting = Promise.withResolvers<string | undefined>();
	let call = 0;
	const { run } = fixture({
		select: () => {
			if (call++ === 0) return Promise.resolve("Yes");
			toggled.resolve();
			return waiting.promise;
		},
	});
	const result = run({ questions: [{ ...questions[0]!, multi: true }], timeout: 1 });
	await toggled.promise;
	vi.advanceTimersByTime(1000);
	expect((await result).details).toMatchObject({ timedOut: true, selectedOptions: [] });
	waiting.resolve("Yes");
});

test("external cancellation stays distinct from no-response timeout without aborting the turn", async () => {
	const waiting = Promise.withResolvers<string | undefined>();
	const { run, abort } = fixture({ select: () => waiting.promise });
	const controller = new AbortController();
	const result = run({ questions: [questions[0]!] }, controller.signal);
	controller.abort();
	await expect(result).rejects.toThrow("Ask input was cancelled");
	expect(abort).not.toHaveBeenCalled();
	waiting.resolve("Yes");
});
