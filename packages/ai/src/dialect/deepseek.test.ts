import { expect, test } from "bun:test";
import { DeepSeekInbandScanner } from "./deepseek";
import { createInbandScanner, getDialectDefinition } from "./factory";
import type { Dialect, InbandScanEvent } from "./types";

function scanChunked(input: string, size: number): { text: string; other: string[] } {
	const scanner = new DeepSeekInbandScanner();
	const events = [];
	for (let i = 0; i < input.length; i += size) events.push(...scanner.feed(input.slice(i, i + size)));
	events.push(...scanner.flush());
	return {
		text: events.flatMap(event => (event.type === "text" ? [event.text] : [])).join(""),
		other: events.flatMap(event => (event.type === "text" ? [] : [event.type])),
	};
}

// Leaked bare DSML closers stored as visible text poison replay until tool calls stop dispatching.
test("orphan DSML invoke/parameter closers are stripped from visible text, keeping the whitespace around them", () => {
	expect(scanChunked("分析文本。\n\n</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>", 1000)).toEqual({
		text: "分析文本。\n\n\n\n",
		other: [],
	});
	expect(scanChunked("text</｜DSML｜parameter> \n  </|DSML|invoke>\n\tmore", 5)).toEqual({
		text: "text \n  \n\tmore",
		other: [],
	});
});

// Canonical and re-spelled delimiters must not eat prose or literal token strings in JSON/code.
test("DeepSeek heals re-spelled calls without treating quoted JSON tokens as closes", () => {
	const input =
		'<｜tool_calls_begin｜><｜tool_call_begin｜>write<｜tool_sep｜>{"text":"<｜tool_calls_end｜>"}<｜tool_call_end｜><｜tool_calls_end｜>done';
	for (const size of [1, 17, input.length]) {
		const scanner = new DeepSeekInbandScanner();
		const events: InbandScanEvent[] = [];
		for (let i = 0; i < input.length; i += size) events.push(...scanner.feed(input.slice(i, i + size)));
		events.push(...scanner.flush());
		expect(events.find(event => event.type === "toolEnd")).toMatchObject({
			name: "write",
			arguments: { text: "<｜tool_calls_end｜>" },
		});
		expect(events.flatMap(event => (event.type === "text" ? [event.text] : [])).join("")).toBe("done");
	}
});

test("DeepSeek keeps prose after stray wrappers and leaves code-quoted token examples visible", () => {
	const quoted = "`<｜tool_calls_begin｜>` is an example";
	expect(scanChunked(quoted, 1).text).toBe(quoted);
	expect(scanChunked("<｜tool_calls_begin｜> prose continues \n<｜tool_calls_end｜>after", 1).text).toBe(
		" prose continuesafter",
	);
});

test("Hermes waits for a closed name before announcing a tool call", () => {
	const scanner = createInbandScanner("hermes");
	expect(scanner.feed('<tool_call>{"name":"sea')).toEqual([]);
	const events = scanner.feed('rch","arguments":{"q":"needle"}}</tool_call>');
	expect(events.filter(event => event.type === "toolStart")).toMatchObject([{ name: "search" }]);
	expect(events.find(event => event.type === "toolEnd")).toMatchObject({ name: "search", arguments: { q: "needle" } });
});

test("long in-band arguments survive many deltas and a split terminator", () => {
	for (const dialect of ["deepseek", "gemini", "hermes", "kimi", "qwen3"] as Dialect[]) {
		const definition = getDialectDefinition(dialect);
		const content = "generated line\n".repeat(1000);
		const text = definition.renderAssistantToolCalls([
			{ type: "toolCall", id: "call-1", name: "write", arguments: { content } },
		]);
		const scanner = definition.createScanner();
		const events: InbandScanEvent[] = [];
		for (let i = 0; i < text.length; i += 11) events.push(...scanner.feed(text.slice(i, i + 11)));
		events.push(...scanner.flush());
		expect(events.find(event => event.type === "toolEnd")).toMatchObject({ name: "write", arguments: { content } });
	}
});
