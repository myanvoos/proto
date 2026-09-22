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

function expectStablePrefix(reply: AssistantMessageComponent, width: number): string[] {
	const stable = [...reply.renderTranscriptStableRows(reply.getTranscriptStableRows().length, width)];
	const full = reply.render(width);
	let start = 0;
	let end = full.length;
	while (start < end && full[start] === "") start++;
	while (end > start && full[end - 1] === "") end--;
	expect(full.slice(start, start + stable.length)).toEqual(stable);
	return stable;
}

test("publishes immutable thinking and answer prefixes through finalization", () => {
	const reply = new AssistantMessageComponent(undefined, false);
	const firstThinking = "First complete reasoning paragraph.\n\nSecond reasoning paragraph is still growing";
	reply.updateContent({ ...message, content: [{ type: "thinking", thinking: firstThinking }] }, { transient: true });
	reply.render(48);

	const firstRows = reply.getTranscriptStableRows();
	expect(firstRows.length).toBeGreaterThan(0);
	const firstKeys = firstRows.map(row => row.key);
	const firstStable = expectStablePrefix(reply, 48);
	expect(Bun.stripANSI(firstStable.join("\n"))).toContain("Thinking");
	expect(Bun.stripANSI(firstStable.join("\n"))).toContain("First complete reasoning paragraph.");
	expect(Bun.stripANSI(firstStable.join("\n"))).not.toContain("still growing");

	const completedThinking = `${firstThinking} to completion.\n\nThird reasoning paragraph remains open`;
	reply.updateContent(
		{
			...message,
			content: [
				{ type: "thinking", thinking: completedThinking },
				{ type: "text", text: "A complete answer paragraph.\n\nThe answer remains open" },
			],
		},
		{ transient: true },
	);
	reply.render(48);

	const extendedRows = reply.getTranscriptStableRows();
	expect(extendedRows.slice(0, firstKeys.length).map(row => row.key)).toEqual(firstKeys);
	expect(extendedRows.length).toBeGreaterThan(firstRows.length);
	const extendedStable = expectStablePrefix(reply, 48);
	expect(extendedStable.slice(0, firstStable.length)).toEqual(firstStable);
	const plainExtended = Bun.stripANSI(extendedStable.join("\n"));
	expect(plainExtended).toContain("Third reasoning paragraph remains open");
	expect(plainExtended).toContain("A complete answer paragraph.");
	expect(plainExtended).not.toContain("The answer remains open");

	const identitiesBeforeFinal = reply.getTranscriptStableRows().map(row => row.key);
	const stableBeforeFinal = reply.renderTranscriptStableRows(identitiesBeforeFinal.length, 48);
	reply.updateContent({
		...message,
		content: [
			{ type: "thinking", thinking: completedThinking },
			{ type: "text", text: "A complete answer paragraph.\n\nThe answer is finalized." },
		],
	});
	reply.markTranscriptBlockFinalized();
	reply.render(48);
	expect(reply.getTranscriptStableRows().map(row => row.key)).toEqual(identitiesBeforeFinal);
	expect(reply.renderTranscriptStableRows(identitiesBeforeFinal.length, 48)).toEqual(stableBeforeFinal);
});

test("renders one semantic snapshot as a full-render prefix at different widths", () => {
	const reply = new AssistantMessageComponent(undefined, false);
	const text = `${"A complete paragraph wraps consistently across widths. ".repeat(4)}\n\nMutable tail`;
	reply.updateContent({ ...message, content: [{ type: "text", text }] }, { transient: true });
	reply.render(52);
	expect(reply.getTranscriptStableRows().length).toBeGreaterThan(0);

	const narrow = expectStablePrefix(reply, 27);
	const wide = expectStablePrefix(reply, 76);
	expect(narrow.length).toBeGreaterThan(wide.length);
});

test("publishes completed table, code, and list blocks without layout drift", () => {
	for (const block of [
		"| key | value |\n| --- | --- |\n| one | two |",
		"```ts\nconst value = 1;\n```",
		"- first item\n- second item",
	]) {
		const reply = new AssistantMessageComponent(undefined, false);
		reply.updateContent(
			{ ...message, content: [{ type: "text", text: `${block}\n\nmutable suffix` }] },
			{ transient: true },
		);
		reply.render(46);
		expect(reply.getTranscriptStableRows().length).toBeGreaterThan(0);
		expectStablePrefix(reply, 31);
		expectStablePrefix(reply, 67);
	}
});

test("keeps open Markdown suffixes out of history and can reset publication", () => {
	const reply = new AssistantMessageComponent(undefined, false);
	const text = "Settled prose.\n\n```ts\nconst unfinished = true;\n\nmore open code";
	reply.updateContent({ ...message, content: [{ type: "text", text }] }, { transient: true });
	reply.render(50);

	const stable = expectStablePrefix(reply, 50);
	const plain = Bun.stripANSI(stable.join("\n"));
	expect(plain).toContain("Settled prose.");
	expect(plain).not.toContain("unfinished");
	expect(plain).not.toContain("open code");

	reply.resetTranscriptStableRows();
	expect(reply.getTranscriptStableRows()).toEqual([]);
	expect(reply.renderTranscriptStableRows(10, 50)).toEqual([]);
	reply.render(50);
	expect(reply.getTranscriptStableRows().length).toBeGreaterThan(0);
	expectStablePrefix(reply, 50);
});

test("stable publication stays monotonic through a large stream", () => {
	const reply = new AssistantMessageComponent(undefined, false);
	const body = Array.from(
		{ length: 80 },
		(_value, index) => `Paragraph ${index} is complete and long enough to wrap in the streaming transcript.`,
	).join("\n\n");
	let previousKeys: string[] = [];
	let previousRender: string[] = [];
	for (let end = 180; end < body.length; end += 180) {
		reply.updateContent({ ...message, content: [{ type: "text", text: body.slice(0, end) }] }, { transient: true });
		reply.render(42);
		const keys = reply.getTranscriptStableRows().map(row => row.key);
		expect(keys.slice(0, previousKeys.length)).toEqual(previousKeys);
		const rendered = expectStablePrefix(reply, 42);
		expect(rendered.slice(0, previousRender.length)).toEqual(previousRender);
		previousKeys = keys;
		previousRender = rendered;
	}
	expect(previousKeys.length).toBeGreaterThan(10);
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
