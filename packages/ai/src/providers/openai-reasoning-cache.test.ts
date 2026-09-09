import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Context, FetchImpl, Model, ProviderSessionState } from "../types";
import { streamOpenAICompletions } from "./openai-completions";
import { streamOpenAIResponses } from "./openai-responses";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function createCompletionsModel(): Model<"openai-completions"> {
	return buildModel({
		id: "reasoning-cache-completions",
		name: "Reasoning Cache Completions",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://completions.example.test/v1",
		reasoning: true,
		compat: {
			thinkingFormat: "openai",
			reasoningDisableMode: "none-effort",
			supportsReasoningParams: true,
			supportsReasoningEffort: true,
		},
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function createResponsesModel(): Model<"openai-responses"> {
	return buildModel({
		id: "reasoning-cache-responses",
		name: "Reasoning Cache Responses",
		api: "openai-responses",
		provider: "custom-responses",
		baseUrl: "https://responses.example.test/v1",
		reasoning: true,
		compat: {
			reasoningDisableMode: "none-effort",
			supportsReasoningParams: true,
			supportsReasoningEffort: true,
		},
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function parseJsonBody(init: RequestInit | undefined): Record<string, unknown> {
	return JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
}

function unsupportedNoneResponse(): Response {
	const message = 'level "none" not supported, valid levels: low, medium, high';
	return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
		status: 400,
		headers: { "content-type": "application/json" },
	});
}

function createChatSseResponse(): Response {
	const frames = [
		{
			id: "chatcmpl-reasoning-cache",
			object: "chat.completion.chunk",
			created: 0,
			model: "reasoning-cache-completions",
			choices: [{ index: 0, delta: { content: "ok" } }],
		},
		{
			id: "chatcmpl-reasoning-cache",
			object: "chat.completion.chunk",
			created: 0,
			model: "reasoning-cache-completions",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
		"[DONE]",
	];
	const body = frames.map(frame => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function createResponsesSseResponse(): Response {
	const events = [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "response-message", role: "assistant", content: [] },
		},
		{ type: "response.output_text.delta", delta: "ok" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "response-message",
				role: "assistant",
				content: [{ type: "output_text", text: "ok" }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "response-reasoning-cache",
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
	const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("OpenAI reasoning fallback cache", () => {
	it("does not strip a later enabled Completions effort after a retained-effort disable", async () => {
		const bodies: Record<string, unknown>[] = [];
		const providerSessionState = new Map<string, ProviderSessionState>();
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				return body.reasoning_effort === "none" ? unsupportedNoneResponse() : createChatSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const disabled = await streamOpenAICompletions(createCompletionsModel(), context, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
			disableReasoning: true,
			providerSessionState,
		}).result();
		const enabled = await streamOpenAICompletions(createCompletionsModel(), context, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
			providerSessionState,
		}).result();

		expect(disabled.stopReason).toBe("stop");
		expect(enabled.stopReason).toBe("stop");
		expect(bodies.map(body => body.reasoning_effort)).toEqual(["none", "low", "high"]);
	});

	it("does not strip a later enabled Responses effort after a retained-effort disable", async () => {
		const bodies: Record<string, unknown>[] = [];
		const providerSessionState = new Map<string, ProviderSessionState>();
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				const effort = (body.reasoning as { effort?: string } | undefined)?.effort;
				return effort === "none" ? unsupportedNoneResponse() : createResponsesSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const disabled = await streamOpenAIResponses(createResponsesModel(), context, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
			disableReasoning: true,
			providerSessionState,
		}).result();
		const enabled = await streamOpenAIResponses(createResponsesModel(), context, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
			providerSessionState,
		}).result();

		expect(disabled.stopReason).toBe("stop");
		expect(enabled.stopReason).toBe("stop");
		expect(bodies.map(body => (body.reasoning as { effort?: string } | undefined)?.effort)).toEqual([
			"none",
			"low",
			"high",
		]);
	});
	it("does not downgrade a later Responses turn after forceReasoningOff", async () => {
		const bodies: Record<string, unknown>[] = [];
		const providerSessionState = new Map<string, ProviderSessionState>();
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				const effort = (body.reasoning as { effort?: string } | undefined)?.effort;
				return effort === "none" ? unsupportedNoneResponse() : createResponsesSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const disabled = await streamOpenAIResponses(createResponsesModel(), context, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
			forceReasoningOff: true,
			providerSessionState,
		}).result();
		const enabled = await streamOpenAIResponses(createResponsesModel(), context, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
			providerSessionState,
		}).result();

		expect(disabled.stopReason).toBe("stop");
		expect(enabled.stopReason).toBe("stop");
		expect(bodies.map(body => (body.reasoning as { effort?: string } | undefined)?.effort)).toEqual([
			"none",
			"low",
			"high",
		]);
	});
});
