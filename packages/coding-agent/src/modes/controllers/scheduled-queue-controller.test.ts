import { afterEach, expect, test, vi } from "bun:test";
import type { AgentSession } from "../../session/agent-session";
import type { InteractiveModeContext, SubmittedUserInput } from "../types";
import { ScheduledQueueController } from "./scheduled-queue-controller";

const HOUR = 3_600_000;

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Resolves pending microtasks without touching the clock; delivery awaits the session. */
async function settle(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

function harness(options: { streaming?: boolean; compacting?: boolean } = {}) {
	const started: string[] = [];
	const followUps: string[] = [];
	const errors: string[] = [];
	const session = {
		get isStreaming() {
			return options.streaming === true;
		},
		get isCompacting() {
			return options.compacting === true;
		},
		queuedMessageCount: 0,
		followUp: async (text: string) => {
			followUps.push(text);
		},
		prompt: async (text: string) => {
			followUps.push(text);
		},
	} as unknown as AgentSession;

	const ctx = {
		session,
		compactionQueuedMessages: [] as { text: string; mode: string }[],
		onInputCallback: (input: SubmittedUserInput) => {
			ctx.onInputCallback = undefined;
			started.push(input.text);
		},
		startPendingSubmission: (input: { text: string }) => input as SubmittedUserInput,
		withLocalSubmission: <T>(_text: string, fn: () => Promise<T>) => fn(),
		updatePendingMessagesDisplay: () => {},
		showStatus: () => {},
		showError: (message: string) => errors.push(message),
		ui: { requestRender: () => {} },
	} as unknown as InteractiveModeContext & { onInputCallback?: (input: SubmittedUserInput) => void };

	return { ctx, started, followUps, errors };
}

test("successive delays fire on independent wall-clock deadlines, not chained ones", async () => {
	vi.useFakeTimers();
	const { ctx, started, followUps } = harness();
	const controller = new ScheduledQueueController(ctx);

	controller.schedule(3 * HOUR, ["do A"]);
	controller.schedule(18 * HOUR, ["do B"]);

	vi.advanceTimersByTime(3 * HOUR);
	await settle();
	expect([...started, ...followUps]).toEqual(["do A"]);
	expect(controller.list()).toHaveLength(1);

	// 15 more hours reaches the 18h deadline; a chained schedule would still be waiting at 21h.
	vi.advanceTimersByTime(15 * HOUR);
	await settle();
	expect([...started, ...followUps]).toEqual(["do A", "do B"]);
	expect(controller.list()).toHaveLength(0);
	controller.dispose();
});

test("a delivery due while the agent streams lands on the follow-up queue", async () => {
	vi.useFakeTimers();
	const { ctx, started, followUps } = harness({ streaming: true });
	const controller = new ScheduledQueueController(ctx);

	controller.schedule(30 * 60_000, ["do A"]);
	vi.advanceTimersByTime(30 * 60_000);
	await settle();

	expect(started).toEqual([]);
	expect(followUps).toEqual(["do A"]);
	controller.dispose();
});

test("a delivery due during compaction is held for the post-compaction flush", async () => {
	vi.useFakeTimers();
	const { ctx, started, followUps } = harness({ compacting: true });
	const controller = new ScheduledQueueController(ctx);

	controller.schedule(HOUR, ["do A"]);
	vi.advanceTimersByTime(HOUR);
	await settle();

	expect([...started, ...followUps]).toEqual([]);
	expect(ctx.compactionQueuedMessages).toEqual([{ text: "do A", mode: "followUp", images: undefined }]);
	controller.dispose();
});

test("cancelling by listed position drops only that entry", async () => {
	vi.useFakeTimers();
	const { ctx, started } = harness();
	const controller = new ScheduledQueueController(ctx);

	controller.schedule(HOUR, ["do A"]);
	controller.schedule(2 * HOUR, ["do B"]);
	expect(controller.cancel(1)?.messages).toEqual(["do A"]);
	expect(controller.cancel(9)).toBeUndefined();

	vi.advanceTimersByTime(2 * HOUR);
	await settle();
	expect(started).toEqual(["do B"]);
	expect(controller.list()).toHaveLength(0);
	controller.dispose();
});

test("dispose stops a pending deadline from ever firing", async () => {
	vi.useFakeTimers();
	const { ctx, started, followUps } = harness();
	const controller = new ScheduledQueueController(ctx);

	controller.schedule(HOUR, ["do A"]);
	controller.dispose();

	vi.advanceTimersByTime(4 * HOUR);
	await settle();
	expect([...started, ...followUps]).toEqual([]);
});

test("a failed delivery surfaces the error instead of silently dropping the message", async () => {
	vi.useFakeTimers();
	const { ctx, errors } = harness({ streaming: true });
	vi.spyOn(ctx.session, "followUp").mockRejectedValue(new Error("session closed"));
	const controller = new ScheduledQueueController(ctx);

	controller.schedule(HOUR, ["do A"]);
	vi.advanceTimersByTime(HOUR);
	await settle();

	expect(errors).toEqual(["Scheduled message failed to send: session closed"]);
	controller.dispose();
});
