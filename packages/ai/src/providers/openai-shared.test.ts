import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AssistantMessage, Model } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { ResponseStreamEvent } from "./openai-responses-wire";
import { createInitialResponsesAssistantMessage, processResponsesStream } from "./openai-shared";

function responsesModel(): Model<"openai-responses"> {
	return buildModel({
		id: "openai-shared-stream-test",
		name: "OpenAI Shared Stream Test",
		api: "openai-responses",
		provider: "openai-test",
		baseUrl: "https://responses.example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_384,
		maxTokens: 1_024,
	});
}

function event(value: Record<string, unknown>): ResponseStreamEvent {
	return value as unknown as ResponseStreamEvent;
}

async function runResponses(events: readonly ResponseStreamEvent[]): Promise<AssistantMessage> {
	const output = createInitialResponsesAssistantMessage("openai-responses", "openai-test", "test-model");
	const stream = new AssistantMessageEventStream();
	async function* source(): AsyncGenerator<ResponseStreamEvent> {
		yield* events;
	}
	await processResponsesStream(source(), output, stream, responsesModel());
	return output;
}

function messageAdded(id: string): ResponseStreamEvent {
	return event({
		type: "response.output_item.added",
		output_index: 0,
		sequence_number: 1,
		item: { type: "message", id, role: "assistant", status: "in_progress", content: [] },
	});
}

function messageDelta(id: string, delta: string): ResponseStreamEvent {
	return event({
		type: "response.output_text.delta",
		content_index: 0,
		delta,
		item_id: id,
		logprobs: [],
		output_index: 0,
		sequence_number: 2,
	});
}

function messageDeltaByIndex(delta: string): ResponseStreamEvent {
	return event({
		type: "response.output_text.delta",
		content_index: 0,
		delta,
		logprobs: [],
		output_index: 0,
		sequence_number: 2,
	});
}

function messageDone(id: string, text: string): ResponseStreamEvent {
	return event({
		type: "response.output_item.done",
		output_index: 0,
		sequence_number: 3,
		item: {
			type: "message",
			id,
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text, annotations: [] }],
		},
	});
}

function functionCallAdded(id: string, callId: string, name: string): ResponseStreamEvent {
	return event({
		type: "response.output_item.added",
		output_index: 0,
		sequence_number: 1,
		item: { type: "function_call", id, call_id: callId, name, arguments: "", status: "in_progress" },
	});
}

function functionCallDelta(id: string, delta: string): ResponseStreamEvent {
	return event({
		type: "response.function_call_arguments.delta",
		delta,
		item_id: id,
		output_index: 0,
		sequence_number: 2,
	});
}

function functionCallArgumentsDone(id: string, args: string): ResponseStreamEvent {
	return event({
		type: "response.function_call_arguments.done",
		arguments: args,
		item_id: id,
		name: "alpha",
		output_index: 0,
		sequence_number: 3,
	});
}

function functionCallDone(id: string, callId: string, name: string, args: string): ResponseStreamEvent {
	return event({
		type: "response.output_item.done",
		output_index: 0,
		sequence_number: 3,
		item: { type: "function_call", id, call_id: callId, name, arguments: args, status: "completed" },
	});
}

describe("OpenAI Responses streamed item routing", () => {
	it("keeps duplicate-index message deltas and completion events on their item ids", async () => {
		const output = await runResponses([
			messageAdded("mA"),
			messageAdded("mB"),
			messageDelta("mA", "A"),
			messageDelta("mB", "B"),
			messageDone("mA", "A"),
			messageDone("mB", "B"),
		]);

		expect(output.content.filter(block => block.type === "text").map(block => block.text)).toEqual(["A", "B"]);
	});

	it("keeps index-only deltas on the remaining item after the newest duplicate closes", async () => {
		const output = await runResponses([
			messageAdded("mA"),
			messageAdded("mB"),
			messageDone("mB", "B"),
			messageDeltaByIndex("A"),
			messageDone("mA", "A"),
		]);

		expect(output.content.filter(block => block.type === "text").map(block => block.text)).toEqual(["A", "B"]);
	});

	it("keeps duplicate-index function-call argument streams separate", async () => {
		const output = await runResponses([
			functionCallAdded("fA", "cA", "alpha"),
			functionCallAdded("fB", "cB", "beta"),
			functionCallDelta("fA", '{"a":'),
			functionCallDelta("fB", '{"b":'),
			functionCallDone("fA", "cA", "alpha", '{"a":1}'),
			functionCallDone("fB", "cB", "beta", '{"b":2}'),
		]);

		expect(
			output.content
				.filter(block => block.type === "toolCall")
				.map(block => ({ name: block.name, arguments: block.arguments })),
		).toEqual([
			{ name: "alpha", arguments: { a: 1 } },
			{ name: "beta", arguments: { b: 2 } },
		]);
	});
});

describe("OpenAI Responses incomplete streamed tool calls", () => {
	it("accepts a complete accumulated function-call value when no item-done event arrives", async () => {
		const output = await runResponses([
			functionCallAdded("fA", "cA", "alpha"),
			functionCallDelta("fA", '{"a":1}'),
			event({ type: "response.completed", sequence_number: 3, response: { status: "completed" } }),
		]);

		expect(output.stopReason).toBe("toolUse");
		expect(output.content.filter(block => block.type === "toolCall").map(block => block.arguments)).toEqual([
			{ a: 1 },
		]);
	});

	it("keeps repaired arguments for an invalid but complete output-item value", async () => {
		const output = await runResponses([
			functionCallAdded("fA", "cA", "alpha"),
			functionCallDone("fA", "cA", "alpha", "{a:1}"),
			event({ type: "response.completed", sequence_number: 4, response: { status: "completed" } }),
		]);

		expect(output.stopReason).toBe("toolUse");
		expect(output.content.filter(block => block.type === "toolCall").map(block => block.arguments)).toEqual([
			{ a: 1 },
		]);
	});

	it("does not promote a prefix in output_item.done to executable tool use", async () => {
		const output = await runResponses([
			functionCallAdded("fA", "cA", "alpha"),
			functionCallDone("fA", "cA", "alpha", '{"a":"prefix'),
			event({ type: "response.completed", sequence_number: 4, response: { status: "completed" } }),
		]);

		expect(output.stopReason).toBe("length");
		expect(output.content.filter(block => block.type === "toolCall").map(block => block.arguments)).toEqual([{}]);
	});

	it("does not promote a prefix in function_call_arguments.done to executable tool use", async () => {
		const output = await runResponses([
			functionCallAdded("fA", "cA", "alpha"),
			functionCallArgumentsDone("fA", '{"a":"prefix'),
			event({ type: "response.completed", sequence_number: 4, response: { status: "completed" } }),
		]);

		expect(output.stopReason).toBe("length");
		expect(output.content.filter(block => block.type === "toolCall").map(block => block.arguments)).toEqual([{}]);
	});

	it("does not promote a prefix-only function call to executable tool use", async () => {
		const output = await runResponses([
			functionCallAdded("fA", "cA", "alpha"),
			functionCallDelta("fA", '{"a":"prefix'),
			event({ type: "response.completed", sequence_number: 3, response: { status: "completed" } }),
		]);

		expect(output.stopReason).toBe("length");
		expect(output.content.filter(block => block.type === "toolCall").map(block => block.arguments)).toEqual([{}]);
	});
});
