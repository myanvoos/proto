import { describe, expect, test } from "bun:test";
import type { ImageContent, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { Tokenizer } from "../tokenizer";
import type { AgentMessage } from "../types";
import type { SessionMessageEntry } from "./entries";
import { applyShakeRegion, applyShakeRegions, collectShakeRegions, type ShakeConfig, type ShakeRegion } from "./shake";

const SHAKE_ALL = {
	protectTokens: 0,
	minSavings: 0,
	protectedTools: [],
	fenceMinTokens: 0,
} satisfies ShakeConfig;

function messageEntry(message: AgentMessage): SessionMessageEntry {
	return {
		type: "message",
		id: "entry",
		parentId: null,
		timestamp: "2026-09-19T00:00:00.000Z",
		message,
	};
}

function toolResult(content: ToolResultMessage["content"]): SessionMessageEntry {
	return messageEntry({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "capture",
		content,
		isError: false,
		timestamp: 1,
	});
}

function image(data = "SECRET_IMAGE_DATA"): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function collect(entry: SessionMessageEntry): ShakeRegion[] {
	return collectShakeRegions([entry], new Tokenizer(), SHAKE_ALL);
}

function applyPlaceholders(regions: ShakeRegion[]): void {
	applyShakeRegions(regions.map((region, index) => ({ region, replacement: `[shaken ${index + 1}]` })));
}

function contentTypes(entry: SessionMessageEntry): string[] {
	const { message } = entry;
	if (message.role !== "toolResult") throw new Error("expected tool result");
	return message.content.map(block => block.type);
}

describe("content-preserving shake", () => {
	test("does not delete an image block when shaking a mixed tool result", () => {
		const preservedImage = image();
		const entry = toolResult([{ type: "text", text: "caption" }, preservedImage]);

		const regions = collect(entry);
		expect(regions.map(region => region.originalText)).toEqual(["caption"]);
		applyPlaceholders(regions);

		expect(contentTypes(entry)).toEqual(["text", "image"]);
		if (entry.message.role !== "toolResult") throw new Error("expected tool result");
		expect(entry.message.content[1]).toBe(preservedImage);
		expect(JSON.stringify(entry.message.content)).toContain("SECRET_IMAGE_DATA");
	});

	test("does not reorder text-image-text blocks while shaking multiple text regions", () => {
		const preservedImage = image();
		const entry = toolResult([{ type: "text", text: "before" }, preservedImage, { type: "text", text: "after" }]);

		applyPlaceholders(collect(entry));

		expect(contentTypes(entry)).toEqual(["text", "image", "text"]);
		if (entry.message.role !== "toolResult") throw new Error("expected tool result");
		expect(entry.message.content).toEqual([
			{ type: "text", text: "[shaken 1]" },
			preservedImage,
			{ type: "text", text: "[shaken 2]" },
		]);
	});

	test("does not stop saving tokens for a text-only tool result", () => {
		const tokenizer = new Tokenizer();
		const entry = toolResult([{ type: "text", text: "large result ".repeat(2_000) }]);
		const before = tokenizer.countMessage(entry.message);
		const regions = collectShakeRegions([entry], tokenizer, SHAKE_ALL);

		expect(regions).toHaveLength(1);
		applyShakeRegion(regions[0], "[shaken]");

		const after = tokenizer.countMessage(entry.message);
		expect(after).toBeLessThan(before);
		expect(regions[0].tokens).toBeGreaterThan(tokenizer.countTokens("[shaken]"));
	});

	test("does not corrupt captured text when shake artifact regions are restored", () => {
		const preservedImage = image();
		const originalContent: ToolResultMessage["content"] = [
			{ type: "text", text: "caption before" },
			preservedImage,
			{ type: "text", text: "caption after" },
		];
		const entry = toolResult(originalContent.map(block => ({ ...block })));
		const regions = collect(entry);
		const artifactText = regions.map(region => region.originalText);

		applyPlaceholders(regions);
		applyShakeRegions(regions.map((region, index) => ({ region, replacement: artifactText[index] })));

		if (entry.message.role !== "toolResult") throw new Error("expected tool result");
		expect(entry.message.content).toEqual(originalContent);
	});

	test("does not rebuild or reorder media blocks when splitting fenced text", () => {
		const message: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "```txt\nsecret\n```" },
				image(),
				{ type: "audio", data: "AUDIO_DATA", mimeType: "audio/wav" },
				{ type: "video", data: "VIDEO_DATA", mimeType: "video/mp4" },
				{ type: "text", text: "outside fence" },
			],
			timestamp: 1,
		};
		const entry = messageEntry(message);
		const regions = collect(entry);

		expect(regions).toHaveLength(1);
		applyShakeRegion(regions[0], "[shaken fence]");

		if (entry.message.role !== "user" || !Array.isArray(entry.message.content)) {
			throw new Error("expected user content blocks");
		}
		expect(entry.message.content.map(block => block.type)).toEqual(["text", "image", "audio", "video", "text"]);
		expect(entry.message.content[4]).toEqual({ type: "text", text: "outside fence" });
	});
});
