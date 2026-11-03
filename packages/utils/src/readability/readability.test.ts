import { describe, expect, it } from "bun:test";
import { parseHTML } from "../dom";
import { Readability } from "./readability";

describe("Readability", () => {
	it("short document fallback never promotes the article to a non-element document", () => {
		const { document } = parseHTML(
			"<html><body><main><p>First paragraph.</p><p>Second paragraph.</p><pre>  indented\n\n    more</pre></main></body></html>",
		);
		const article = new Readability(document).parse();
		expect(article?.textContent).toContain("First paragraph.");
		expect(article?.textContent).toContain("Second paragraph.");
		expect(article?.content).toContain("<pre>");
	});

	it("keeps selected article output stable when nested links are scored", () => {
		const html = `<!doctype html><html lang="en"><head><title>Example article | Example Site</title></head><body><article class="content"><h1>Example article</h1><p>Body text has enough words to be selected as article content and <a href="#part">a fragment link</a>.</p><p>Second paragraph has enough prose to exercise the selected article output.</p></article><aside class="sidebar"><p>Ignore this navigation.</p></aside></body></html>`;
		const article = new Readability(parseHTML(html).document).parse();
		if (!article) throw new Error("Readability failed to select the fixture article");

		expect(article).toEqual({
			title: "Example article | Example Site",
			byline: undefined,
			dir: null,
			lang: "en",
			content:
				'<DIV class="page" id="readability-page-1"><article><p>Body text has enough words to be selected as article content and <a href="#part">a fragment link</a>.</p><p>Second paragraph has enough prose to exercise the selected article output.</p></article></DIV>',
			textContent:
				"Body text has enough words to be selected as article content and a fragment link.Second paragraph has enough prose to exercise the selected article output.",
			length: 155,
			excerpt: "Body text has enough words to be selected as article content and a fragment link.",
			siteName: undefined,
			publishedTime: null,
		});
	});
});
