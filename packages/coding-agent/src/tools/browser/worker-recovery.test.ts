import { afterEach, expect, test } from "bun:test";
import type { Browser } from "puppeteer-core";
import type { ToolSession } from "../index";
import type { PuppeteerBrowserHandle } from "./registry";
import type { ReadyInfo, WorkerInbound, WorkerOutbound } from "./tab-protocol";
import { acquireTab, getTab, releaseTab, runInTab } from "./tab-supervisor";

const names: string[] = [];
const restoreWorkerConstructors: Array<() => void> = [];
/** Makes the first worker detach the debugger during any open navigation. */
let detachNavigations = false;
afterEach(async () => {
	detachNavigations = false;
	await Promise.all(names.splice(0).map(name => releaseTab(name).catch(() => undefined)));
	for (const restore of restoreWorkerConstructors.splice(0).reverse()) restore();
});

const info: ReadyInfo = {
	url: "https://example.com/kept",
	targetId: "kept-page",
	viewport: { width: 800, height: 600 },
};
class FakeWorker extends EventTarget {
	terminated = false;
	readonly codes: string[] = [];
	readonly initialized = Promise.withResolvers<void>();
	constructor(
		readonly holdReady = false,
		readonly first = true,
	) {
		super();
	}
	postMessage(message: WorkerInbound): void {
		if (message.type === "init") {
			queueMicrotask(() => {
				this.emit({ type: "setup" });
				this.initialized.resolve();
				if (!this.holdReady) this.ready();
			});
		} else if (message.type === "run") {
			this.codes.push(message.code);
			queueMicrotask(() => {
				if (this.first && detachNavigations && message.code.includes("tab.goto(")) {
					this.emit({
						type: "result",
						id: message.id,
						ok: false,
						error: {
							name: "ToolError",
							message: "Chrome detached the debugger",
							isToolError: true,
							isAbort: false,
							debuggerDetached: { when: "during-run", reason: "target_closed" },
						},
					});
				} else if (this.first && ["renderer", "before-detach", "during-detach"].includes(message.code)) {
					this.emit({
						type: "result",
						id: message.id,
						ok: false,
						error: {
							name: "ToolError",
							message: message.code === "renderer" ? "Renderer crashed" : "Chrome detached the debugger",
							isToolError: true,
							isAbort: false,
							rendererCrashed: message.code === "renderer" || undefined,
							debuggerDetached:
								message.code === "renderer"
									? undefined
									: {
											when: message.code === "before-detach" ? "before-run" : "during-run",
											reason: "target_closed",
										},
						},
					});
				} else if (message.code === "exit") this.exit();
				else
					this.emit({
						type: "result",
						id: message.id,
						ok: true,
						payload: { displays: [], returnValue: "same page", screenshots: [] },
					});
			});
		} else if (message.type === "close") queueMicrotask(() => this.emit({ type: "closed" }));
	}
	emit(message: WorkerOutbound): void {
		this.dispatchEvent(new MessageEvent("message", { data: message }));
	}
	ready(): void {
		this.emit({ type: "ready", info });
	}
	exit(): void {
		this.dispatchEvent(Object.assign(new Event("close"), { code: 7 }));
	}
	terminate(): void {
		this.terminated = true;
	}
}

function fixture(holdReplacement = false) {
	const workers: FakeWorker[] = [];
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
	if (!descriptor) throw new Error("Worker constructor is unavailable");
	restoreWorkerConstructors.push(() => Object.defineProperty(globalThis, "Worker", descriptor));
	Object.defineProperty(globalThis, "Worker", {
		...descriptor,
		value: class extends FakeWorker {
			constructor() {
				super(holdReplacement && workers.length === 1, workers.length === 0);
				workers.push(this);
			}
		},
	});
	const session = { cwd: "/tmp", settings: { get: () => undefined } } as unknown as ToolSession;
	const browser = {
		key: crypto.randomUUID(),
		kind: { kind: "headless", headless: true },
		refCount: 0,
		stealth: { browserSession: null, override: null },
		wsEndpoint: "ws://127.0.0.1/fake",
		browser: {
			connected: true,
			wsEndpoint: () => "ws://127.0.0.1/fake",
			process: () => null,
			close: async () => {},
			target: () => ({
				createCDPSession: async () => ({
					on: () => {},
					off: () => {},
					send: async () => ({ targetInfos: [] }),
					detach: async () => {},
				}),
			}),
		} as unknown as Browser,
	} as PuppeteerBrowserHandle;
	const name = `recovery-${crypto.randomUUID()}`;
	names.push(name);
	return { name, browser, workers, session };
}

test("unexpected worker exit fails the active call immediately and lets the next call use the same tab", async () => {
	const { name, browser, workers, session } = fixture();
	const opened = await acquireTab(name, browser, { timeoutMs: 1000 });
	await expect(runInTab(name, { code: "exit", timeoutMs: 1000, session })).rejects.toThrow(
		"worker exited unexpectedly",
	);
	const result = await runInTab(name, { code: "read", timeoutMs: 1000, session });
	expect(result.returnValue).toBe("same page");
	expect(getTab(name)).toBe(opened.tab);
	expect(workers).toHaveLength(2);
	expect(workers[0]?.terminated).toBe(true);
});

test("an idle worker exit is reported when an open reuses the recovered tab", async () => {
	const { name, browser, workers } = fixture();
	await acquireTab(name, browser, { timeoutMs: 1000 });
	workers[0]!.exit();
	const reused = await acquireTab(name, browser, { timeoutMs: 1000 });
	expect(reused.created).toBe(false);
	expect(reused.note).toContain("since the last call");
	expect(reused.note).toContain("without reloading");
});

test("a tab closed during reattachment stays closed when the replacement worker becomes ready", async () => {
	const { name, browser, workers } = fixture(true);
	await acquireTab(name, browser, { timeoutMs: 1000 });
	workers[0]!.exit();
	// Recovery reaches its startup handshake before this microtask fence settles.
	for (let turn = 0; turn < 10 && workers.length < 2; turn++) await Promise.resolve();
	await workers[1]!.initialized.promise;
	const tab = getTab(name)!;
	const recovery = tab.backend === "worker" ? tab.workerRecovery : undefined;
	const closing = releaseTab(name);
	workers[1]!.ready();
	await closing;
	await recovery;
	expect(getTab(name)).toBeUndefined();
	expect(workers[1]?.terminated).toBe(true);
});

test("an open whose navigation the debugger detaches keeps the reattached tab and reports it", async () => {
	detachNavigations = true;
	const { name, browser } = fixture();
	const opened = await acquireTab(name, browser, { url: "https://example.com/report", timeoutMs: 1000 });
	expect(opened.created).toBe(true);
	expect(opened.note).toContain("reattached");
	expect(getTab(name)).toBe(opened.tab);
	expect(opened.tab.state).toBe("alive");
});

test("a renderer crash is recovered in the failing call without replaying its code", async () => {
	const { name, browser, workers, session } = fixture();
	await acquireTab(name, browser, { timeoutMs: 1000 });
	await expect(runInTab(name, { code: "renderer", timeoutMs: 1000, session })).rejects.toThrow("page reloaded");
	expect(workers.flatMap(worker => worker.codes).filter(code => code === "renderer")).toHaveLength(1);
	expect((await runInTab(name, { code: "read", timeoutMs: 1000, session })).returnValue).toBe("same page");
});

test("a debugger detach before code evaluation can retry once, but a detach after evaluation never replays actions", async () => {
	for (const code of ["before-detach", "during-detach"]) {
		const { name, browser, workers, session } = fixture();
		await acquireTab(name, browser, { timeoutMs: 1000 });
		const result = runInTab(name, { code, timeoutMs: 1000, session });
		if (code === "before-detach") expect((await result).returnValue).toBe("same page");
		else await expect(result).rejects.toThrow("may already have landed");
		expect(workers.flatMap(worker => worker.codes).filter(sent => sent === code)).toHaveLength(
			code === "before-detach" ? 2 : 1,
		);
		await releaseTab(name);
	}
});
