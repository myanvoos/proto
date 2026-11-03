import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { stream, streamSimple } from "./stream";
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

it("rejecting model identities omit sampling before direct and simple Google wire encoding", async () => {
	for (const dispatch of [stream, streamSimple]) {
		for (const [id, accepts] of [
			["gpt-5.5", false],
			["gemini-2.5-flash", true],
		] as const) {
			const model = buildModel({
				id,
				name: id,
				api: "google-generative-ai",
				provider: "custom-google",
				baseUrl: "https://google.example.test",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 10000,
				maxTokens: 1000,
			});
			let payload: { generationConfig?: { temperature?: number; topP?: number } } | undefined;
			const fetch: FetchImpl = async (_input, init) => {
				payload = JSON.parse(init?.body as string);
				return new Response("{}", { status: 400 });
			};
			await dispatch(model, context, { apiKey: "test", fetch, temperature: 0.5, topP: 0.9 }).result();
			expect(payload?.generationConfig?.temperature).toBe(accepts ? 0.5 : undefined);
			expect(payload?.generationConfig?.topP).toBe(accepts ? 0.9 : undefined);
		}
	}
});
