import { afterEach, expect, spyOn, test, vi } from "bun:test";
import type { ToolSession } from "../index";
import { ToolAbortError } from "../tool-errors";
import { CmuxSocketClient } from "./cmux/socket-client";
import { acquireBrowser } from "./registry";
import { acquireTab, getTabsMapForTest, type PendingRun, releaseTab, runInTab } from "./tab-supervisor";
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

afterEach(() => {
	vi.restoreAllMocks();
});

test("two releases racing the same tab tear it down once", async () => {
	let clientCloses = 0;
	const closedSurfaces: string[] = [];
	spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
	spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => {
		clientCloses++;
	});
	spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
		async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
			if (method === "browser.open_split") return { surface_id: "surface-join", url: "about:blank" };
			if (method === "surface.close") closedSurfaces.push(String(params.surface_id ?? ""));
			return {};
		},
	);
	const name = `release-join-${crypto.randomUUID()}`;
	const browser = await acquireBrowser({ kind: "cmux", socketPath: `/tmp/proto-test-${name}.sock` }, { cwd: "/tmp" });
	await acquireTab(name, browser, { timeoutMs: 1_000 });

	const [first, second] = await Promise.all([releaseTab(name, { kill: false }), releaseTab(name, { kill: false })]);
	expect(first).toBe(true);
	expect(second).toBe(true);
	expect(closedSurfaces).toEqual(["surface-join"]);
	expect(clientCloses).toBe(1);
	expect(getTabsMapForTest().has(name)).toBe(false);
});
