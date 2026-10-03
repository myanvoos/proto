import { describe, expect, it } from "bun:test";
import type { ReadyInfo, WorkerInbound, WorkerOutbound } from "./tab-protocol";
import { initializeTabWorkerForTest } from "./tab-supervisor";

class FakeStartupWorker {
	#errorHandlers = new Set<(error: Error) => void>();
	#messageHandlers = new Set<(msg: WorkerOutbound) => void>();
	readonly sent: WorkerInbound[] = [];
	readonly mode = "worker" as const;

	send(msg: WorkerInbound): void {
		this.sent.push(msg);
	}

	onMessage(handler: (msg: WorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => this.#errorHandlers.delete(handler);
	}

	async terminate(): Promise<void> {}

	emit(msg: WorkerOutbound): void {
		for (const handler of this.#messageHandlers) handler(msg);
	}

	emitError(error: Error): void {
		for (const handler of this.#errorHandlers) handler(error);
	}
}

const initPayload = {
	mode: "headless" as const,
	browserWSEndpoint: "ws://127.0.0.1/devtools/browser/test",
	safeDir: "/tmp/proto-puppeteer",
	timeoutMs: 1_000,
};

const info: ReadyInfo = {
	url: "about:blank",
	title: "Test",
	viewport: { width: 1280, height: 720 },
	targetId: "target-1",
};

describe("browser tab worker startup", () => {
	it("surfaces worker startup errors instead of waiting for the generic init timeout", async () => {
		const worker = new FakeStartupWorker();
		const pending = initializeTabWorkerForTest(worker, initPayload, 1_000);

		worker.emitError(new Error("Cannot find tab-worker-entry.ts"));

		await expect(pending).rejects.toThrow("Tab worker failed during startup: Cannot find tab-worker-entry.ts");
		expect(worker.sent).toEqual([{ type: "init", payload: initPayload }]);
	});

	it("resolves ready delivered in the same tick as setup", async () => {
		const worker = new FakeStartupWorker();
		const pending = initializeTabWorkerForTest(worker, initPayload, 1_000);

		worker.emit({ type: "setup" });
		worker.emit({ type: "ready", info });

		await expect(pending).resolves.toEqual(info);
	});

	it("surfaces a reported init failure that arrives right after setup", async () => {
		const worker = new FakeStartupWorker();
		const pending = initializeTabWorkerForTest(worker, initPayload, 3_000);

		worker.emit({ type: "setup" });
		worker.emit({
			type: "init-failed",
			error: { name: "Error", message: "connect failed", isToolError: false, isAbort: false },
		});

		await expect(pending).rejects.toThrow("connect failed");
	});

	it("bounds a retried attempt's setup wait by the caller's remaining budget", async () => {
		const worker = new FakeStartupWorker();
		const startedAt = performance.now();
		const pending = initializeTabWorkerForTest(worker, initPayload, 30_000, startedAt - 25_000);

		await expect(pending).rejects.toThrow("Timed out waiting for tab worker setup");
		expect(performance.now() - startedAt).toBeLessThan(5_000);
	});
});
