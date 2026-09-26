import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SymbolTheme } from "../symbols";
import { getHangulCompatibilityJamoWidth, setHangulCompatibilityJamoWidth } from "../utils";
import { clearRenderCache, Markdown, type MarkdownTheme } from "./markdown";

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

describe("Markdown nested blockquotes", () => {
	test("deeply nested blockquotes do not multiply rendered rows", () => {
		// Pre-fix, each level past the width floor re-wrapped already-bordered rows and the
		// row count grew as ~2^(depth - width/2); depth 44 at width 80 produced 128 rows.
		const output = new Markdown(`${"> ".repeat(44)}hi`, 0, 0, theme).render(80);
		expect(output.length).toBeLessThanOrEqual(8);
		expect(output.join("\n")).toContain("hi");
	});

	test("deeply nested blockquote paragraphs stay bounded by content length", () => {
		const sentence = "The quick brown fox jumps over the lazy dog. ";
		const output = new Markdown("> ".repeat(24) + sentence.repeat(4), 0, 0, theme).render(40);
		expect(output.length).toBeLessThanOrEqual(32);
		const joined = output.join("\n");
		for (const word of ["quick", "brown", "jumps", "lazy", "dog."]) {
			expect(joined).toContain(word);
		}
	});

	test("shallow quotes keep their border and content", () => {
		const output = new Markdown("> quoted text", 0, 0, theme).render(80);
		expect(output.join("\n")).toContain("quoted text");
		expect(output.filter(line => line.startsWith("> ")).length).toBeGreaterThan(0);
	});
});

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

	const highlightingTheme: MarkdownTheme = {
		...theme,
		highlightCode: (code, lang) => code.split("\n").map(line => `full:${lang ?? "plain"}:${line}`),
		createHighlightStream: lang =>
			lang === "ts"
				? {
						push: chunk => {
							const lines = chunk.split("\n");
							lines.pop();
							return lines.map(line => `stream:${line}\n`).join("");
						},
					}
				: null,
	};

	test("keeps streamed code rows identical to a fresh render for known and unknown languages", () => {
		for (const transientRenderCache of [false, true]) {
			for (const language of ["ts", "unknown"] as const) {
				let text = `Intro\n\n\`\`\`${language}\n`;
				const markdown = new Markdown(text, 1, 0, highlightingTheme);
				markdown.transientRenderCache = transientRenderCache;
				markdown.render(32);

				for (const suffix of ["const first = 1;\n", "const second = 2;\n", "const third = 3;"]) {
					text += suffix;
					markdown.setText(text);
					expect(markdown.render(32)).toEqual(freshRender(text, 32, transientRenderCache, highlightingTheme));
				}

				text += "\n```";
				markdown.setText(text);
				expect(markdown.render(32)).toEqual(freshRender(text, 32, transientRenderCache, highlightingTheme));
			}
		}
	});

	// A later code block whose lines line up with an earlier one's must not be
	// shown with the earlier block's highlighted rows while it streams.
	test("streams a second code block with its own rows when its lines line up with the first", () => {
		const body =
			"```ts\nconst a = first(1);\nreturn a;\n```\n\nBetween.\n\n```ts\nconst b = other(2);\nreturn b;\n```\n";
		for (const step of [3, 7, 13]) {
			const markdown = new Markdown("", 1, 0, highlightingTheme);
			markdown.transientRenderCache = true;
			for (let end = step; end <= body.length; end += step) {
				const text = body.slice(0, end);
				markdown.setText(text);
				expect(markdown.render(40), `${step}:${end}`).toEqual(freshRender(text, 40, true, highlightingTheme));
			}
		}
	});

	test("does not retain stale body rows when the closing fence arrives last", () => {
		let text = "```ts\nline one\nline two";
		const markdown = new Markdown(text, 1, 0, highlightingTheme);
		markdown.transientRenderCache = true;
		markdown.render(40);

		text += "\nline three";
		markdown.setText(text);
		expect(markdown.render(40)).toEqual(freshRender(text, 40, true, highlightingTheme));

		text += "\n```";
		markdown.setText(text);
		expect(markdown.render(40)).toEqual(freshRender(text, 40, true, highlightingTheme));
	});

	test("updates only the mutable wrapped code row", () => {
		let text = "```ts\nconst first = a_really_long_identifier + another_long_identifier;";
		const markdown = new Markdown(text, 1, 0, highlightingTheme);
		markdown.transientRenderCache = true;
		markdown.render(18);

		for (const suffix of ["\nconst second = still_a_really_long_identifier;", "\nconst third = final_identifier;"]) {
			text += suffix;
			markdown.setText(text);
			expect(markdown.render(18)).toEqual(freshRender(text, 18, true, highlightingTheme));
		}
	});

	test("recomputes streamed code rows after a width change", () => {
		let text = "```ts\nconst first = 1;\n";
		const markdown = new Markdown(text, 1, 0, highlightingTheme);
		markdown.transientRenderCache = true;
		markdown.render(24);

		text += "const second = 2;\n";
		markdown.setText(text);
		expect(markdown.render(48)).toEqual(freshRender(text, 48, true, highlightingTheme));

		text += "const third = 3;";
		markdown.setText(text);
		expect(markdown.render(48)).toEqual(freshRender(text, 48, true, highlightingTheme));
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

describe("Markdown bounded render caches", () => {
	beforeEach(clearRenderCache);
	afterEach(clearRenderCache);

	test("evicts hidden source keys within the byte budget while retaining recent renders", () => {
		let renders = 0;
		const countingTheme: MarkdownTheme = {
			...theme,
			bold: text => {
				renders++;
				return `bold:${text}`;
			},
		};
		const render = (index: number): readonly string[] => {
			const source = `[hidden${index}]: https://example.test/${"x".repeat(1024 * 1024)}\n\n**visible${index}**`;
			return new Markdown(source, 0, 0, countingTheme).render(40);
		};
		for (let index = 0; index < 13; index++) {
			expect(render(index).join("\n")).toContain(`bold:visible${index}`);
		}
		expect(renders).toBe(13);
		expect(render(12).join("\n")).toContain("bold:visible12");
		expect(renders).toBe(13);
		expect(render(0).join("\n")).toContain("bold:visible0");
		expect(renders).toBe(14);
	});

	test("renders oversized hidden sources without admitting them to the shared cache", () => {
		let renders = 0;
		const countingTheme: MarkdownTheme = {
			...theme,
			bold: text => {
				renders++;
				return `bold:${text}`;
			},
		};
		const source = `[hidden]: https://example.test/${"x".repeat(2 * 1024 * 1024)}\n\n**visible**`;
		for (let index = 0; index < 2; index++) {
			expect(new Markdown(source, 0, 0, countingTheme).render(40).join("\n")).toContain("bold:visible");
		}
		expect(renders).toBe(2);
	});

	test("combines source and rendered storage for per-entry admission", () => {
		let renders = 0;
		const countingTheme: MarkdownTheme = {
			...theme,
			highlightCode: () => {
				renders++;
				return ["rendered ".repeat(96 * 1024)];
			},
		};
		// Each half fits on its own, but their UTF-16 storage together exceeds 4 MiB.
		const source = `[hidden]: https://example.test/${"x".repeat(1280 * 1024)}\n\n\`\`\`txt\nsmall\n\`\`\``;
		for (let index = 0; index < 2; index++) {
			const rows = new Markdown(source, 0, 0, countingTheme).render(80);
			expect(
				rows
					.filter(row => row.includes("rendered"))
					.join("")
					.replaceAll(" ", ""),
			).toBe("rendered".repeat(96 * 1024));
		}
		expect(renders).toBe(2);
	});

	test("keeps mutable theme probes distinct even when their separator bytes coincide", () => {
		let backgroundProbe = "a\x00b";
		let headingProbe = "c";
		let headingLabel = "before";
		const changingTheme: MarkdownTheme = {
			...theme,
			heading: text => (text === "" ? headingProbe : `${headingLabel}:${text}`),
		};
		const style = { bgColor: (text: string): string => (text === "\x01" ? backgroundProbe : text) };
		const source = "# Heading";
		expect(new Markdown(source, 0, 0, changingTheme, style).render(40).join("\n")).toContain("before:Heading");
		backgroundProbe = "a";
		headingProbe = "b\x00c";
		headingLabel = "after";
		const rows = new Markdown(source, 0, 0, changingTheme, style).render(40);
		expect(rows.join("\n")).toContain("after:Heading");
		expect(rows).toEqual(new Markdown(source, 0, 0, changingTheme, style, 2, false).render(40));
	});

	test("bounds fresh-process cache residency and detaches sliced source and rendered backing storage", async () => {
		const source = `
import { setImmediate } from "node:timers/promises";
import { clearRenderCache, Markdown, type MarkdownTheme } from "./markdown.ts";
const identity = (text: string): string => text;
const theme: MarkdownTheme = {
	heading: identity, link: identity, linkUrl: identity, code: identity,
	codeBlock: identity, codeBlockBorder: identity, quote: identity, quoteBorder: identity,
	hr: identity, listBullet: identity, bold: identity, italic: identity,
	strikethrough: identity, underline: identity, symbols: ${JSON.stringify(symbols)},
};
async function heap(): Promise<number> {
	Bun.gc(true);
	Bun.gc(true);
	await setImmediate();
	return process.memoryUsage().heapUsed;
}
function renderHidden(index: number): void {
	const text = "[hidden" + index + "]: https://example.test/" + Buffer.alloc(1024 * 1024, 65 + index % 26).toString() + "\\n\\nvisible";
	new Markdown(text, 0, 0, theme).render(80);
}
new Markdown("warmup", 0, 0, theme).render(80);
const beforeKeys = await heap();
for (let index = 0; index < 64; index++) renderHidden(index);
const keyHeapDelta = (await heap()) - beforeKeys;
clearRenderCache();
const beforeSlices = await heap();
function sliceBacking(text: string): string {
	return (Buffer.alloc(8 * 1024 * 1024, 120).toString() + text).slice(-text.length);
}
// OSC 66 rows bypass wrapping, so the cached row really is the highlighter's
// substring, not a copy already made by the native wrapper. UTF-16 must survive.
const renderedRow = "\\x1b]66;s=1;" + "visible".repeat(80) + "\\ud800X\\udfff\\x1b\\\\";
const sliceTheme: MarkdownTheme = { ...theme, highlightCode: () => [sliceBacking(renderedRow)] };
function renderSlice(index: number): boolean {
	const text = sliceBacking("[hidden" + index + "]: https://example.test/" + "x".repeat(512) + "\\n\\n\\x60\\x60\\x60text\\nslice-" + index + "\\n\\x60\\x60\\x60");
	return new Markdown(text, 0, 0, sliceTheme, undefined, 0).render(80).includes(renderedRow);
}
let exactRows = true;
for (let index = 0; index < 12; index++) exactRows = renderSlice(index) && exactRows;
const sliceHeapDelta = (await heap()) - beforeSlices;
console.log(JSON.stringify({ keyHeapDelta, sliceHeapDelta, exactRows }));
`;
		const proc = Bun.spawn({
			cmd: [process.execPath, "--eval", source],
			cwd: import.meta.dir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const result = JSON.parse(stdout) as { keyHeapDelta: number; sliceHeapDelta: number; exactRows: boolean };
		// 24 MiB of cache data plus 8 MiB of allocator/renderer overhead; the
		// original hidden-key regression retained over 129 MiB for this workload.
		expect(result.keyHeapDelta).toBeLessThan(32 * 1024 * 1024);
		expect(result.sliceHeapDelta).toBeLessThan(8 * 1024 * 1024);
		expect(result.exactRows).toBe(true);
	}, 30_000);

	test("re-admits growing code fragments and renders correctly after source bytes exceed the limit", () => {
		let firstLineRenders = 0;
		const shortCode = (text: string): string => text.slice(0, 16);
		const countingTheme: MarkdownTheme = {
			...theme,
			codeBlock: text => {
				if (text === "anchor") firstLineRenders++;
				return shortCode(text);
			},
		};
		const markdown = new Markdown("", 0, 0, countingTheme);
		markdown.transientRenderCache = true;
		let source = `\`\`\`txt\nanchor\n${"x".repeat(512 * 1024)}\ntail`;
		markdown.setText(source);
		markdown.render(40);
		expect(firstLineRenders).toBe(1);
		source += " continued";
		markdown.setText(source);
		markdown.render(40);
		expect(firstLineRenders).toBe(1);
		source += `\n${"y".repeat(768 * 1024)}\nnext`;
		markdown.setText(source);
		markdown.render(40);
		expect(firstLineRenders).toBe(1);
		source += " final";
		markdown.setText(source);
		const rows = markdown.render(40);
		expect(firstLineRenders).toBe(2);
		const fresh = new Markdown(source, 0, 0, { ...theme, codeBlock: shortCode });
		fresh.transientRenderCache = true;
		expect(rows).toEqual(fresh.render(40));
	});
});

describe("Markdown stable streaming source", () => {
	test("reports the last rendered parser-frozen source boundary independent of width", () => {
		const first = "First complete paragraph.\n\n";
		const second = "Second paragraph is now complete.\n\n";
		const markdown = new Markdown(`${first}Second-paragraph-is-open`, 0, 0, theme);
		markdown.transientRenderCache = true;

		markdown.render(24);
		expect(markdown.getLastRenderStableText()).toBe(first);
		markdown.render(72);
		expect(markdown.getLastRenderStableText()).toBe(first);

		markdown.setText(`${first}${second}Third-paragraph-is-open`);
		markdown.render(37);
		expect(markdown.getLastRenderStableText()).toBe(first + second);

		markdown.transientRenderCache = false;
		markdown.render(37);
		expect(markdown.getLastRenderStableText()).toBe("");
	});

	test("uses lexer block boundaries for tables, code, and lists", () => {
		for (const stableBlock of [
			"| key | value |\n| --- | --- |\n| one | two |\n\n",
			"```ts\nconst value = 1;\n```\n\n",
			"- first item\n- second item\n\n",
		]) {
			const markdown = new Markdown(`${stableBlock}unfinished-tail`, 0, 0, theme);
			markdown.transientRenderCache = true;
			markdown.render(48);
			expect(markdown.getLastRenderStableText()).toBe(stableBlock);
		}
	});

	test("never includes an open or malformed Markdown suffix", () => {
		const stable = "Settled prose.\n\n";
		for (const suffix of [
			"[link text without a destination",
			"| header | partial\n| ---",
			"- first item\n-",
			"```ts\nconst streaming = true;\n",
			"**emphasis still open across words",
			"| cells | may | still | become | a table",
		]) {
			const markdown = new Markdown(stable + suffix, 0, 0, theme);
			markdown.transientRenderCache = true;
			markdown.render(40);
			expect(markdown.getLastRenderStableText()).toBe(stable);
		}
	});

	// A block taller than the live viewport clips its unfinished top off the
	// screen unless its settled rows can retire while it is still streaming.
	test("extends into a streaming list or code fence only through rows that cannot change", () => {
		const settled = "Settled prose.\n\n";
		for (const [finished, streaming] of [
			["- first item\n- second item\n", "- third ite"],
			["```ts\nconst first = 1;\nconst second = 2;\n", "const thi"],
			["```ts\nconst first = 1;\n", "const second = 2;\n"],
		] as const) {
			const markdown = new Markdown(settled + finished + streaming, 0, 0, theme);
			markdown.transientRenderCache = true;
			const live = markdown.render(40);
			const stable = markdown.getLastRenderStableText();
			expect(stable).toBe(settled + finished);

			const prefix = new Markdown(stable.trim(), 0, 0, theme);
			prefix.setStreamPrefix(true);
			const rows = prefix.render(40);
			expect(live.slice(0, rows.length)).toEqual([...rows]);
			expect(rows.length).toBeLessThan(live.length);
		}
	});
});

describe("Markdown code block wrapping", () => {
	const codeRows = (rendered: readonly string[]): string[] =>
		rendered.map(row => row.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).filter(row => row.trim().length > 0);

	test("wrapped code rows stay indented under the code block", () => {
		const source = "```ts\nconst answer = compute(alpha, beta) + gamma; // a trailing comment to force wrapping\n```";
		const rendered = new Markdown(source, 0, 0, theme).render(40);
		const body = codeRows(rendered).filter(row => !row.includes("```"));

		expect(body.length).toBeGreaterThan(1);
		for (const row of body) {
			expect(row.startsWith("  ")).toBe(true);
			expect(row.trimStart().length).toBeGreaterThan(0);
		}
	});

	test("streamed code rows wrap identically to a fresh render", () => {
		let text = "```ts\nconst answer = compute(alpha, beta) + gamma; // a trailing comment to force wrapping";
		const markdown = new Markdown(text, 0, 0, theme);
		markdown.transientRenderCache = true;
		markdown.render(40);

		text += "\nconst second = compute(delta, epsilon) + zeta; // another trailing comment that wraps";
		markdown.setText(text);
		expect(markdown.render(40)).toEqual(new Markdown(text, 0, 0, theme).render(40));

		const body = codeRows(markdown.render(40)).filter(row => !row.includes("```"));
		expect(body.length).toBeGreaterThan(2);
		for (const row of body) expect(row.startsWith("  ")).toBe(true);
	});

	test("code inside a list item keeps the code indent on wrapped rows", () => {
		const source =
			"- item text\n\n  ```ts\n  const answer = compute(alpha, beta) + gamma; // a trailing comment forces wrapping\n  ```";
		const body = codeRows(new Markdown(source, 0, 0, theme).render(40)).filter(
			row => row.includes("compute") || row.includes("trailing") || row.includes("comment"),
		);

		expect(body.length).toBeGreaterThan(1);
		const firstIndent = body[0]!.length - body[0]!.trimStart().length;
		for (const row of body.slice(1)) {
			expect(row.length - row.trimStart().length).toBe(firstIndent);
		}
	});

	test("code blocks rendered without indent keep their literal rows", () => {
		const source = "```ts\nconst answer = 1;\n```";
		const rendered = new Markdown(source, 0, 0, theme, undefined, 0).render(40);
		expect(codeRows(rendered)).toContain("const answer = 1;");
	});

	test("an open fence stays plain when the highlight stream factory throws", () => {
		const throwingTheme: MarkdownTheme = {
			...theme,
			highlightCode: code => [`F<${code}>`],
			createHighlightStream: () => {
				throw new TypeError("undefined is not a constructor");
			},
		};
		const markdown = new Markdown("```lua\nlocal x = 1\nmore", 0, 0, throwingTheme);
		markdown.transientRenderCache = true;
		const plain = codeRows(markdown.render(80)).join("\n");
		expect(plain).toContain("local x = 1");
		expect(plain).not.toContain("F<");
	});
});

describe("Markdown GFM fidelity", () => {
	const rows = (rendered: readonly string[]): string[] =>
		rendered.map(row => row.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).filter(row => row.trim().length > 0);

	test("task list items render their checkbox state", () => {
		const rendered = rows(
			new Markdown("- [ ] unchecked task\n- [x] checked task\n- plain bullet", 0, 0, theme).render(40),
		);
		expect(rendered).toEqual(["□ unchecked task", "■ checked task", "- plain bullet"]);
	});

	test("ordered task items keep their number alongside the checkbox", () => {
		const rendered = rows(new Markdown("1. [ ] pending\n2. [x] done", 0, 0, theme).render(40));
		expect(rendered).toEqual(["1. □ pending", "2. ■ done"]);
	});

	test("nested task items keep their own state and indent", () => {
		const rendered = rows(new Markdown("- [ ] parent\n  - [x] child", 0, 0, theme).render(40));
		expect(rendered).toEqual(["□ parent", "  ■ child"]);
	});

	test("task checkbox glyphs come from the symbol theme", () => {
		const asciiTheme: MarkdownTheme = { ...theme, symbols: { ...symbols, taskChecked: "[x]", taskUnchecked: "[ ]" } };
		const rendered = rows(new Markdown("- [ ] todo\n- [x] done", 0, 0, asciiTheme).render(40));
		expect(rendered).toEqual(["[ ] todo", "[x] done"]);
	});

	test("a streamed task item keeps its checkbox while its text grows", () => {
		let text = "- [x] a checked item that is long enough to wrap across";
		const markdown = new Markdown(text, 0, 0, theme);
		markdown.transientRenderCache = true;
		markdown.render(24);

		text += " more than one row";
		markdown.setText(text);
		const streamed = markdown.render(24);
		expect(streamed).toEqual(new Markdown(text, 0, 0, theme).render(24));
		expect(rows(streamed)[0]).toStartWith("■ a checked item");
	});

	test("wrapped task item rows hang under the checkbox", () => {
		const rendered = rows(
			new Markdown("- [ ] first task with enough words to wrap twice over", 0, 0, theme).render(24),
		);
		expect(rendered[0]).toStartWith("□ ");
		expect(rendered.length).toBeGreaterThan(1);
		for (const row of rendered.slice(1)) expect(row).toStartWith("  ");
	});

	test("column alignment from the delimiter row places the cell padding", () => {
		const table = "| left | center | right |\n| :--- | :----: | ----: |\n| a | b | c |";
		const rendered = rows(new Markdown(table, 0, 0, theme).render(40));
		expect(rendered).toContain("| a    |   b    |     c |");
	});

	test("a table without alignment markers stays left aligned", () => {
		const table = "| left | middle | right |\n| --- | --- | --- |\n| a | b | c |";
		const rendered = rows(new Markdown(table, 0, 0, theme).render(40));
		expect(rendered).toContain("| a    | b      | c     |");
	});

	test("image URLs stay visible like link URLs", () => {
		const rendered = rows(new Markdown("![alt text](https://img.example.com/x.png)", 0, 0, theme).render(60));
		expect(rendered).toEqual(["alt text (https://img.example.com/x.png)"]);
	});

	test("an image without alt text renders its URL", () => {
		const rendered = rows(new Markdown("![](https://img.example.com/bare.png)", 0, 0, theme).render(60));
		expect(rendered).toEqual(["(https://img.example.com/bare.png)"]);
	});

	test("an inline image keeps the surrounding text", () => {
		const rendered = rows(new Markdown("before ![pic](https://img.example.com/y.png) after", 0, 0, theme).render(60));
		expect(rendered).toEqual(["before pic (https://img.example.com/y.png) after"]);
	});
});
