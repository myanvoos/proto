import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { stream } from "../stream";
import type { Api, CacheRetention, FetchImpl } from "../types";

describe("Shared Go task cache routing", () => {
	const cases: {
		name: string;
		provider: string;
		api: Api;
		id: string;
		retention: CacheRetention;
		key?: string;
		affinity: string;
	}[] = [
		{
			name: "shares verified Responses siblings",
			provider: "opencode-go",
			api: "openai-responses",
			id: "gpt-6-luna",
			retention: "short",
			key: "task-family",
			affinity: "task-family",
		},
		{
			name: "shares verified Completions siblings",
			provider: "opencode-go",
			api: "openai-completions",
			id: "deepseek-v4-pro",
			retention: "short",
			key: "task-family",
			affinity: "task-family",
		},
		{
			name: "does not share an unverified API for the same model",
			provider: "opencode-go",
			api: "openai-completions",
			id: "gpt-6-luna",
			retention: "short",
			key: "task-family",
			affinity: "child-conversation",
		},
		{
			name: "does not share an unknown model",
			provider: "opencode-go",
			api: "openai-responses",
			id: "unknown-model",
			retention: "short",
			key: "task-family",
			affinity: "child-conversation",
		},
		{
			name: "honors disabled prompt caching",
			provider: "opencode-go",
			api: "openai-responses",
			id: "gpt-6-luna",
			retention: "none",
			key: "task-family",
			affinity: "child-conversation",
		},
		{
			name: "keeps implicit per-child cache keys out of family routing",
			provider: "opencode-go",
			api: "openai-responses",
			id: "gpt-6-luna",
			retention: "short",
			affinity: "child-conversation",
		},
		{
			name: "does not change Zen conversation routing",
			provider: "opencode-zen",
			api: "openai-responses",
			id: "gpt-6-luna",
			retention: "short",
			key: "task-family",
			affinity: "child-conversation",
		},
	];
	for (const row of cases) {
		it(row.name, async () => {
			let captured: Headers | undefined;
			const fetchImpl: FetchImpl = async (_input, init) => {
				captured = new Headers(init?.headers);
				return Response.json({ error: { message: "captured request" } }, { status: 400 });
			};
			const model = buildModel({
				provider: row.provider,
				api: row.api,
				id: row.id,
				name: row.id,
				baseUrl: "https://example.test/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 16384,
				maxTokens: 1024,
			});
			await stream(
				model,
				{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
				{
					apiKey: "test-key",
					fetch: fetchImpl,
					sessionId: "child-conversation",
					promptCacheKey: row.key,
					cacheRetention: row.retention,
					maxTokens: 16,
				},
			).result();
			expect(captured?.get("x-opencode-session")).toBe(row.affinity);
		});
	}
});
