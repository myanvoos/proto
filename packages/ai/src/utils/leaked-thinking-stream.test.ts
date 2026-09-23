import { expect, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "../types";
import {
	getStreamingPartialJson,
	isCursorExecResolved,
	kCursorExecResolved,
	setStreamingPartialJson,
} from "./block-symbols";
import { AssistantMessageEventStream } from "./event-stream";
import { wrapLeakedThinkingStream } from "./leaked-thinking-stream";

function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "fixture",
		model: "fixture",
		content,
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

async function collect(
	events: AssistantMessageEvent[],
): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
	const inner = new AssistantMessageEventStream();
	const wrapped = wrapLeakedThinkingStream(inner);
	for (const event of events) inner.push(event);
	const projected: AssistantMessageEvent[] = [];
	for await (const event of wrapped) projected.push(structuredClone(event));
	return { events: projected, result: await wrapped.result() };
}

for (const [label, initial, final] of [
	["shorter", "OLDONE and stale continuation", "FINALONE"],
	["same length", "OLDONE", "NEWONE"],
	["longer but different", "OLD", "authoritative replacement"],
	["empty", "OLDONE", ""],
	["append-only", "Hello", "Hello world"],
] as const) {
	test.each([true, false])(`authoritative ${label} final text replaces the draft (text_end=%s)`, async emitEnd => {
		const partial = message([{ type: "text", text: initial, textSignature: "draft-signature" }]);
		const finished = message([{ type: "text", text: final, textSignature: "final-signature" }]);
		finished.usage.output = 99;
		finished.timestamp = 123;
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: message([]) },
			{ type: "text_delta", contentIndex: 0, delta: initial, partial },
		];
		if (emitEnd) events.push({ type: "text_end", contentIndex: 0, content: final, partial: finished });
		events.push({ type: "done", reason: "stop", message: finished });
		const projected = await collect(events);
		expect(projected.result).toEqual(finished);
		if (emitEnd || final !== "") {
			const end = projected.events.findLast(event => event.type === "text_end");
			expect(end?.type === "text_end" ? end.content : undefined).toBe(final);
		}
	});
}

test("replacement re-heals thinking markup and remaps an in-flight tool without losing metadata", async () => {
	const draft = "<think>stale reasoning</think>stale answer";
	const replacement = "visible <think>new reasoning</think>final";
	const tool: ToolCall = {
		type: "toolCall",
		id: "call-one",
		name: "read",
		arguments: {},
		thoughtSignature: "tool-signature",
	};
	setStreamingPartialJson(tool, '{"path":');
	const finishedTool: ToolCall & { [kCursorExecResolved]: true } = {
		...tool,
		arguments: { path: "file.ts" },
		intent: "final intent",
		[kCursorExecResolved]: true,
	};
	setStreamingPartialJson(finishedTool, undefined);
	const draftPartial = message([{ type: "text", text: draft }, tool]);
	const corrected = message([{ type: "text", text: replacement, textSignature: "final-text-signature" }, tool]);
	const finished = message([
		{ type: "text", text: replacement, textSignature: "final-text-signature" },
		finishedTool,
		{ type: "thinking", thinking: "native", thinkingSignature: "native-signature", itemId: "native-item" },
	]);
	const { result, events } = await collect([
		{ type: "start", partial: message([]) },
		{ type: "text_delta", contentIndex: 0, delta: draft, partial: draftPartial },
		{ type: "toolcall_start", contentIndex: 1, partial: draftPartial },
		{ type: "text_end", contentIndex: 0, content: replacement, partial: corrected },
		{
			type: "toolcall_delta",
			contentIndex: 1,
			delta: '"file.ts"}',
			partial: message([corrected.content[0], finishedTool]),
		},
		{ type: "toolcall_end", contentIndex: 1, toolCall: finishedTool, partial: finished },
		{ type: "done", reason: "stop", message: finished },
	]);
	expect(result.content).toEqual([
		{ type: "text", text: "visible ", textSignature: "final-text-signature" },
		{ type: "thinking", thinking: "new reasoning" },
		{ type: "text", text: "final", textSignature: "final-text-signature" },
		finishedTool,
		finished.content[2],
	]);
	const delta = events.find(event => event.type === "toolcall_delta");
	expect(delta?.contentIndex).toBe(3);
	if (delta?.type === "toolcall_delta")
		expect(delta.partial.content[delta.contentIndex]).toMatchObject({ type: "toolCall", id: "call-one" });
	const resultTool = result.content.find(block => block.type === "toolCall");
	expect(getStreamingPartialJson(resultTool)).toBeUndefined();
	expect(isCursorExecResolved(resultTool)).toBe(true);
});

test("error finals reconcile authoritative text too", async () => {
	const partial = message([{ type: "text", text: "stale" }]);
	const failed = {
		...message([{ type: "text", text: "final partial" }]),
		stopReason: "error" as const,
		errorMessage: "fixture failure",
	};
	const { result } = await collect([
		{ type: "text_delta", contentIndex: 0, delta: "stale", partial },
		{ type: "error", reason: "error", error: failed },
	]);
	expect(result).toEqual(failed);
});

test("a final append after text_end is re-healed as one authoritative block", async () => {
	const partial = message([{ type: "text", text: "Hello" }]);
	const finished = message([{ type: "text", text: "Hello world" }]);
	const { result } = await collect([
		{ type: "text_delta", contentIndex: 0, delta: "Hello", partial },
		{ type: "text_end", contentIndex: 0, content: "Hello", partial },
		{ type: "done", reason: "stop", message: finished },
	]);
	expect(result).toEqual(finished);
});

test("empty thinking markup never leaks into authoritative content", async () => {
	const finished = message([{ type: "text", text: "<think></think>" }]);
	const { result } = await collect([{ type: "done", reason: "stop", message: finished }]);
	expect(result.content).toEqual([{ type: "text", text: "" }]);
});

test("ordinary chunked append streaming keeps text and thinking deltas", async () => {
	const chunks = ["Hello ", "<thi", "nk>reason", "ing</think>", "world"];
	let raw = "";
	const events: AssistantMessageEvent[] = chunks.map(delta => {
		raw += delta;
		return { type: "text_delta", contentIndex: 0, delta, partial: message([{ type: "text", text: raw }]) };
	});
	events.push({ type: "done", reason: "stop", message: message([{ type: "text", text: raw }]) });
	const projected = await collect(events);
	expect(projected.result.content).toEqual([
		{ type: "text", text: "Hello " },
		{ type: "thinking", thinking: "reasoning" },
		{ type: "text", text: "world" },
	]);
	expect(projected.events.flatMap(event => (event.type === "text_delta" ? [event.delta] : [])).join("")).toBe(
		"Hello world",
	);
	expect(projected.events.flatMap(event => (event.type === "thinking_delta" ? [event.delta] : [])).join("")).toBe(
		"reasoning",
	);
});

test("the final snapshot drops removed draft blocks and preserves unsigned thinking metadata", async () => {
	const draft = message([{ type: "text", text: "removed" }]);
	const finished = message([{ type: "thinking", thinking: "authoritative", itemId: "native-item" }]);
	const { result } = await collect([
		{ type: "text_delta", contentIndex: 0, delta: "removed", partial: draft },
		{ type: "done", reason: "stop", message: finished },
	]);
	expect(result).toEqual(finished);
});

function streamText(chunks: readonly string[], final = chunks.join("")): AssistantMessageEvent[] {
	let raw = "";
	const events: AssistantMessageEvent[] = chunks.map(delta => {
		raw += delta;
		return { type: "text_delta", contentIndex: 0, delta, partial: message([{ type: "text", text: raw }]) };
	});
	events.push({ type: "done", reason: "stop", message: message([{ type: "text", text: final }]) });
	return events;
}

test("a template-prefilled <think> (only the close streamed) reclassifies the leading text as thinking", async () => {
	const projected = await collect(streamText(["Let me ", "reason</th", "ink>\n\nAnswer."]));
	expect(projected.result.content).toEqual([
		{ type: "thinking", thinking: "Let me reason" },
		{ type: "text", text: "\n\nAnswer." },
	]);
	// Event replayers see the streamed text block at index 0 replaced by a closed thinking block.
	const replaced = projected.events.findIndex(event => event.type === "thinking_start" && event.contentIndex === 0);
	expect(projected.events.slice(replaced).map(event => event.type)).toEqual([
		"thinking_start",
		"thinking_delta",
		"thinking_end",
		"text_start",
		"text_delta",
		"text_end",
		"done",
	]);
});

test("a stray </think> after other content or blank text is dropped, never shown", async () => {
	const afterThinking = await collect(streamText(["<think>r</think>visible</think> tail"]));
	expect(afterThinking.result.content).toEqual([
		{ type: "thinking", thinking: "r" },
		{ type: "text", text: "visible tail" },
	]);
	const blank = await collect(streamText(["\n</think>Hi"]));
	expect(blank.result.content).toEqual([{ type: "text", text: "\nHi" }]);
});

test("an authoritative replacement with only </think> reclassifies its leading text as thinking", async () => {
	const { result } = await collect(streamText(["draft"], "reasoning</think>answer"));
	expect(result.content).toEqual([
		{ type: "thinking", thinking: "reasoning" },
		{ type: "text", text: "answer" },
	]);
});
