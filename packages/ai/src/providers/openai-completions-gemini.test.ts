import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { FetchImpl, Message } from "../types";
import { streamOpenAICompletions } from "./openai-completions";

const model = buildModel({
	id: "gemini-3.7-flash",
	name: "Gemini 3.7 Flash",
	api: "openai-completions",
	provider: "gemini-gateway",
	baseUrl: "https://gemini-gateway.example.test/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
});

const userMessage: Message = { role: "user", content: "Read README.md", timestamp: 1 };

function sse(frames: readonly unknown[]): Response {
	const body = `${frames.map(frame => `data: ${JSON.stringify(frame)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** First request streams one tool call carrying `delta`; later requests finish with text. Captures request bodies. */
function geminiGatewayFetch(delta: Record<string, unknown>, bodies: Record<string, unknown>[]): FetchImpl {
	return Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			bodies.push(JSON.parse(String(init?.body)));
			if (bodies.length > 1) {
				return sse([{ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] }]);
			}
			return sse([
				{ choices: [{ index: 0, delta }] },
				{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]);
		},
		{ preconnect: fetch.preconnect },
	);
}

async function replayedAssistant(delta: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
	const bodies: Record<string, unknown>[] = [];
	const fetchImpl = geminiGatewayFetch(delta, bodies);
	const assistant = await streamOpenAICompletions(
		model,
		{ messages: [userMessage] },
		{ apiKey: "k", fetch: fetchImpl },
	).result();
	const toolCall = assistant.content.find(block => block.type === "toolCall");
	if (toolCall?.type !== "toolCall") throw new Error("streamed tool call missing");
	const toolResult: Message = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: "README contents" }],
		isError: false,
		timestamp: 2,
	};
	await streamOpenAICompletions(
		model,
		{ messages: [userMessage, assistant, toolResult] },
		{ apiKey: "k", fetch: fetchImpl },
	).result();
	const messages = bodies[1]?.messages;
	if (!Array.isArray(messages)) throw new Error("continuation messages missing");
	return messages.find(message => message.role === "assistant");
}

function toolCallDelta(extra?: Record<string, unknown>): Record<string, unknown> {
	return {
		index: 0,
		id: "call_1",
		type: "function",
		function: { name: "read", arguments: '{"path":"README.md"}' },
		...(extra ? { extra_content: extra } : {}),
	};
}

describe("Gemini thought signatures over OpenAI-compatible gateways", () => {
	it("replays per-call extra_content and the message-level signature together", async () => {
		const assistant = await replayedAssistant({
			role: "assistant",
			thinking_signature: "message-sig",
			tool_calls: [toolCallDelta({ google: { thought_signature: "per-call-sig" } })],
		});

		expect(assistant).toMatchObject({
			thinking_signature: "message-sig",
			tool_calls: [{ id: "call_1", extra_content: { google: { thought_signature: "per-call-sig" } } }],
		});
		expect(assistant).not.toHaveProperty("reasoning_details");
	});

	it("replays the Vertex namespace and the thought_signature alias under their own names", async () => {
		const assistant = await replayedAssistant({
			role: "assistant",
			thought_signature: "message-sig",
			tool_calls: [toolCallDelta({ vertex: { thought_signature: "per-call-sig" } })],
		});

		expect(assistant).toMatchObject({
			thought_signature: "message-sig",
			tool_calls: [{ extra_content: { vertex: { thought_signature: "per-call-sig" } } }],
		});
	});
});

describe("Gemini cache accounting over OpenAI-compatible gateways", () => {
	it("prices Vertex cachedContentTokenCount hits as cache reads", async () => {
		const fetchImpl = Object.assign(
			async (): Promise<Response> =>
				sse([
					{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
					{ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 10, cachedContentTokenCount: 800 } },
				]),
			{ preconnect: fetch.preconnect },
		);
		const result = await streamOpenAICompletions(
			model,
			{ messages: [userMessage] },
			{ apiKey: "k", fetch: fetchImpl },
		).result();

		expect(result.usage).toMatchObject({ input: 200, cacheRead: 800, output: 10 });
	});
});
