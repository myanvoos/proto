import { expect, test } from "bun:test";
import type { WorkerHandle } from "../../subprocess/worker-client";
import { withNativeOutput } from "./native-output";
import type { WorkerInbound, WorkerOutbound } from "./worker-protocol";

test("native output fences wait for every byte consumer acknowledgement", async () => {
	let input!: ReadableStreamDefaultController<Uint8Array>;
	let control!: (message: WorkerOutbound) => void;
	const forwarded: WorkerInbound[] = [];
	const base: WorkerHandle<WorkerInbound, WorkerOutbound> = {
		send: message => {
			forwarded.push(message);
		},
		onMessage: handler => {
			control = handler;
			return () => {};
		},
		onError: () => () => {},
		terminate: async () => input.close(),
	};
	const worker = withNativeOutput(
		base,
		new ReadableStream({
			start(controller) {
				input = controller;
			},
		}),
	);
	const first = Promise.withResolvers<Extract<WorkerOutbound, { type: "bytes" }>>();
	const second = Promise.withResolvers<Extract<WorkerOutbound, { type: "bytes" }>>();
	const result = Promise.withResolvers<void>();
	let completed = false;
	worker.onMessage(message => {
		if (message.type === "bytes") (message.runId === "old-cell" ? first : second).resolve(message);
		if (message.type === "result") {
			completed = true;
			result.resolve();
		}
	});
	control({ type: "result", runId: "new-cell", ok: true, nativeSequence: 2 });
	input.enqueue(
		Buffer.from(
			`${JSON.stringify({ type: "native-stdio", runId: "old-cell", stream: "stderr", data: Buffer.from([0, 255]).toString("base64"), sequence: 1 })}\n`,
		),
	);
	input.enqueue(
		Buffer.from(
			`${JSON.stringify({ type: "native-stdio", runId: "new-cell", stream: "stdout", data: Buffer.from("native").toString("base64"), sequence: 2 })}\n`,
		),
	);
	const firstFrame = await first.promise;
	expect(Buffer.from(firstFrame.data, "base64")).toEqual(Buffer.from([0, 255]));
	expect(firstFrame.stream).toBe("stderr");
	expect(completed).toBe(false);
	worker.send({ type: "output-ack", id: firstFrame.id });
	const secondFrame = await second.promise;
	expect(completed).toBe(false);
	worker.send({ type: "output-ack", id: secondFrame.id });
	await result.promise;
	expect(completed).toBe(true);
	expect(forwarded).toEqual([]);
	await worker.terminate();
});

test("native output rejects malformed frames and fences rather than truncating silently", async () => {
	let input!: ReadableStreamDefaultController<Uint8Array>;
	const failed = Promise.withResolvers<Error>();
	const worker = withNativeOutput(
		{
			send: () => {},
			onMessage: () => () => {},
			onError: () => () => {},
			terminate: async () => {},
		},
		new ReadableStream({
			start(controller) {
				input = controller;
			},
		}),
	);
	worker.onError(failed.resolve);
	input.enqueue(Buffer.from('{"type":"native-stdio","runId":"cell","stream":"stdout","data":"!","sequence":1}\n'));
	expect((await failed.promise).message).toContain("Invalid native JS output frame");
	await worker.terminate();
});
