import { expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, Context, Model } from "../types";
import { convertAnthropicMessages } from "./anthropic";
import { convertMessages as googleMessages } from "./google-shared";
import { convertMessages as chatMessages } from "./openai-completions";
import { buildResponsesInput } from "./openai-shared";

function mediaModel<T extends Api>(api: T, input: Model["input"]): Model<T> {
	return buildModel({
		id: "media-test",
		name: "Media test",
		api,
		provider: "test",
		baseUrl: "https://provider.invalid",
		input,
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
		maxTokens: 4000,
	});
}

function mediaTurn(model: Model): Context {
	return {
		messages: [
			{
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [
					{ type: "toolCall", id: "audio_call", name: "read", arguments: { path: "recording.wav" } },
					{ type: "toolCall", id: "video_call", name: "read", arguments: { path: "clip.mp4" } },
				],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "audio_call",
				toolName: "read",
				isError: false,
				timestamp: 2,
				content: [{ type: "audio", mimeType: "audio/wav", data: "QVVESU8=" }],
			},
			{
				role: "toolResult",
				toolCallId: "video_call",
				toolName: "read",
				isError: false,
				timestamp: 3,
				content: [{ type: "video", mimeType: "video/mp4", data: "VklERU8=" }],
			},
		],
	};
}

test("Google receives native audio and video after the complete function response batch", () => {
	const model = mediaModel("google-generative-ai", ["text", "audio", "video"]);
	const messages = googleMessages(model, mediaTurn(model));
	expect(messages.map(message => message.role)).toEqual(["model", "user", "user"]);
	expect(messages[1]?.parts?.map(part => part.functionResponse?.name)).toEqual(["read", "read"]);
	expect(messages[2]?.parts?.filter(part => part.inlineData)).toEqual([
		{ inlineData: { mimeType: "audio/wav", data: "QVVESU8=" } },
		{ inlineData: { mimeType: "video/mp4", data: "VklERU8=" } },
	]);
});

test("switching to a text-only Google model replaces replayed tool media with omission notices", () => {
	const model = mediaModel("google-generative-ai", ["text"]);
	const messages = googleMessages(model, mediaTurn(model));
	const parts = messages.flatMap(message => message.parts ?? []);
	expect(parts.filter(part => part.inlineData)).toEqual([]);
	expect(parts.map(part => part.text ?? "").join("\n")).toContain("audio omitted");
	expect(parts.map(part => part.text ?? "").join("\n")).toContain("video omitted");
	expect(parts.filter(part => part.functionResponse)).toHaveLength(2);
});

test("Chat Completions receives native audio and video without breaking tool result adjacency", () => {
	const model = mediaModel("openai-completions", ["text", "audio", "video"]);
	const messages = chatMessages(model, mediaTurn(model), model.compat);
	expect(messages.map(message => message.role)).toEqual(["assistant", "tool", "tool", "user"]);
	const media = messages.at(-1)?.content;
	expect(
		Array.isArray(media) && media.filter(part => part.type === "input_audio" || part.type === "video_url"),
	).toEqual([
		{ type: "input_audio", input_audio: { data: "QVVESU8=", format: "wav" } },
		{ type: "video_url", video_url: { url: "data:video/mp4;base64,VklERU8=" } },
	]);
});

test("Responses reports unsupported audio and video rather than silently dropping tool media", () => {
	const model = mediaModel("openai-responses", ["text", "audio", "video"]);
	const messages = buildResponsesInput({
		model,
		context: mediaTurn(model),
		strictResponsesPairing: true,
		supportsImageDetailOriginal: false,
	});
	expect(messages.filter(message => message.type === "function_call_output")).toHaveLength(2);
	const wire = JSON.stringify(messages);
	expect(wire).toContain("audio omitted");
	expect(wire).toContain("video omitted");
	expect(wire).not.toContain("QVVESU8=");
	expect(wire).not.toContain("VklERU8=");
});

test("Anthropic keeps both tool results and notices when its API cannot accept audio or video", () => {
	const model = mediaModel("anthropic-messages", ["text", "audio", "video"]);
	const messages = convertAnthropicMessages(mediaTurn(model).messages, model, false);
	const wire = JSON.stringify(messages);
	expect(wire).toContain('"tool_use_id":"audio_call"');
	expect(wire).toContain('"tool_use_id":"video_call"');
	expect(wire).toContain("audio omitted");
	expect(wire).toContain("video omitted");
	expect(wire).not.toContain("QVVESU8=");
	expect(wire).not.toContain("VklERU8=");
});
