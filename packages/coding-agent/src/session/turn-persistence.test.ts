import { expect, test } from "bun:test";
import { planTurnPersistence } from "./turn-persistence";

test("turn persistence appends only missing messages after the persisted prefix", () => {
	expect(planTurnPersistence([undefined, "assistant", "tool-a", undefined, "tool-b"], new Set(["assistant"]))).toEqual(
		{ kind: "ok", toPersist: [2, 4] },
	);
});

test("turn persistence reports the earliest missing message before a later persisted message", () => {
	expect(
		planTurnPersistence([undefined, "missing-a", "missing-b", undefined, "persisted"], new Set(["persisted"])),
	).toEqual({ kind: "out-of-order", messageIndex: 1 });
});

test("turn persistence ignores unkeyed messages without inventing pending writes", () => {
	expect(planTurnPersistence([undefined, "persisted", undefined], new Set(["persisted"]))).toEqual({
		kind: "ok",
		toPersist: [],
	});
});

test("turn persistence retains each missing occurrence for collision-safe content checks", () => {
	expect(planTurnPersistence(["same-key", "same-key"], new Set())).toEqual({ kind: "ok", toPersist: [0, 1] });
});
