import { describe, expect, test } from "bun:test";
import type { RefCountedWorkerHandle } from "../subprocess/worker-client";
import { TinyTitleClient } from "./title-client";
import type { TinyTitleWorkerInbound, TinyTitleWorkerOutbound } from "./title-protocol";

interface FakeWorker {
	handle: RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound>;
	sent: TinyTitleWorkerInbound[];
	terminated: boolean;
}

function createFakeWorker(): FakeWorker {
	const worker: FakeWorker = {
		sent: [],
		terminated: false,
		handle: {
			send: message => worker.sent.push(message),
			onMessage: () => () => {},
			onError: () => () => {},
			terminate: async () => {
				worker.terminated = true;
			},
			ref: () => {},
			unref: () => {},
		},
	};
	return worker;
}

describe("TinyTitleClient idle worker kill", () => {
	test("terminates worker after idle timeout and respawns on next request", async () => {
		const spawned: FakeWorker[] = [];
		const client = new TinyTitleClient(() => {
			const worker = createFakeWorker();
			spawned.push(worker);
			return worker.handle;
		}, 20);

		client.prewarm("lfm2-700m");
		expect(spawned.length).toBe(1);
		expect(spawned[0].sent.some(message => message.type === "ping")).toBe(true);

		await Bun.sleep(120);
		expect(spawned[0].terminated).toBe(true);

		client.prewarm("lfm2-700m");
		expect(spawned.length).toBe(2);

		await client.terminate();
	});

	test("idleKillMs=0 keeps the worker alive", async () => {
		const spawned: FakeWorker[] = [];
		const client = new TinyTitleClient(() => {
			const worker = createFakeWorker();
			spawned.push(worker);
			return worker.handle;
		}, 0);

		client.prewarm("lfm2-700m");
		await Bun.sleep(60);
		expect(spawned[0].terminated).toBe(false);

		await client.terminate();
	});

	test("pending request blocks idle kill until it resolves", async () => {
		const spawned: FakeWorker[] = [];
		let reply: ((message: TinyTitleWorkerOutbound) => void) | undefined;
		const client = new TinyTitleClient(() => {
			const worker = createFakeWorker();
			worker.handle.onMessage = handler => {
				reply = handler;
				return () => {
					reply = undefined;
				};
			};
			spawned.push(worker);
			return worker.handle;
		}, 20);

		const pending = client.generate("lfm2-700m", "summarize this session");
		expect(spawned.length).toBe(1);
		const id = spawned[0].sent.find(message => message.type === "generate")?.id;
		expect(id).toBeDefined();

		await Bun.sleep(60);
		expect(spawned[0].terminated).toBe(false);

		reply?.({ type: "title", id: id!, title: "Hello" } as TinyTitleWorkerOutbound);
		await expect(pending).resolves.toBe("Hello");

		await Bun.sleep(60);
		expect(spawned[0].terminated).toBe(true);

		await client.terminate();
	});
});

test("a worker exit closes an aborted model load without adding an error for an idle ready model", async () => {
	let reply: ((message: TinyTitleWorkerOutbound) => void) | undefined;
	let fail: ((error: Error) => void) | undefined;
	const client = new TinyTitleClient(() => {
		const worker = createFakeWorker();
		worker.handle.onMessage = handler => {
			reply = handler;
			return () => {
				reply = undefined;
			};
		};
		worker.handle.onError = handler => {
			fail = handler;
			return () => {
				fail = undefined;
			};
		};
		return worker.handle;
	}, 0);
	const progress: string[] = [];
	client.onProgress(event => progress.push(event.status));
	const abort = new AbortController();
	const pending = client.generate("lfm2-700m", "title", abort.signal);
	reply?.({ type: "progress", id: "1", event: { modelKey: "lfm2-700m", status: "initiate" } });
	abort.abort();
	expect(await pending).toBeNull();
	fail?.(new Error("tiny model subprocess exited with code 1"));
	expect(progress).toEqual(["initiate", "error"]);

	client.prewarm("lfm2-700m");
	reply?.({ type: "progress", id: "2", event: { modelKey: "lfm2-700m", status: "ready" } });
	fail?.(new Error("tiny model subprocess exited with code 1"));
	expect(progress).toEqual(["initiate", "error", "ready"]);
	await client.terminate();
});
