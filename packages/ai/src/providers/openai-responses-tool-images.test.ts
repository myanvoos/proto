import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Context, Model } from "../types";
import type { ResponseInput } from "./openai-responses-wire";
import { buildResponsesInput, escapeReplayedControlTokens } from "./openai-shared";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function responsesModel(input: Model["input"]): Model<"openai-responses"> {
	return buildModel({
		id: "moonshotai/kimi-k3",
		name: "Kimi K3",
		api: "openai-responses",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	});
}

function imageToolTurn(model: Model<"openai-responses">): Context {
	return {
		messages: [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call_read_1", name: "read", arguments: { path: "a.png" } },
					{ type: "toolCall", id: "call_bash_2", name: "bash", arguments: { command: "true" } },
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call_read_1",
				toolName: "read",
				content: [
					{ type: "text", text: "first" },
					{ type: "image", mimeType: "image/png", data: "AAAA" },
				],
				isError: false,
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call_bash_2",
				toolName: "bash",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: 3,
			},
			{ role: "user", content: "continue", timestamp: 4 },
		],
	};
}

function buildInput(model: Model<"openai-responses">): ResponseInput {
	return buildResponsesInput({
		model,
		context: imageToolTurn(model),
		strictResponsesPairing: true,
		supportsImageDetailOriginal: false,
	});
}

describe("Responses tool-result images", () => {
	it("carries images inside the function_call_output instead of a synthetic user message", () => {
		const items = buildInput(responsesModel(["text", "image"]));

		expect(items.filter(item => item.type === "function_call_output")).toEqual([
			{
				type: "function_call_output",
				call_id: "call_read_1",
				output: [
					{ type: "input_text", text: "first" },
					{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" },
				],
			},
			{ type: "function_call_output", call_id: "call_bash_2", output: "done" },
		]);
		expect(items.filter(item => "role" in item && item.role === "user")).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "continue" }] },
		]);
	});

	it("keeps a text-only model's tool output a plain string with no image parts", () => {
		const items = buildInput(responsesModel(["text"]));
		const output = items.find(item => item.type === "function_call_output" && item.call_id === "call_read_1");

		expect(output?.type === "function_call_output" && typeof output.output).toBe("string");
		expect(JSON.stringify(items)).not.toContain("input_image");
	});

	it("escapes Harmony control tokens inside multimodal replayed tool outputs", () => {
		const image = { type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" } as const;
		const [item] = escapeReplayedControlTokens([
			{ type: "function_call_output", call_id: "call_1", output: [{ type: "input_text", text: "<|end|>" }, image] },
		]);

		expect(item).toEqual({
			type: "function_call_output",
			call_id: "call_1",
			output: [{ type: "input_text", text: "<\\|end\\|>" }, image],
		});
	});
});
