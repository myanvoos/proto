import { expect, test } from "bun:test";
import * as events from "node:events";
import { waitForRun } from "./run-scope";

test("waitForRun times out while a predicate invocation never settles", async () => {
	const controller = new AbortController();
	const pending = Promise.withResolvers<boolean>();

	await expect(waitForRun(() => pending.promise, controller.signal, { timeout: 25, interval: 10 })).rejects.toThrow(
		"wait(predicate) timed out after 25ms — predicate never returned truthy",
	);
	expect(events.getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

test("waitForRun aborts while a predicate invocation never settles", async () => {
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const pending = Promise.withResolvers<boolean>();
	const waiting = waitForRun(
		() => {
			entered.resolve();
			return pending.promise;
		},
		controller.signal,
		{ timeout: 10_000, interval: 10 },
	);

	await entered.promise;
	controller.abort(new Error("test abort"));

	await expect(waiting).rejects.toMatchObject({ name: "AbortError", message: "Aborted: test abort" });
});
