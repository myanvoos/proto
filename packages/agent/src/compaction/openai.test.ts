import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import { buildOpenAiNativeHistory, shouldUseOpenAiRemoteCompaction } from "./openai";

const USAGE = {
	input: 0,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(): Model {
	return {
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 200_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			supportsImageDetailOriginal: false,
			strictResponsesPairing: true,
		},
	} as Model;
}

function assistantWithCall(id: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: "src/file.ts" } }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage: USAGE,
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function messageItems(history: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	return history.filter(item => item.type === "message");
}

describe("OpenAI native compaction history", () => {
	test("repairs an orphaned native call carried over from an interrupted turn", () => {
		const history = buildOpenAiNativeHistory([], model(), [
			{ type: "function_call", call_id: "call-1", name: "read", arguments: "{}" },
		]);
		const calls = history.filter(item => item.type === "function_call");
		const outputs = history.filter(item => item.type === "function_call_output");

		expect(calls).toHaveLength(1);
		expect(outputs).toHaveLength(1);
		expect(outputs[0]).toMatchObject({ call_id: "call-1" });
		expect(typeof outputs[0]?.output).toBe("string");

		const transformedHistory = buildOpenAiNativeHistory([assistantWithCall("call-2")], model());
		expect(transformedHistory.filter(item => item.type === "function_call_output")).toHaveLength(1);
	});

	test("replays provider files and URLs instead of replacing them with data URIs", () => {
		const user: Message = {
			role: "user",
			content: [
				{
					type: "image",
					data: "WRONG_PROVIDER_FILE_DATA",
					mimeType: "image/png",
					providerFile: { provider: "openai", id: "file-123" },
				},
				{
					type: "image",
					data: "WRONG_URL_DATA",
					mimeType: "image/jpeg",
					url: "https://images.example.test/capture.jpg",
				},
			],
			timestamp: 1,
		};
		const history = buildOpenAiNativeHistory([user], model());
		const message = messageItems(history).find(item => item.role === "user");
		const content = message?.content;
		if (!Array.isArray(content)) throw new Error("expected native user content");

		expect(content).toEqual([
			{ type: "input_image", detail: "auto", file_id: "file-123" },
			{ type: "input_image", detail: "auto", image_url: "https://images.example.test/capture.jpg" },
		]);
	});
});

describe("OpenAI V1 compact endpoint selection", () => {
	test("Codex takes the V1 /responses/compact path only with an explicitly configured endpoint", () => {
		const codex = { ...model(), provider: "openai-codex", api: "openai-codex-responses" } as Model;
		expect(
			shouldUseOpenAiRemoteCompaction({ ...codex, remoteCompaction: { enabled: true, v2StreamingEnabled: true } }),
		).toBe(false);
		expect(
			shouldUseOpenAiRemoteCompaction({
				...codex,
				remoteCompaction: { endpoint: "https://compact.example/v1/responses/compact" },
			}),
		).toBe(true);
	});
});
