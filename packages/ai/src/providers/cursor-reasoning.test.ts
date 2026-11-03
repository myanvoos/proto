import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AgentClientMessageSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { fromBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import type { AssistantMessage, Context, Model } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type BlockState,
	buildGrpcRequest,
	flushOpenToolCalls,
	processInteractionUpdate,
	type ToolCallState,
	type UsageState,
} from "./cursor";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

function cursorModel(id: string): Model<"cursor-agent"> {
	return buildModel({
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}

async function requestedModelFor(id: string) {
	const { requestBytes } = await buildGrpcRequest(cursorModel(id), context, undefined, {
		conversationId: `conversation-${id}`,
		blobStore: new Map(),
	});
	const decoded = fromBinary(AgentClientMessageSchema, requestBytes);
	if (decoded.message.case !== "runRequest") throw new Error("expected Cursor runRequest");
	return decoded.message.value.requestedModel;
}

interface CursorStreamHarness {
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	state: BlockState;
	usageState: UsageState;
}

function createCursorStreamHarness(): CursorStreamHarness {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	const state: BlockState = {
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		openToolCalls: new Map(),
		resolvedMcpToolCallIds: new Set(),
		firstTokenTime: undefined,
		setTextBlock: block => {
			textBlock = block;
		},
		setThinkingBlock: block => {
			thinkingBlock = block;
		},
		setToolCall: block => {
			toolCall = block;
		},
		setFirstTokenTime: () => {},
	};
	return { output, stream: new AssistantMessageEventStream(), state, usageState: { sawTokenDelta: false } };
}

describe("Cursor reasoning sibling resolution", () => {
	it("normalizes an off-tier sibling to the base model without a reasoning parameter", async () => {
		const requestedModel = await requestedModelFor("gpt-5.6-sol-none");

		expect(requestedModel?.modelId).toBe("gpt-5.6-sol");
		expect(requestedModel?.parameters).toEqual([]);
	});

	it("normalizes extra-high to Cursor's xhigh reasoning parameter", async () => {
		const requestedModel = await requestedModelFor("gpt-5.6-sol-extra-high");

		expect(requestedModel?.modelId).toBe("gpt-5.6-sol");
		expect(requestedModel?.parameters).toEqual([expect.objectContaining({ id: "reasoning", value: "xhigh" })]);
	});
});

describe("Cursor streamed tool-call flush", () => {
	it("preserves arguments decoded from the announce frame when no delta arrives", () => {
		const harness = createCursorStreamHarness();
		processInteractionUpdate(
			{
				message: {
					case: "toolCallStarted",
					value: {
						callId: "call-weather",
						toolCall: {
							mcpToolCall: {
								args: {
									toolCallId: "call-weather",
									toolName: "get_weather",
									args: { city: new TextEncoder().encode('"Paris"') },
								},
							},
						},
					},
				},
			},
			harness.output,
			harness.stream,
			harness.state,
			harness.usageState,
		);

		flushOpenToolCalls(harness.output, harness.stream, harness.state);

		expect(harness.output.content[0]).toMatchObject({
			type: "toolCall",
			id: "call-weather",
			name: "get_weather",
			arguments: { city: "Paris" },
		});
		expect(harness.state.currentToolCall).toBeNull();
	});
});

it("Cursor replays multi-step turns with their round results in arrival order and keeps system rules", async () => {
	const model = cursorModel("gpt-5.6-sol");
	const harness = createCursorStreamHarness();
	const history: Context = {
		systemPrompt: ["Keep this policy"],
		messages: [
			{ role: "user", content: "old", timestamp: 0 },
			{
				...harness.output,
				model: model.id,
				content: [
					{ type: "toolCall", id: "a", name: "read", arguments: {} },
					{ type: "toolCall", id: "b", name: "read", arguments: {} },
					{ type: "text", text: "final answer" },
				],
			},
			{
				role: "toolResult",
				toolCallId: "b",
				toolName: "read",
				content: [{ type: "text", text: "B" }],
				isError: false,
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "a",
				toolName: "read",
				content: [{ type: "text", text: "A" }],
				isError: false,
				timestamp: 1,
			},
			{ role: "user", content: "next", timestamp: 2 },
		],
	};
	const blobStore = new Map<string, Uint8Array>();
	const { conversationState } = await buildGrpcRequest(model, history, undefined, {
		conversationId: "multi-step",
		blobStore,
	});
	const records = conversationState.rootPromptMessagesJson.map(id => {
		const bytes = blobStore.get(Buffer.from(id).toString("hex"));
		if (!bytes) throw new Error("Missing replay blob");
		return JSON.parse(new TextDecoder().decode(bytes)) as { role: string; id?: string; content: unknown };
	});
	expect(records.map(record => record.role)).toEqual([
		"system",
		"user",
		"user",
		"assistant",
		"tool",
		"tool",
		"assistant",
	]);
	expect(records[1]?.content).toContain("Keep this policy");
	expect(records.filter(record => record.role === "tool").map(record => record.id)).toEqual(["b", "a"]);
});
