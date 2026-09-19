import { expect, test } from "bun:test";
import { fetchGitHubApi } from "./github";

test("cancels an oversized GitHub API response before JSON parsing", async () => {
	const cancelled = { value: false };
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new Uint8Array(2048));
		},
		cancel() {
			cancelled.value = true;
		},
	});
	const fakeFetch = async () => new Response(stream, { status: 200, headers: { "content-length": "1" } });

	const result = await fetchGitHubApi("/repos/example/project", 1, undefined, {
		fetch: fakeFetch,
		maxBytes: 1024,
	});

	expect(result.ok).toBe(false);
	expect(cancelled.value).toBe(true);
});
