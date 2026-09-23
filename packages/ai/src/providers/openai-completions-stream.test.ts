import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { registerCustomApi, unregisterCustomApis } from "../api-registry";
import { streamSimple } from "../stream";
import type { Api, Context, FetchImpl, Model } from "../types";
import { getStreamingPartialJson } from "../utils/block-symbols";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "./openai-completions";

const model = buildModel({
	id: "done-sentinel-test",
	name: "Done Sentinel Test",
	api: "openai-completions",
	provider: "custom",
	baseUrl: "https://completions.example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4_096,
});

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

function fetchFor(frames: readonly unknown[]): FetchImpl {
	const body = frames.map(frame => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join("");
	return Object.assign(
		async (): Promise<Response> => new Response(body, { headers: { "content-type": "text/event-stream" } }),
		{ preconnect: fetch.preconnect },
	);
}

async function runStream(
	frames: readonly unknown[],
): Promise<{ stopReason: string; errorMessage?: string; text: string }> {
	const result = await streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		fetch: fetchFor(frames),
	}).result();
	const text = result.content.reduce((combined, block) => {
		return block.type === "text" ? combined + block.text : combined;
	}, "");
	return { stopReason: result.stopReason, errorMessage: result.errorMessage, text };
}

describe("OpenAI Completions stream termination", () => {
	it("treats [DONE] without finish_reason as a clean completion", async () => {
		const result = await runStream([
			{ choices: [{ delta: { content: "Hel" } }] },
			{ choices: [{ delta: { content: "lo" } }] },
			"[DONE]",
		]);

		expect(result).toEqual({ stopReason: "stop", errorMessage: undefined, text: "Hello" });
	});

	it("reports a 200 body that is not a stream instead of an empty successful turn", async () => {
		const fetchImpl = Object.assign(
			async (): Promise<Response> =>
				new Response("<html>not json at all</html>", { headers: { "content-type": "text/html" } }),
			{ preconnect: fetch.preconnect },
		);
		const result = await streamOpenAICompletions(model, context, { apiKey: "test-key", fetch: fetchImpl }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("OpenAI completions response was not a stream");
		expect(result.errorMessage).toContain("content-type text/html");
		expect(result.content).toEqual([]);
	});

	it("maps uppercase Gemini-style finish reasons instead of failing the turn", async () => {
		const stopped = await runStream([
			{ choices: [{ delta: { content: "Hel" } }] },
			{ choices: [{ delta: {}, finish_reason: "STOP" }] },
			"[DONE]",
		]);
		const truncated = await runStream([
			{ choices: [{ delta: { content: "Hel" } }] },
			{ choices: [{ delta: {}, finish_reason: "MAX_TOKENS" }] },
			"[DONE]",
		]);

		expect(stopped).toEqual({ stopReason: "stop", errorMessage: undefined, text: "Hel" });
		expect(truncated).toEqual({ stopReason: "length", errorMessage: undefined, text: "Hel" });
	});

	it("still reports a genuine EOF without [DONE] or finish_reason as incomplete", async () => {
		const result = await runStream([
			{ choices: [{ delta: { content: "Hel" } }] },
			{ choices: [{ delta: { content: "lo" } }] },
		]);

		expect(result).toEqual({
			stopReason: "error",
			errorMessage: "OpenAI completions stream closed before a finish_reason was received",
			text: "Hello",
		});
	});
});

describe("OpenAI Completions streamed tool-call arguments", () => {
	const toolFrames = [
		{
			choices: [
				{
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "call_1",
								type: "function",
								function: { name: "bash", arguments: '{"command": "' },
							},
						],
					},
				},
			],
		},
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "rg -n needle" } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' src"}' } }] } }] },
		{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		"[DONE]",
	];

	it("exposes the raw argument prefix on every delta so consumers can render partial args", async () => {
		const stream = streamOpenAICompletions(model, context, { apiKey: "test-key", fetch: fetchFor(toolFrames) });
		const prefixes: (string | undefined)[] = [];
		let prefixAtEnd: string | undefined = "unset";
		for await (const event of stream) {
			if (event.type === "toolcall_delta") {
				prefixes.push(getStreamingPartialJson(event.partial.content[event.contentIndex]));
			} else if (event.type === "toolcall_end") {
				prefixAtEnd = getStreamingPartialJson(event.toolCall);
			}
		}

		expect(prefixes).toEqual(['{"command": "', '{"command": "rg -n needle', '{"command": "rg -n needle src"}']);
		expect(prefixAtEnd).toBeUndefined();
	});

	it("does not complete a prefix even when finish_reason claims tool completion", async () => {
		const frames = [
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_prefix",
									type: "function",
									function: { name: "bash", arguments: '{"command": "' },
								},
							],
						},
					},
				],
			},
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
			"[DONE]",
		];
		const events: string[] = [];
		const stream = streamOpenAICompletions(model, context, { apiKey: "test-key", fetch: fetchFor(frames) });
		for await (const event of stream) {
			if (event.type === "toolcall_end") events.push(event.toolCall.id);
		}
		const result = await stream.result();

		expect(events).toEqual([]);
		expect(result.stopReason).toBe("length");
	});

	it("still repairs malformed but complete tool arguments", async () => {
		const result = await streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			fetch: fetchFor([
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_repair",
										type: "function",
										function: { name: "bash", arguments: "{command: 'pwd',}" },
									},
								],
							},
						},
					],
				},
				{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
				"[DONE]",
			]),
		}).result();
		const call = result.content.find(block => block.type === "toolCall");

		expect(call).toMatchObject({ name: "bash", arguments: { command: "pwd" } });
	});

	it("parses the accumulated prefix into final arguments", async () => {
		const result = await streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			fetch: fetchFor(toolFrames),
		}).result();
		const call = result.content.find(block => block.type === "toolCall");

		expect(call).toMatchObject({ name: "bash", arguments: { command: "rg -n needle src" } });
	});
});

describe("OpenAI Completions tool-call TTFT", () => {
	const toolCallOnlyFrames = [
		{
			choices: [
				{
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "call_ttft",
								type: "function",
								function: { name: "bash", arguments: '{"command":"pwd"}' },
							},
						],
					},
				},
			],
		},
		{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		"[DONE]",
	];

	it("records firstTokenTime when the stream emits only tool-call deltas", async () => {
		const result = await streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			fetch: fetchFor(toolCallOnlyFrames),
		}).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.ttft).toBeDefined();
		expect(result.ttft).toBeGreaterThanOrEqual(0);
		expect(result.ttft).toBeLessThanOrEqual(result.duration ?? Number.POSITIVE_INFINITY);
	});
});

describe("OpenAI Completions behind a custom API", () => {
	const CUSTOM_API = "openai-completions-wrapper-test";
	const CUSTOM_API_SOURCE = "openai-completions-stream-test";
	afterEach(() => unregisterCustomApis(CUSTOM_API_SOURCE));

	it("resolves the OpenAI wire policy and honors declared compat overrides", async () => {
		const customModel = buildModel({
			id: "hy4-preview",
			name: "HY4 Preview",
			api: CUSTOM_API,
			provider: "custom-wrapper",
			baseUrl: "https://completions.example.test/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131_072,
			maxTokens: 8_192,
			compat: { maxTokensField: "max_tokens", supportsSamplingParams: false },
		} as Parameters<typeof buildModel<Api>>[0]);
		registerCustomApi(
			CUSTOM_API,
			(delegated, messages, options) =>
				streamOpenAICompletions(
					delegated as Model<"openai-completions">,
					messages,
					(options ?? {}) as OpenAICompletionsOptions,
				),
			CUSTOM_API_SOURCE,
		);
		let request: Record<string, unknown> | undefined;
		const frames = fetchFor([
			{ choices: [{ delta: { content: "ok" } }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
			"[DONE]",
		]);
		const capturingFetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				if (typeof init?.body === "string") request = JSON.parse(init.body) as Record<string, unknown>;
				return frames(input, init);
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamSimple(customModel, context, {
			apiKey: "test-key",
			fetch: capturingFetch,
			temperature: 0.7,
			maxTokens: 321,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(request?.max_tokens).toBe(321);
		expect(request?.max_completion_tokens).toBeUndefined();
		expect(request?.temperature).toBeUndefined();
	});
});

describe("OpenAI Completions scheduled pricing", () => {
	it("prices usage at the request-start tariff when the stream ends after a UTC boundary", async () => {
		const scheduled = buildModel({
			id: "scheduled-flash",
			name: "Scheduled Flash",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://completions.example.test/v1",
			reasoning: false,
			input: ["text"],
			cost: {
				input: 0.3,
				output: 1.2,
				cacheRead: 0,
				cacheWrite: 0,
				timeBased: {
					offPeakMultiplier: 0.5,
					peakWindows: [{ weekdays: [1, 2, 3, 4, 5], startMinute: 60, endMinute: 240 }],
				},
			},
			contextWindow: 32_000,
			maxTokens: 4_096,
		});
		const peakStart = Date.parse("2026-09-10T03:59:59Z");
		let now = peakStart;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const frames = fetchFor([
			{ choices: [{ delta: { content: "ok" } }] },
			{
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1_000_000, completion_tokens: 200_000 },
			},
			"[DONE]",
		]);
		// The response arrives once the off-peak tariff has begun.
		const lateFetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				now = Date.parse("2026-09-10T04:00:00Z");
				return frames(input, init);
			},
			{ preconnect: fetch.preconnect },
		);
		try {
			const result = await streamOpenAICompletions(scheduled, context, {
				apiKey: "test-key",
				fetch: lateFetch,
			}).result();
			expect(result.timestamp).toBe(peakStart);
			expect(result.usage.cost.total).toBeCloseTo(0.54, 12);
		} finally {
			clock.mockRestore();
		}
	});
});
