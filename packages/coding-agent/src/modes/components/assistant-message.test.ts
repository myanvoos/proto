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

// TranscriptContainer turns this count into the live-region boundary: rows below
// it commit to native scrollback with their final bytes, rows above it are still
// moving. A reasoning reply renders a constant "Thinking" heading ahead of its
// markdown, and treating that heading as unsettled reported 0 for the whole
// stream -- so the entire reply was committed as provisional snapshots that the
// renderer then had to re-append once it settled.
test("a streaming reply settles its prefix while a thinking block precedes the text", () => {
	const body = Array.from(
		{ length: 8 },
		(_value, index) => `Paragraph ${index} runs long enough to wrap over several rows in a narrow pane.`,
	).join("\n\n");
	const streamed = (thinking: string | undefined): number[] => {
		const reply = new AssistantMessageComponent(undefined, false);
		const settled: number[] = [];
		for (let end = 80; end <= body.length; end += 80) {
			const content: AssistantMessage["content"] = [];
			if (thinking !== undefined) content.push({ type: "thinking", thinking });
			content.push({ type: "text", text: body.slice(0, end) });
			reply.updateContent({ ...message, content }, { transient: true });
			reply.render(55);
			settled.push(reply.getTranscriptBlockSettledRows());
		}
		return settled;
	};

	const withThinking = streamed("reasoning about the answer");
	const withoutThinking = streamed(undefined);
	expect(withThinking[withThinking.length - 1]).toBeGreaterThan(0);
	// Non-decreasing: a settled row that un-settles is already in scrollback.
	for (let i = 1; i < withThinking.length; i++) {
		expect(withThinking[i]!).toBeGreaterThanOrEqual(withThinking[i - 1]!);
	}
	// The heading adds rows to the settled prefix; it never truncates it.
	expect(withThinking[withThinking.length - 1]).toBeGreaterThan(withoutThinking[withoutThinking.length - 1]!);
});
