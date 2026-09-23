import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Context, FetchImpl } from "../types";
import { streamOpenAIResponses } from "./openai-responses";

const model = buildModel({
	id: "gpt-body-timeout",
	name: "Body Timeout",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
});
const context: Context = { messages: [{ role: "user", content: "Read the file", timestamp: 1 }] };

function bodyTimeout(): Response {
	return new Response(
		JSON.stringify({ error: { code: "user_request_timeout", message: "Timed out reading request body." } }),
		{ status: 408, headers: { "content-type": "application/json" } },
	);
}

function completed(text: string): Response {
	const events = [
		{ type: "response.created", response: { id: "resp_ok", status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_ok", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, item_id: "msg_ok", delta: text },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_ok",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{ type: "response.completed", response: { id: "resp_ok", status: "completed" } },
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

function sequence(responses: Array<() => Response>): { fetch: FetchImpl; bodies: Record<string, unknown>[] } {
	const bodies: Record<string, unknown>[] = [];
	const fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>);
			return (responses[bodies.length - 1] ?? responses[responses.length - 1])();
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	return { fetch, bodies };
}

describe("Responses request-body-read timeout", () => {
	it("surfaces a full-replay body-read 408 for session recovery instead of resending it unchanged", async () => {
		const { fetch, bodies } = sequence([bodyTimeout, () => completed("must not be requested")]);

		const result = await streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			fetch,
			providerRetryWait: async () => {},
		}).result();

		expect(bodies).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(408);
		expect(result.requestBodyReadTimeoutFullReplay).toBe(true);
	});

	it("keeps transport retries for a previous-response delta", async () => {
		const { fetch, bodies } = sequence([bodyTimeout, () => completed("recovered")]);

		const result = await streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			fetch,
			providerRetryWait: async () => {},
			onPayload: payload => ({ ...(payload as Record<string, unknown>), previous_response_id: "resp_prior" }),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).toHaveProperty("previous_response_id", "resp_prior");
	});
});
