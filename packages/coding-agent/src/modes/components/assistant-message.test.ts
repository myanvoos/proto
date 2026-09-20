import { expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { initThemeSync, theme } from "../theme/theme";
import { AssistantMessageComponent } from "./assistant-message";
import { TranscriptContainer } from "./transcript-container";

initThemeSync();

function strip(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

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

// Esc aborts the turn mid-stream. The red "Interrupted by user" line was dropped as
// redundant, which left no trace at all: the text just stopped mid-word. A user
// interrupt now renders a dim one-line marker; every other abort keeps its error label.
test("an Esc-interrupted reply renders a dim marker instead of the error-styled interrupt line", () => {
	const interrupted: AssistantMessage = { ...message, stopReason: "aborted", errorMessage: USER_INTERRUPT_LABEL };
	const lines = new AssistantMessageComponent(interrupted).render(80);
	const markerLine = lines.find(line => strip(line).includes("Interrupted"));
	expect(markerLine).toBeDefined();
	expect(strip(markerLine!)).toContain(`${theme.symbol("status.aborted")} Interrupted`);
	expect(markerLine).toContain(theme.getFgAnsi("dim"));
	expect(markerLine).not.toContain(theme.getFgAnsi("error"));
	const plain = lines.map(strip).join("\n");
	expect(plain).not.toContain(USER_INTERRUPT_LABEL);
	expect(plain).not.toContain("Operation aborted");
});

test("a non-user abort keeps the error-styled abort label", () => {
	const aborted: AssistantMessage = { ...message, stopReason: "aborted" };
	const lines = new AssistantMessageComponent(aborted).render(80);
	const abortLine = lines.find(line => strip(line).includes("Operation aborted"));
	expect(abortLine).toBeDefined();
	expect(abortLine).toContain(theme.getFgAnsi("error"));
	expect(lines.map(strip).join("\n")).not.toContain("Interrupted");
});

// The streaming component updates text in place through a fast path keyed on content
// shape; the abort only changes stopReason, so the marker must still force a rebuild.
test("a streamed reply interrupted mid-turn shows the marker after its final update", () => {
	const reply = new AssistantMessageComponent(undefined, false);
	reply.updateContent({ ...message, content: [{ type: "text", text: "partial ans" }] }, { transient: true });
	reply.render(80);
	reply.updateContent({
		...message,
		content: [{ type: "text", text: "partial answ" }],
		stopReason: "aborted",
		errorMessage: USER_INTERRUPT_LABEL,
	});
	const plain = reply.render(80).map(strip).join("\n");
	expect(plain).toContain("partial answ");
	expect(plain).toContain(`${theme.symbol("status.aborted")} Interrupted`);
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

const thinkingMessage: AssistantMessage = {
	...message,
	content: [
		{ type: "thinking", thinking: "deliberating\n```ts\nconst hidden = 1;\n```\ndone" },
		{ type: "text", text: "answer" },
	],
};

// Children are materialized once from the message, so a setter that only flipped a field and
// notified the transcript left the old content on screen: the user toggled "hide thinking" (or
// switched to prose-only) and the transcript kept showing the reasoning until something else
// happened to invalidate the component.
test("hiding thinking on a finalized transcript block takes effect on the next render", () => {
	const assistant = new AssistantMessageComponent(thinkingMessage);
	expect(Bun.stripANSI(assistant.render(80).join("\n"))).toContain("deliberating");

	assistant.setHideThinkingBlock(true);

	expect(Bun.stripANSI(assistant.render(80).join("\n"))).not.toContain("deliberating");
	assistant.dispose();
});

test("switching a finalized transcript block to prose-only thinking drops fenced code on the next render", () => {
	const assistant = new AssistantMessageComponent(thinkingMessage, false, undefined, undefined, undefined, false);
	expect(Bun.stripANSI(assistant.render(80).join("\n"))).toContain("const hidden");

	assistant.setProseOnlyThinking(true);

	expect(Bun.stripANSI(assistant.render(80).join("\n"))).not.toContain("const hidden");
	assistant.dispose();
});
