import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Context, FetchImpl } from "../types";
import { getStreamingPartialJson } from "../utils/block-symbols";
import { streamOpenAICompletions } from "./openai-completions";

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
