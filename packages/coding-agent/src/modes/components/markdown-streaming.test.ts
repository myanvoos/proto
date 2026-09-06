import { afterEach, expect, test, vi } from "bun:test";
import { Markdown, visibleWidth } from "@oh-my-pi/pi-tui";
import { Lexer, type TokensList } from "@oh-my-pi/pi-utils/marked";
import { Settings } from "../../config/settings";
import { getMarkdownTheme, initThemeSync } from "../theme/theme";

await Settings.init();
initThemeSync();
afterEach(() => vi.restoreAllMocks());

function streamingMarkdown(text: string): Markdown {
	const markdown = new Markdown(text, 0, 0, getMarkdownTheme());
	markdown.transientRenderCache = true;
	return markdown;
}

test("streamed markdown renders the same rows as a fresh render across block boundaries and late references", () => {
	const markdown = streamingMarkdown("");
	let text = "";
	const chunks = [
		"## Progress\n\nFirst **paragraph** with café 日本語.\n\nNext",
		" paragraph.\n\n1",
		". first item\n\n2",
		". second item\n\nAfter the list.\n\n",
		"| Name | Value |\n| --- | --- |\n| item | value |\n\nAfter the table.\n\n",
		"See [details][ref].\n\nPending",
		" reference.\n\n[ref]: https://example.com/details\n",
	];
	for (const chunk of chunks) {
		text += chunk;
		markdown.setText(text);
		const previous = markdown.render(48);
		const snapshot = [...previous];
		expect(previous).toEqual(streamingMarkdown(text).render(48));
		expect(previous.every(line => visibleWidth(line) <= 48)).toBe(true);
		expect(markdown.render(31)).toEqual(streamingMarkdown(text).render(31));
		expect(previous).toEqual(snapshot);
	}

	markdown.transientRenderCache = false;
	expect(markdown.render(48)).toEqual(new Markdown(text, 0, 0, getMarkdownTheme()).render(48));
	markdown.transientRenderCache = true;
	markdown.setText("Replacement\n\nDifferent content\r\nnext line");
	expect(markdown.render(48)).toEqual(streamingMarkdown("Replacement\n\nDifferent content\r\nnext line").render(48));
});

test("appending to a mutable markdown tail does not revisit frozen token bodies", () => {
	const lex = Lexer.prototype.lex;
	let frozenRawReads = 0;
	let tracked = false;
	vi.spyOn(Lexer.prototype, "lex").mockImplementation(function (this: Lexer, source: string): TokensList {
		const tokens = lex.call(this, source);
		if (!tracked) {
			const first = tokens[0]!;
			const raw = first.raw;
			Object.defineProperty(first, "raw", {
				get: () => {
					frozenRawReads++;
					return raw;
				},
			});
			tracked = true;
		}
		return tokens;
	});
	let text = `${Array.from({ length: 128 }, (_, index) => `Completed paragraph ${index}.\n\n`).join("")}Mutable`;
	const markdown = streamingMarkdown(text);
	markdown.render(80);
	frozenRawReads = 0;
	for (let frame = 0; frame < 64; frame++) {
		text += " word";
		markdown.setText(text);
		markdown.render(80);
	}
	expect(frozenRawReads, "streaming work must not rescan already-frozen paragraph tokens").toBe(0);
	expect(markdown.render(80).join("\n")).toContain("Mutable word");
});
