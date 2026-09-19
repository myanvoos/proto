import { expect, test } from "bun:test";
import { parseParallelJsonResponse } from "./parallel";

function oversizedResponse(cancelled: { value: boolean }): Response {
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new Uint8Array(2048));
		},
		cancel() {
			cancelled.value = true;
		},
	});
	return new Response(stream, { status: 200, headers: { "content-length": "1" } });
}

test("cancels a lying Parallel response stream at the JSON byte cap", async () => {
	const cancelled = { value: false };
	await expect(parseParallelJsonResponse(oversizedResponse(cancelled), "search", 1024)).rejects.toThrow(
		/response exceeded/i,
	);
	expect(cancelled.value).toBe(true);
});
