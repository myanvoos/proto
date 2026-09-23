import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Context, FetchImpl, ProviderSessionState } from "../types";
import { streamOpenAICompletions } from "./openai-completions";
import { resolveOpenAIReasoningEffortFallback } from "./openai-reasoning-fallback";

function reasoningRejection(message: string): {
	error: Error;
	captured: { status: number; bodyText: string; bodyJson: { error: { message: string } } };
} {
	return {
		error: new Error(message),
		captured: {
			status: 400,
			bodyText: message,
			bodyJson: { error: { message } },
		},
	};
}

describe("resolveOpenAIReasoningEffortFallback", () => {
	it("clamps a fieldless valid-levels rejection to the lowest supported effort", () => {
		const { error, captured } = reasoningRejection(
			'level "none" not supported, valid levels: low, medium, high, xhigh, max',
		);

		expect(
			resolveOpenAIReasoningEffortFallback(
				error,
				captured,
				{ reasoning: { effort: "none" } },
				{
					explicitDisable: true,
				},
			),
		).toBe("low");
	});

	it("clamps Copilot's fieldless Supported-values rejection to the lowest supported effort", () => {
		const { error, captured } = reasoningRejection(
			"Unsupported value: 'none' is not supported with the 'gpt-6-astra' model. " +
				"Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'.",
		);

		expect(
			resolveOpenAIReasoningEffortFallback(
				error,
				captured,
				{ reasoning: { effort: "none" } },
				{
					explicitDisable: true,
				},
			),
		).toBe("low");
	});

	it("does not mistake another field's Supported-values rejection for reasoning effort", () => {
		const { error, captured } = reasoningRejection(
			"Unsupported value: 'high' for text verbosity. Supported values are: 'low', 'medium'.",
		);

		expect(resolveOpenAIReasoningEffortFallback(error, captured, { reasoning: { effort: "high" } })).toBeUndefined();
	});

	it("does not retry effort when the error param names another none-valued field", () => {
		const message = "Unsupported value: 'none' is not supported. Supported values are: 'auto', 'required'.";
		const captured = {
			status: 400,
			bodyText: message,
			bodyJson: { error: { message, param: "tool_choice", type: "invalid_request_error" } },
		};

		expect(
			resolveOpenAIReasoningEffortFallback(
				new Error(message),
				captured,
				{ reasoning: { effort: "none" } },
				{
					explicitDisable: true,
				},
			),
		).toBeUndefined();
	});

	it("recognizes a CamelCase ReasoningEffort rejection", () => {
		const { error, captured } = reasoningRejection(
			"field ReasoningEffort invalid, should be one of: low, medium, high, xhigh, none",
		);

		expect(resolveOpenAIReasoningEffortFallback(error, captured, { reasoning_effort: "max" })).toBe("xhigh");
	});
});

describe("tool-suppressed reasoning on Azure Astra Chat Completions", () => {
	const astra = buildModel({
		id: "gpt-6-astra",
		name: "GPT-6 Astra",
		api: "openai-completions",
		provider: "azure",
		baseUrl: "https://resource.openai.azure.com/openai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 128_000,
	});
	const messages: Context["messages"] = [{ role: "user", content: "hello", timestamp: 0 }];
	const tools: Context["tools"] = [
		{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
	];

	function sse(): Response {
		const frames = [
			{
				id: "c",
				object: "chat.completion.chunk",
				created: 0,
				model: "m",
				choices: [{ index: 0, delta: { content: "ok" } }],
			},
			{
				id: "c",
				object: "chat.completion.chunk",
				created: 0,
				model: "m",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
		];
		const body = `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	}

	it("sends reasoning_effort none with function tools even after a cached effort fallback", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>);
				if (bodies.length > 1) return sse();
				const message = `invalid reasoning value: 'max' (must be "high", "medium", "low", or "none")`;
				return new Response(
					JSON.stringify({ error: { message, type: "invalid_request_error", param: "reasoning_effort" } }),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			},
			{ preconnect: fetch.preconnect },
		);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = { apiKey: "test-key", fetch: fetchMock, reasoning: "max" as const, providerSessionState };

		const first = await streamOpenAICompletions(astra, { messages }, options).result();
		const second = await streamOpenAICompletions(astra, { messages, tools }, options).result();

		expect([first.stopReason, second.stopReason]).toEqual(["stop", "stop"]);
		expect(bodies.map(body => body.reasoning_effort)).toEqual(["max", "high", "none"]);
		expect(bodies[2]?.tools).toHaveLength(1);
	});
});
