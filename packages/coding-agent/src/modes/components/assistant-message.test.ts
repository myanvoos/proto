import { expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { initThemeSync } from "../theme/theme";
import { AssistantMessageComponent } from "./assistant-message";
import { TranscriptContainer } from "./transcript-container";

initThemeSync();

const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "answer" }],
	api: "openai-completions",
	provider: "test",
	model: "test-model",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
};

const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" } as const;

test("notifies the transcript when a finalized assistant image is hidden", () => {
	const assistant = new AssistantMessageComponent(message);
	assistant.setToolResultImages("call-1", [image]);
	const transcript = new TranscriptContainer();
	transcript.addChild(assistant);
	expect(transcript.render(80).join("\n")).toContain("[Image: image/png]");

	assistant.setToolResultImagesVisible(false);
	const updated = transcript.render(80).join("\n");
	expect(updated).not.toContain("[Image: image/png]");
});

test("notifies the transcript when a tool image arrives after final compaction", () => {
	const assistant = new AssistantMessageComponent(message);
	const transcript = new TranscriptContainer();
	transcript.addChild(assistant);
	expect(transcript.render(80).join("\n")).not.toContain("[Image: image/png]");

	assistant.setToolResultImages("call-1", [image]);
	const updated = transcript.render(80).join("\n");
	expect(updated).toContain("[Image: image/png]");
});

test("sanitizes assistant error content before collapsed and expanded rendering", () => {
	for (const expanded of [false, true]) {
		const errorMessage = "ERR\x07BELL\x01CTRL\x1b[31mRED\x1b[0m\tTAB";
		const assistantMessage: AssistantMessage = {
			...message,
			stopReason: "error",
			errorMessage,
		};
		const assistant = new AssistantMessageComponent(assistantMessage);
		assistant.setExpanded(expanded);
		const output = assistant.render(100).join("\n");
		expect(output).not.toContain("\x07");
		expect(output).not.toContain("\x01");
		expect(output).not.toContain("\x1b[31m");
		expect(output).not.toContain("\t");
		expect(output).toContain("ERRBELLCTRLRED");
	}
});
