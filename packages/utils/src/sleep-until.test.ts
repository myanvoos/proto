import { afterEach, expect, test, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { sleepUntil } from "./async";

afterEach(() => vi.restoreAllMocks());

test("quota deadlines include suspended time instead of waiting the remaining uptime delay", async () => {
	let wallClock = 1000;
	vi.spyOn(Date, "now").mockImplementation(() => wallClock);
	const wait = vi.spyOn(scheduler, "wait").mockImplementation(async () => {
		wallClock += 3_600_000;
	});
	await sleepUntil(3_601_000);
	expect(wait).toHaveBeenCalledTimes(1);
	expect(wait.mock.calls[0]?.[0]).toBe(1000);
});

test("cancellation is not swallowed when a quota deadline has already passed", async () => {
	const controller = new AbortController();
	controller.abort(new Error("cancel quota wait"));
	await expect(sleepUntil(Date.now() - 1, controller.signal)).rejects.toThrow("cancel quota wait");
});
