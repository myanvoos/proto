import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AssistantMessage, Context, Model, ModelSpec, ToolResultMessage } from "../types";
import { createOpenAIResponsesHistoryPayload } from "../utils";
import { streamAzureOpenAIResponses } from "./azure-openai-responses";
import { buildParams } from "./openai-responses";
import { buildResponsesInput, SYNTHETIC_REASONING_REPLAY_PLACEHOLDER } from "./openai-shared";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function responsesModel(
	spec: Pick<ModelSpec<"openai-responses">, "id" | "provider" | "baseUrl"> & Partial<ModelSpec<"openai-responses">>,
): Model<"openai-responses"> {
	return buildModel({
		name: spec.id,
		api: "openai-responses",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
		...spec,
	});
}

function assistant(model: Model<"openai-responses">, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage,
		stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 1,
	};
}

function toolResult(toolCallId: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError,
		timestamp: 2,
	};
}

type WireItem = { type?: string; role?: string; id?: string; content?: unknown; call_id?: string };

function reasoningItems(input: unknown): WireItem[] {
	return (input as WireItem[]).filter(item => item.type === "reasoning");
}

describe("Responses synthesized reasoning replay", () => {
	const deepseek = responsesModel({
		id: "deepseek-v4-flash",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go/v1",
	});

	it("sends a non-empty, id-less reasoning item when a DeepSeek turn lost its reasoning", () => {
		// DeepSeek 400s on a missing or empty reasoning_text; strict hosts reject a fabricated rs_ id.
		const context: Context = {
			messages: [
				{ role: "user", content: "Edit bar", timestamp: 0 },
				assistant(deepseek, [{ type: "text", text: "Edited bar.ts." }]),
				{ role: "user", content: "Run the tests", timestamp: 3 },
			],
		};
		const { params } = buildParams(deepseek, context, { reasoning: "high" }, undefined);
		const reasoning = reasoningItems(params.input);
		expect(reasoning).toHaveLength(1);
		expect(reasoning[0]).not.toHaveProperty("id");
		expect(reasoning[0].content).toEqual([{ type: "reasoning_text", text: SYNTHETIC_REASONING_REPLAY_PLACEHOLDER }]);
	});

	it("does not reconstruct filtered reasoning for hosts that reject synthetic reasoning", () => {
		const filtered = responsesModel({
			id: "meta/muse-spark-1.3",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			compat: { filterReasoningHistory: true, allowsSyntheticReasoningContentForToolCalls: false },
		});
		const context: Context = {
			messages: [
				{ role: "user", content: "Run echo 1", timestamp: 0 },
				assistant(filtered, [
					{ type: "thinking", thinking: "need to run echo 1" },
					{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo 1" } },
				]),
				toolResult("call_1", "1\n"),
				{ role: "user", content: "Now run echo 2", timestamp: 3 },
			],
		};
		const { params } = buildParams(filtered, context, { reasoning: "medium" }, undefined);
		expect(reasoningItems(params.input)).toEqual([]);
		expect(params.input).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call_1" }));
	});
});

describe("Responses orphan repair ordering", () => {
	it("keeps a repaired orphan-output note out of another call's call→output batch", () => {
		// Strict validators (DeepSeek via opencode-go) 400 with "No tool output found" when a message splits the batch.
		const model = responsesModel({
			id: "deepseek-v4-flash",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});
		const prior: AssistantMessage = {
			...assistant(model, [
				{ type: "toolCall", id: "call_00", name: "todo", arguments: {} },
				{ type: "toolCall", id: "call_01", name: "bash", arguments: { command: "ls" } },
			]),
			providerPayload: createOpenAIResponsesHistoryPayload(
				model.provider,
				[
					{ type: "reasoning", id: "rs_1", summary: [], content: [] },
					{ type: "function_call", call_id: "call_01", name: "bash", arguments: "{}" },
				],
				false,
			),
		};
		const items = buildResponsesInput({
			model,
			context: {
				messages: [
					prior,
					toolResult("call_00", "Invalid todo arguments", true),
					toolResult("call_01", "file listing"),
					{ role: "user", content: "continue", timestamp: 5 },
				],
			},
			strictResponsesPairing: false,
			supportsImageDetailOriginal: false,
			repairOrphanOutputs: true,
			nativeHistory: { replay: true, filterReasoning: false },
		}) as WireItem[];

		const noteIndex = items.findIndex(
			item => item.role === "assistant" && typeof item.content === "string" && item.content.includes("call_00"),
		);
		const callIndex = items.findIndex(item => item.type === "function_call" && item.call_id === "call_01");
		const outputIndex = items.findIndex(item => item.type === "function_call_output" && item.call_id === "call_01");
		expect(items[noteIndex]?.content).toContain("[Orphan tool result; call_id=call_00]");
		expect(noteIndex).toBeLessThan(callIndex);
		expect(outputIndex).toBe(callIndex + 1);
	});
});

describe("Azure Responses malformed replay", () => {
	it("keeps the result of a dropped malformed function call as an orphan note", async () => {
		const model: Model<"azure-openai-responses"> = buildModel({
			id: "gpt-5-mini",
			name: "GPT-5 Mini",
			api: "azure-openai-responses",
			provider: "azure",
			baseUrl: "https://example.openai.azure.com/openai/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		});
		const previous: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "azure-openai-responses",
			provider: "azure",
			model: model.id,
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: 1,
			providerPayload: createOpenAIResponsesHistoryPayload("azure", [
				{ type: "function_call", id: "fc_bad", call_id: "call_bad", name: "bash", arguments: '{"command":"unterm' },
				{ type: "function_call_output", call_id: "call_bad", output: "durable result" },
			]),
		};
		const controller = new AbortController();
		controller.abort();
		const { promise, resolve } = Promise.withResolvers<{ input: WireItem[] }>();
		streamAzureOpenAIResponses(
			model,
			{ messages: [previous, { role: "user", content: "continue", timestamp: 2 }] },
			{
				apiKey: "test-key",
				azureBaseUrl: model.baseUrl,
				azureApiVersion: "v1",
				signal: controller.signal,
				onPayload: payload => resolve(payload as { input: WireItem[] }),
			},
		);
		const { input } = await promise;
		expect(input).not.toContainEqual(expect.objectContaining({ call_id: "call_bad" }));
		expect(JSON.stringify(input)).toContain("durable result");
	});
});
