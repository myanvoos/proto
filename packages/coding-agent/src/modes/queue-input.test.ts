import { expect, test } from "bun:test";
import { MAX_QUEUE_DELAY_MS, parseQueueArgs, splitQueuedMessages } from "./queue-input";

test("a leading compound duration schedules the remaining text", () => {
	expect(parseQueueArgs("3h do A")).toEqual({ kind: "schedule", delayMs: 3 * 3_600_000, text: "do A" });
	expect(parseQueueArgs("1h30m ship it")).toEqual({ kind: "schedule", delayMs: 5_400_000, text: "ship it" });
	expect(parseQueueArgs("2d run the migration")).toEqual({
		kind: "schedule",
		delayMs: 172_800_000,
		text: "run the migration",
	});
});

test("message text that is not a bare duration token still queues verbatim", () => {
	// Regression guard: these all start duration-ish but must not silently become timers.
	expect(parseQueueArgs("3 hours of cleanup left")).toEqual({ kind: "queue", text: "3 hours of cleanup left" });
	expect(parseQueueArgs("3h")).toEqual({ kind: "queue", text: "3h" });
	expect(parseQueueArgs("12 ship it")).toEqual({ kind: "queue", text: "12 ship it" });
	expect(parseQueueArgs("3x retry the flake")).toEqual({ kind: "queue", text: "3x retry the flake" });
	expect(parseQueueArgs("ship it")).toEqual({ kind: "queue", text: "ship it" });
});

test("empty arguments queue empty text so the usage warning still fires", () => {
	expect(parseQueueArgs("   ")).toEqual({ kind: "queue", text: "" });
});

test("--cancel selects a position or every scheduled entry", () => {
	expect(parseQueueArgs("--cancel")).toEqual({ kind: "cancel", target: "all" });
	expect(parseQueueArgs("--cancel all")).toEqual({ kind: "cancel", target: "all" });
	expect(parseQueueArgs("--cancel 2")).toEqual({ kind: "cancel", target: 2 });
	expect(parseQueueArgs("--cancel 0")).toEqual({ kind: "error", message: "Usage: /queue --cancel <n|all>" });
	expect(parseQueueArgs("--cancel nope")).toEqual({ kind: "error", message: "Usage: /queue --cancel <n|all>" });
});

test("zero and out-of-range delays are rejected instead of scheduling a dead entry", () => {
	const zero = parseQueueArgs("0h do A");
	expect(zero.kind).toBe("error");
	const tooFar = parseQueueArgs("400d do A");
	expect(tooFar.kind).toBe("error");
	expect(parseQueueArgs(`${MAX_QUEUE_DELAY_MS / 86_400_000}d do A`).kind).toBe("schedule");
});

test("a scheduled enumerated list splits into one message per item", () => {
	const parsed = parseQueueArgs("30m 1. do A\n2. do B");
	expect(parsed).toEqual({ kind: "schedule", delayMs: 1_800_000, text: "1. do A\n2. do B" });
	expect(parsed.kind === "schedule" ? splitQueuedMessages(parsed.text) : []).toEqual(["do A", "do B"]);
});
