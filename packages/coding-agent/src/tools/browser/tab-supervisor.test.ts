import { expect, test } from "bun:test";
import type { ToolSession } from "../index";
import { ToolAbortError } from "../tool-errors";
import { getTabsMapForTest, type PendingRun, runInTab } from "./tab-supervisor";

test("aborting after tab worker termination does not escape as an uncaught exception", async () => {
	const name = `terminated-worker-${crypto.randomUUID()}`;
	const tabs = getTabsMapForTest() as unknown as Map<string, unknown>;
	const pending = new Map<string, PendingRun>();
	const controller = new AbortController();
	const abortError = new ToolAbortError("Browser run aborted");
	let terminated = false;
	const worker = {
		mode: "worker" as const,
		send(message: { type: string }): void {
			if (message.type === "run") {
				queueMicrotask(() => {
					terminated = true;
					controller.abort(abortError);
					for (const run of pending.values()) run.reject(abortError);
				});
				return;
			}
			if (message.type === "abort" && terminated) {
				throw new DOMException("Worker has been terminated", "InvalidStateError");
			}
		},
		onMessage: () => () => {},
		onError: () => () => {},
		async terminate() {},
	};
	tabs.set(name, {
		name,
		backend: "worker",
		state: "alive",
		pending,
		worker,
	});

	try {
		await expect(
			runInTab(name, {
				code: "",
				timeoutMs: 100,
				signal: controller.signal,
				session: {
					cwd: process.cwd(),
					settings: { get: () => undefined },
				} as unknown as ToolSession,
			}),
		).rejects.toBe(abortError);
		await Promise.resolve();
	} finally {
		tabs.delete(name);
	}
});
