import { describe, expect, it, vi } from "bun:test";
import { EventStream } from "./event-stream";
import { iterateWithIdleTimeout } from "./idle-iterator";

async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe("iterateWithIdleTimeout local work", () => {
	it("gives the provider a full idle budget after local work that ends just before the deadline", async () => {
		const idleMs = 1000;
		const stream = new EventStream<string>(
			item => item === "done",
			item => item,
		);
		const toolDone = Promise.withResolvers<void>();
		const replyReady = Promise.withResolvers<void>();
		vi.useFakeTimers();
		try {
			void (async () => {
				stream.push("progress");
				await stream.trackLocalWork(toolDone.promise);
				await replyReady.promise;
				stream.push("done");
			})();
			const seen: string[] = [];
			const consumed = (async () => {
				for await (const item of iterateWithIdleTimeout(stream, {
					idleTimeoutMs: idleMs,
					errorMessage: "Provider stream stalled",
					localWork: stream,
				})) {
					seen.push(item);
				}
			})();
			await settle();

			// The tool result goes upstream 100 ms before the pre-tool deadline...
			vi.advanceTimersByTime(idleMs - 100);
			toolDone.resolve();
			await settle();
			// ...and the provider is still answering when that deadline passes.
			vi.advanceTimersByTime(200);
			await settle();
			replyReady.resolve();
			await settle();
			vi.advanceTimersByTime(idleMs);

			await consumed;
			expect(seen).toEqual(["progress", "done"]);
		} finally {
			vi.useRealTimers();
		}
	});
});
