import { expect, test } from "bun:test";
import { raceJobSettlement } from "./auto-background";

test("already-settled job outcomes win over queued steering or cancellation", async () => {
	const abort = AbortSignal.abort();
	expect(await raceJobSettlement(Promise.resolve("completed"), undefined, abort, abort)).toBe("completed");
	await expect(raceJobSettlement(Promise.reject(new Error("job failed")), undefined, abort, abort)).rejects.toThrow(
		"job failed",
	);
});

test("a readiness wait without a background deadline ends immediately on steering", async () => {
	const completion = Promise.withResolvers<string>();
	const steering = new AbortController();
	const wait = raceJobSettlement(completion.promise, undefined, undefined, steering.signal);
	steering.abort();
	expect(await wait).toEqual({ kind: "steer" });
	completion.resolve("service ready");
});
