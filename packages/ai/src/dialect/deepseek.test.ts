import { expect, test } from "bun:test";
import { DeepSeekInbandScanner } from "./deepseek";

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
