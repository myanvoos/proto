import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { buildCompactionV2Request, requestCompactionV2Streaming } from "./compaction-v2-streaming";

function sseResponse(events: Array<Record<string, unknown>>): Response {
	const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const MODEL = {
	id: "gpt-5",
	name: "GPT-5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 16_384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: {},
	remoteCompaction: { enabled: true, v2StreamingEnabled: true, v2Endpoint: "https://compact.example/v1/responses" },
} as Model;

describe("V2 streaming compaction retries", () => {
	test("retries a transport that closed the socket unexpectedly", async () => {
		const userItem = { type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] };
		const request = buildCompactionV2Request(MODEL, [userItem], "instructions");
		const compactionItem = { type: "compaction", encrypted_content: "enc_123" };
		let attempts = 0;
		const fetchMock: FetchImpl = async () => {
			attempts++;
			if (attempts === 1) throw new Error("The socket connection was closed unexpectedly");
			return sseResponse([
				{ type: "response.output_item.done", output_index: 0, item: compactionItem },
				{ type: "response.completed" },
			]);
		};

		const result = await requestCompactionV2Streaming(MODEL, "test-key", request, undefined, {
			fetch: fetchMock,
			retryWait: async () => {},
		});

		expect(attempts).toBe(2);
		expect(result.compactionItem).toEqual(compactionItem);
	});
});
