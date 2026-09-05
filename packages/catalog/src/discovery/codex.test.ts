import { describe, expect, test } from "bun:test";
import { fetchCodexModels, PI_CODEX_CATALOG_URL } from "./codex";

function response(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		...init,
	});
}

describe("fetchCodexModels", () => {
	test("maps the Pi provider-keyed catalog and preserves tier pricing", async () => {
		const requests: { url: string; init: RequestInit | undefined }[] = [];
		const result = await fetchCodexModels({
			fetchFn: async (input, init) => {
				requests.push({ url: String(input), init });
				return response(
					{
						"gpt-6-astra": {
							id: "gpt-6-astra",
							name: "GPT-6 Astra",
							api: "openai-codex-responses",
							provider: "openai-codex",
							baseUrl: "https://chatgpt.com/backend-api",
							reasoning: true,
							input: ["text", "image"],
							cost: {
								input: 10,
								output: 50,
								cacheRead: 1,
								cacheWrite: 12.5,
								tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
							},
							contextWindow: 272_000,
							maxTokens: 128_000,
							thinkingLevelMap: { off: null, low: "low", max: "max" },
						},
					},
					{ status: 200, headers: { etag: 'W/"astra"' } },
				);
			},
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(PI_CODEX_CATALOG_URL);
		expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBeNull();
		expect(result?.etag).toBe('W/"astra"');
		expect(result?.models).toEqual([
			{
				id: "gpt-6-astra",
				name: "GPT-6 Astra",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text", "image"],
				cost: {
					input: 10,
					output: 50,
					cacheRead: 1,
					cacheWrite: 12.5,
					longContext: { inputThreshold: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 },
				},
				remoteCompaction: { enabled: true, api: "openai-codex-responses", v2StreamingEnabled: true },
				contextWindow: 272_000,
				maxTokens: 128_000,
				preferWebsockets: true,
			},
		]);
	});

	test("keeps the one-million-token floor for GPT-5.6 Codex models", async () => {
		const result = await fetchCodexModels({
			fetchFn: async () =>
				response({
					"gpt-5.6-luna": {
						id: "gpt-5.6-luna",
						name: "GPT-5.6 Luna",
						api: "openai-codex-responses",
						baseUrl: "https://chatgpt.com/backend-api",
						reasoning: true,
						input: ["text", "image"],
						cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
						contextWindow: 272_000,
						maxTokens: 128_000,
					},
				}),
		});

		expect(result?.models[0]?.contextWindow).toBe(1_000_000);
	});

	test("rejects unavailable or empty remote catalogs", async () => {
		const unavailable = await fetchCodexModels({
			fetchFn: async () => response({}, { status: 503, statusText: "Service Unavailable" }),
		});
		const empty = await fetchCodexModels({ fetchFn: async () => response({}) });

		expect(unavailable).toBeNull();
		expect(empty).toBeNull();
	});
});
