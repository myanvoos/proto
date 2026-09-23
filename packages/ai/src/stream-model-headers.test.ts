import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { streamSimple } from "./stream";
import type { Context, FetchImpl, Model } from "./types";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

function modelWithHeaderHook(resolveHeaders: Model["resolveHeaders"]): Model {
	return {
		...buildModel({
			id: "live-header-test",
			name: "Live Header Test",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://completions.example.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 4_096,
			headers: { "X-Static": "static" },
		}),
		resolveHeaders,
	};
}

function capturingFetch(seen: Headers[]): FetchImpl {
	return Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			seen.push(new Headers(init?.headers));
			const body = [
				`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}`,
				"data: [DONE]",
				"",
			].join("\n\n");
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		},
		{ preconnect: fetch.preconnect },
	);
}

describe("request-time model header resolution", () => {
	it("materializes resolveHeaders for every request instead of the static header snapshot", async () => {
		let version = 0;
		const model = modelWithHeaderHook(async () => {
			version += 1;
			return { "X-Live": `v${version}` };
		});
		const seen: Headers[] = [];

		for (let i = 0; i < 2; i++) {
			const result = await streamSimple(model, context, {
				apiKey: "test-key",
				fetch: capturingFetch(seen),
			}).result();
			expect(result.stopReason).toBe("stop");
		}

		expect(seen.map(headers => headers.get("x-live"))).toEqual(["v1", "v2"]);
		// The hook owns the header set: the pre-resolution snapshot does not leak alongside it.
		expect(seen.every(headers => !headers.has("x-static"))).toBe(true);
	});

	it("aborts while headers are still resolving without sending the request", async () => {
		const release = Promise.withResolvers<Record<string, string>>();
		const started = Promise.withResolvers<void>();
		const model = modelWithHeaderHook(() => {
			started.resolve();
			return release.promise;
		});
		const seen: Headers[] = [];
		const controller = new AbortController();

		const pending = streamSimple(model, context, {
			apiKey: "test-key",
			fetch: capturingFetch(seen),
			signal: controller.signal,
		}).result();
		await started.promise;
		controller.abort();
		try {
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		} finally {
			release.resolve({ "X-Live": "too-late" });
		}
		await Bun.sleep(0);
		expect(seen).toHaveLength(0);
	});
});
