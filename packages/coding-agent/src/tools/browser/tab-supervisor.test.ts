import { expect, test } from "bun:test";
import type { ToolSession } from "../index";
import { ToolAbortError } from "../tool-errors";
import { getTabsMapForTest, type PendingRun, runInTab } from "./tab-supervisor";
import { collectReadyInfo, formatSelectorMatchHint, normalizeSelector, resolveWaitTimeout } from "./tab-worker";

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

test("browser selector normalization keeps text handlers and timeout options observable", () => {
	expect(normalizeSelector("p-text/Go")).toBe("text/Go");
	expect(normalizeSelector("text/Go")).toBe("text/Go");
	expect(resolveWaitTimeout(10_000, 1_500)).toBe(1_500);
	expect(resolveWaitTimeout(10_000, 0)).toBe(resolveWaitTimeout(10_000, Number.POSITIVE_INFINITY));
	expect(formatSelectorMatchHint(2)).toContain("matches 2 element(s)");
});

test("successful browser runs retain metadata without evaluating through an open modal", async () => {
	let titleCalls = 0;
	const page = {
		url: () => "http://127.0.0.1/dialog",
		viewport: () => ({ width: 800, height: 600 }),
		title: () => {
			titleCalls++;
			return new Promise<string>(() => {});
		},
	};
	const info = await collectReadyInfo(page, "owned-target", { dialogOpen: true });
	expect(titleCalls).toBe(0);
	expect(info).toEqual({
		url: "http://127.0.0.1/dialog",
		viewport: { width: 800, height: 600 },
		targetId: "owned-target",
		title: undefined,
	});
});

test("browser metadata refresh cannot outlive the originating run deadline", async () => {
	const controller = new AbortController();
	const page = {
		url: () => "http://127.0.0.1/ready",
		viewport: () => ({ width: 800, height: 600 }),
		title: () => new Promise<string>(() => {}),
	};
	const pending = collectReadyInfo(page, "owned-target", { signal: controller.signal });
	controller.abort(new Error("Run deadline"));
	const info = await pending;
	expect(info.url).toBe("http://127.0.0.1/ready");
	expect(info.title).toBeUndefined();
	expect((await collectReadyInfo({ ...page, title: async () => "Recovered" }, "owned-target")).title).toBe(
		"Recovered",
	);
});
