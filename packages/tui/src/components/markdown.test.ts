import { describe, expect, test } from "bun:test";
import type { SymbolTheme } from "../symbols";
import { getHangulCompatibilityJamoWidth, setHangulCompatibilityJamoWidth } from "../utils";
import { Markdown, type MarkdownTheme } from "./markdown";

const symbols: SymbolTheme = {
	cursor: ">",
	inputCursor: ">",
	boxRound: { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|" },
	boxSharp: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	table: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	quoteBorder: ">",
	hrChar: "-",
	spinnerFrames: ["-"],
};

function identity(text: string): string {
	return text;
}

const theme: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
	symbols,
};

describe("Markdown reference links", () => {
	test("renders prototype-label references as literal text instead of crashing", () => {
		for (const label of ["constructor", "toString", "valueOf", "isPrototypeOf"]) {
			const output = new Markdown(`[x][${label}]`, 0, 0, theme).render(80).join("\n").trimEnd();
			expect(output).toBe(`[x][${label}]`);
			expect(output).not.toContain("\x1b]8;;");
		}
	});

	test("does not turn a __proto__ reference into a hyperlink", () => {
		const output = new Markdown("[x][__proto__]", 0, 0, theme).render(80).join("\n");
		expect(output).toContain("proto");
		expect(output).not.toContain("\x1b]8;;");
	});
});

function renderMarkdown(text: string, transientRenderCache = false): readonly string[] {
	const markdown = new Markdown(text, 1, 0, theme);
	markdown.transientRenderCache = transientRenderCache;
	return markdown.render(80);
}

describe("Markdown streaming normalization and lexing", () => {
	test("keeps long boundary-heavy documents identical in streamed and ordinary renders", () => {
		const block =
			"A paragraph with **bold**, _italic_, and `code` text keeps the lexer busy.\n\n" +
			"- first list item\n- second list item\n\n";
		let text = "";
		while (text.length < 16 * 1024 - 900) text += block;
		text += [
			"## Boundary heading",
			"",
			"[reference]: https://example.com/reference",
			"",
			"<blockquote>html block near the lexing boundary</blockquote>",
			"",
			"```ts",
			"const value = 42;",
			"```",
			"",
			"| name | value |",
			"| --- | --- |",
			"| boundary | stable |",
			"",
			"tail text makes this document cross the window threshold.",
		].join("\n");
		if (text.length <= 16 * 1024) text += "\n".repeat(16 * 1024 - text.length + 1);

		expect(renderMarkdown(text)).toEqual(renderMarkdown(text, true));
	});

	test("normalizes only appended text while preserving balanced fences and tabs", () => {
		const initial = "Intro paragraph.\n\n```ts\nconst value = 1;\n```\n\n";
		const appended = `${initial}next\tline after the balanced fence.`;
		const markdown = new Markdown(initial, 1, 0, theme);
		markdown.render(80);
		markdown.setText(appended);

		expect(markdown.render(80)).toEqual(renderMarkdown(appended));
	});

	test("rechecks fence repair when an append changes an orphan into a table or closes it", () => {
		const initial = "Intro paragraph.\n\n```\n";
		const markdown = new Markdown(initial, 1, 0, theme);
		markdown.render(80);

		const repaired = `${initial}# Heading\n\n| key | value |\n| --- | --- |\n| one | two |\n`;
		markdown.setText(repaired);
		expect(markdown.render(80)).toEqual(renderMarkdown(repaired));

		const closed = `${repaired}\`\`\`\n`;
		markdown.setText(closed);
		expect(markdown.render(80)).toEqual(renderMarkdown(closed));

		const splitFence = new Markdown("Intro paragraph.\n\n``", 1, 0, theme);
		splitFence.render(80);
		const completedSplit = "Intro paragraph.\n\n```\n# Heading\n\n| key | value |\n| --- | --- |\n| one | two |\n";
		splitFence.setText(completedSplit);
		expect(splitFence.render(80)).toEqual(renderMarkdown(completedSplit));

		const splitReference = new Markdown("[reference", 1, 0, theme);
		splitReference.render(80);
		const completedReference = "[reference]: https://example.com\n\n[x][reference]";
		splitReference.setText(completedReference);
		expect(splitReference.render(80)).toEqual(renderMarkdown(completedReference));
	});

	test("fully resets append normalization on replacement", () => {
		const markdown = new Markdown("first\tline", 1, 0, theme);
		markdown.render(80);
		markdown.setText("first\tline plus more");
		markdown.render(80);

		const replacement = "replacement\n\n- one\n- two\n";
		markdown.setText(replacement);
		expect(markdown.render(80)).toEqual(renderMarkdown(replacement));
	});
});

describe("Markdown incremental wrapping", () => {
	function freshRender(
		text: string,
		width: number,
		transientRenderCache: boolean,
		mdTheme = theme,
	): readonly string[] {
		const markdown = new Markdown(text, 1, 0, mdTheme);
		markdown.transientRenderCache = transientRenderCache;
		return markdown.render(width);
	}

	test("keeps appended paragraph and fenced-code output identical", () => {
		const cases = [
			{
				initial: "A paragraph with enough words to wrap across terminal rows",
				suffixes: [" and a changed tail", " plus another continuation", "\n\nA new paragraph"],
			},
			{
				initial: "Intro\n\n```ts\nconst value = 1;",
				suffixes: ["\nconst next = value + 1;", "\n```", "\n\nTail after the fence"],
			},
		] as const;

		for (const { initial, suffixes } of cases) {
			for (const transientRenderCache of [false, true]) {
				const markdown = new Markdown(initial, 1, 0, theme);
				markdown.transientRenderCache = transientRenderCache;
				markdown.render(32);
				let text = initial;
				for (const suffix of suffixes) {
					text += suffix;
					markdown.setText(text);
					expect(markdown.render(32)).toEqual(freshRender(text, 32, transientRenderCache));
				}
			}
		}
	});

	test("keeps appended heading and list-item boundaries identical", () => {
		const initial = "Existing paragraph.\n\n";
		const suffixes = ["# New heading\n\n", "- first item", "\n- second item", "\n\nTail"];
		const markdown = new Markdown(initial, 1, 0, theme);
		markdown.render(48);
		let text = initial;
		for (const suffix of suffixes) {
			text += suffix;
			markdown.setText(text);
			expect(markdown.render(48)).toEqual(freshRender(text, 48, false));
		}
	});

	test("re-lexes a repaired fence before recognizing an appended table", () => {
		const suffixes = [
			"```ts\n",
			"```\n",
			"_it_ ",
			"\n\n",
			"```\n",
			"\n\n",
			"|a|b|\n|---|---|\n|1|2|\n",
			"# head\n\n",
		] as const;
		const markdown = new Markdown("", 1, 0, theme);
		markdown.transientRenderCache = false;
		let text = "";
		for (const suffix of suffixes) {
			text += suffix;
			markdown.setText(text);
			expect(markdown.render(59)).toEqual(freshRender(text, 59, false));
		}
	});

	test("keeps repeated plain paragraph appends identical at wrap boundaries", () => {
		const suffix = " streaming token words follow ";
		for (const transientRenderCache of [false, true]) {
			for (const width of [12, 32, 64]) {
				const markdown = new Markdown(suffix, 1, 0, theme);
				markdown.transientRenderCache = transientRenderCache;
				markdown.render(width);
				let text = suffix;
				for (let i = 0; i < 20; i++) {
					text += suffix;
					markdown.setText(text);
					expect(markdown.render(width)).toEqual(freshRender(text, width, transientRenderCache));
				}
			}
		}
	});

	test("invalidates incremental fragments for replacements, width changes, and theme changes", () => {
		const initial = "Intro\n\n```ts\nconst value = 1;\n```\n\nA long paragraph that wraps at narrow widths.";
		const markdown = new Markdown(initial, 1, 0, theme);
		markdown.render(64);
		let text = `${initial} first append`;
		markdown.setText(text);
		markdown.render(64);

		text += " second append";
		markdown.setText(text);
		expect(markdown.render(28)).toEqual(freshRender(text, 28, false));

		const replacement = "Replacement\n\n- one\n- two";
		markdown.setText(replacement);
		expect(markdown.render(28)).toEqual(freshRender(replacement, 28, false));

		const changingTheme: MarkdownTheme = { ...theme };
		const themed = new Markdown(initial, 1, 0, changingTheme);
		themed.render(64);
		let themedText = `${initial} first append`;
		themed.setText(themedText);
		themed.render(64);
		changingTheme.codeBlock = text => `changed:${text}`;
		themedText += " second append";
		themed.setText(themedText);
		expect(themed.render(64)).toEqual(freshRender(themedText, 64, false, changingTheme));
	});
});

test("sanitizes terminal controls before Markdown rendering", () => {
	const source = "safe\x07bell\x01control\x1b[31mforeign\x1b[0m\ttab";
	const rows = new Markdown(source, 0, 0, theme).render(80);
	const output = rows.join("\n");
	expect(output).toContain("safebellcontrolforeign");
	expect(output).toContain("tab");
	expect(output).not.toContain("\x07");
	expect(output).not.toContain("\x01");
	expect(output).not.toContain("\x1b[31m");
	expect(output).not.toContain("\t");
});

test("invalidates Markdown wrapping when the terminal width mode changes", () => {
	const previousWidth = getHangulCompatibilityJamoWidth();
	const source = `width-epoch-${"ㄱ".repeat(20)}-end`;
	try {
		setHangulCompatibilityJamoWidth("unicode");
		const markdown = new Markdown(source, 0, 0, theme, undefined, 2, false);
		markdown.render(10);

		setHangulCompatibilityJamoWidth(1);
		const updated = markdown.render(10);
		const expected = new Markdown(source, 0, 0, theme, undefined, 2, false).render(10);
		expect(updated).toEqual(expected);

		const cachedSource = `${source}-shared`;
		setHangulCompatibilityJamoWidth("unicode");
		new Markdown(cachedSource, 0, 0, theme).render(10);
		setHangulCompatibilityJamoWidth(1);
		const shared = new Markdown(cachedSource, 0, 0, theme).render(10);
		const sharedExpected = new Markdown(cachedSource, 0, 0, theme, undefined, 2, false).render(10);
		expect(shared).toEqual(sharedExpected);
	} finally {
		setHangulCompatibilityJamoWidth(previousWidth);
	}
});
