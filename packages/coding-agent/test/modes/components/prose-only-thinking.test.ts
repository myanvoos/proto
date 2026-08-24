import { describe, expect, it } from "bun:test";
import { formatThinkingForDisplay, hasDisplayableThinking } from "@oh-my-pi/pi-coding-agent/utils/thinking-display";

describe("formatThinkingForDisplay", () => {
	it("should not format if proseOnly is false", () => {
		const text = "Let me rewrite readString:\n```go\nfunc foo() {}\n```";
		expect(formatThinkingForDisplay(text, false)).toBe(text);
	});

	it("should replace fully enclosed code blocks with a counted marker", () => {
		const text = "Let me rewrite readString:\n```go\nfunc foo() {}\n```\nAnd then test it.";
		expect(formatThinkingForDisplay(text, true)).toBe(
			"Let me rewrite readString:... (1 line of code)\nAnd then test it.",
		);
	});

	it("should replace unclosed code blocks with a counted marker", () => {
		const text =
			"Let me rewrite readString and the dq handling.\n```go\n  func (l *Lexer) readString(pos Pos) (string, error) {\n     l.advance() // opening '\n     var b strings.Builder\n     for {";
		expect(formatThinkingForDisplay(text, true)).toBe(
			"Let me rewrite readString and the dq handling... (4 lines of code)",
		);
	});

	it("should preserve trailing one- and two-character fence prefixes as prose", () => {
		expect(formatThinkingForDisplay("Writing bla.\n`", true)).toBe("Writing bla.\n`");
		expect(formatThinkingForDisplay("Writing bla.\n``", true)).toBe("Writing bla.\n``");
		expect(formatThinkingForDisplay("Writing bla.\n```", true)).toBe("Writing bla...");
	});

	it("should preserve inline code in prose", () => {
		expect(formatThinkingForDisplay("Use `readString` here", true)).toBe("Use `readString` here");
	});

	it("should handle tilde code blocks", () => {
		const text = "Use tilde:\n~~~\ncode inside\n~~~\nprose after";
		expect(formatThinkingForDisplay(text, true)).toBe("Use tilde:... (1 line of code)\nprose after");
	});

	it("should return exactly the counted marker for pure-code blocks while remaining displayable", () => {
		const text = "```js\nconst x = 1;\n```";
		const formatted = formatThinkingForDisplay(text, true);
		expect(formatted).toBe("... (1 line of code)");
		expect(hasDisplayableThinking(text, formatted)).toBe(true);
	});

	it("uses the singular form for one hidden line and plural otherwise", () => {
		expect(formatThinkingForDisplay("A:\n```\nx\n```", true)).toBe("A:... (1 line of code)");
		expect(formatThinkingForDisplay("A:\n```\nx\ny\n```", true)).toBe("A:... (2 lines of code)");
	});

	it("merges fences separated only by blank lines onto one accumulating marker", () => {
		const text = "Start.\n```\na\n```\n\n```\nb\nc\n```";
		const formatted = formatThinkingForDisplay(text, true);
		expect(formatted).toBe("Start... (3 lines of code)\n");
	});

	it("keeps an open fence counting across streamed ticks deterministically", () => {
		const tick1 = "Reasoning so far:\n```js\nconst a = 1;";
		expect(formatThinkingForDisplay(tick1, true)).toBe("Reasoning so far:... (1 line of code)");
		const tick2 = `${tick1}\nconst b = 2;`;
		expect(formatThinkingForDisplay(tick2, true)).toBe("Reasoning so far:... (2 lines of code)");
	});
});
