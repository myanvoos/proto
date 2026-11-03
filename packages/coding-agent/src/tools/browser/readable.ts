import type * as DomNs from "@oh-my-pi/pi-utils/dom";
import type * as ReadabilityNs from "@oh-my-pi/pi-utils/readability";
import { htmlToBasicMarkdown } from "../../web/scrapers/types";

export type ReadableFormat = "text" | "markdown";

export interface ReadableResult {
	url: string;
	title?: string;
	byline?: string;
	excerpt?: string;
	contentLength: number;
	text?: string;
	markdown?: string;
}

function normalize(text: string | null | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed || undefined;
}

let readabilityModule: typeof ReadabilityNs | undefined;
async function loadReadability(): Promise<typeof ReadabilityNs> {
	if (!readabilityModule) {
		readabilityModule = await import("@oh-my-pi/pi-utils/readability");
	}
	return readabilityModule;
}

let domModule: typeof DomNs | undefined;
async function loadDom(): Promise<typeof DomNs> {
	if (!domModule) {
		domModule = await import("@oh-my-pi/pi-utils/dom");
	}
	return domModule;
}

const BLOCK_TAGS: Readonly<Record<string, true>> = {
	ADDRESS: true,
	ARTICLE: true,
	ASIDE: true,
	BLOCKQUOTE: true,
	CAPTION: true,
	DD: true,
	DETAILS: true,
	DIALOG: true,
	DIV: true,
	DL: true,
	DT: true,
	FIELDSET: true,
	FIGCAPTION: true,
	FIGURE: true,
	FOOTER: true,
	FORM: true,
	H1: true,
	H2: true,
	H3: true,
	H4: true,
	H5: true,
	H6: true,
	HEADER: true,
	HR: true,
	LI: true,
	MAIN: true,
	NAV: true,
	OL: true,
	P: true,
	PRE: true,
	SECTION: true,
	SUMMARY: true,
	TABLE: true,
	TR: true,
	UL: true,
};
/** Never rendered as text; skipped below the extraction root. */
const SKIP_TAGS: Readonly<Record<string, true>> = { SCRIPT: true, STYLE: true, NOSCRIPT: true, TEMPLATE: true };
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * Text of a subtree with line breaks where the document has block boundaries.
 * Whitespace outside `<pre>` is collapsed the way a renderer collapses it;
 * `<pre>` keeps its indentation and blank lines. A raw-text root (`<script>`,
 * `<template>`, …) returns its text as is. Only trailing whitespace is trimmed,
 * so a leading empty-cell tab keeps the first row's columns aligned.
 */
function blockText(root: DomNs.Element): string {
	if (SKIP_TAGS[root.tagName.toUpperCase()]) return (root.textContent ?? "").trimEnd();
	// Parts are never empty, so the last part's last character is the output's.
	// Only the last parts are ever rewritten, which keeps the walk linear.
	const parts: string[] = [];
	let pendingBreaks = 0;
	let cellsInRow = 0;
	const append = (text: string): void => {
		if (pendingBreaks > 0) {
			while (parts.length > 0) {
				const last = parts[parts.length - 1]!.replace(/[ \t]+$/, "");
				if (last) {
					parts[parts.length - 1] = last;
					parts.push("\n".repeat(pendingBreaks));
					break;
				}
				parts.pop();
			}
			pendingBreaks = 0;
		}
		parts.push(text);
	};
	const walk = (node: DomNs.Node, pre: boolean): void => {
		if (node.nodeType === TEXT_NODE) {
			let text = node.textContent ?? "";
			if (!pre) {
				// ASCII whitespace only: `&nbsp;` is not collapsed by renderers either.
				text = text.replace(/[ \t\n\r\f]+/g, " ");
				const last = parts[parts.length - 1];
				if (pendingBreaks > 0 || !last || " \n\t".includes(last.at(-1)!)) text = text.replace(/^ /, "");
			}
			if (text) append(text);
			return;
		}
		if (node.nodeType !== ELEMENT_NODE) return;
		const tag = (node as DomNs.Element).tagName.toUpperCase();
		if (node !== root && SKIP_TAGS[tag]) return;
		if (tag === "BR") {
			if (parts.length > 0) pendingBreaks++;
			return;
		}
		if (tag === "TR") cellsInRow = 0;
		if (tag === "TD" || tag === "TH") {
			// One tab per cell boundary, so empty cells keep later values in their column.
			if (cellsInRow > 0) append("\t");
			cellsInRow++;
		}
		const breaks = tag === "P" ? 2 : BLOCK_TAGS[tag] ? 1 : 0;
		pendingBreaks = Math.max(pendingBreaks, breaks);
		for (const child of node.childNodes) walk(child, pre || tag === "PRE");
		pendingBreaks = Math.max(pendingBreaks, breaks);
	};
	walk(root, root.parentElement?.closest("pre") != null);
	return parts.join("").trimEnd();
}

export async function extractReadableFromHtml(
	html: string,
	url: string,
	format: ReadableFormat,
): Promise<ReadableResult | null> {
	const [{ parseHTML }, { Readability }] = await Promise.all([loadDom(), loadReadability()]);
	const { document } = parseHTML(html);

	const article = new Readability(document).parse();
	if (article) {
		const body =
			format === "text" && article.content ? parseHTML(`<body>${article.content}</body>`).document.body : null;
		const result = await toReadableResult(
			url,
			format,
			body ? blockText(body) : article.textContent,
			article.content,
			{
				title: article.title,
				byline: article.byline,
				excerpt: article.excerpt,
				length: article.length,
			},
		);
		if (result) return result;
	}

	const candidates = [
		document.querySelector("[data-pagefind-body]"),
		document.querySelector("main article"),
		document.querySelector("article"),
		document.querySelector("main"),
		document.querySelector("[role='main']"),
		document.body,
	];
	for (const el of candidates) {
		if (!el) continue;
		const innerHTML = el.innerHTML?.trim();
		const textContent = format === "text" ? blockText(el) : el.textContent?.trim();
		if (!innerHTML || !textContent) continue;
		const result = await toReadableResult(url, format, textContent, innerHTML, {
			title: document.title,
			excerpt: textContent.slice(0, 240),
			length: textContent.length,
		});
		if (result) return result;
	}

	return null;
}

async function toReadableResult(
	url: string,
	format: ReadableFormat,
	textContent: string | null | undefined,
	htmlContent: string | null | undefined,
	meta: { title?: string | null; byline?: string | null; excerpt?: string | null; length?: number | null },
): Promise<ReadableResult | null> {
	const text = format === "text" ? textContent?.trimEnd() || undefined : normalize(textContent);
	const markdown =
		format === "markdown" ? (normalize(await htmlToBasicMarkdown(htmlContent ?? "")) ?? text) : undefined;
	const normalizedText = format === "text" ? text : undefined;
	if (!normalizedText && !markdown) return null;
	return {
		url,
		title: normalize(meta.title),
		byline: normalize(meta.byline),
		excerpt: normalize(meta.excerpt),
		contentLength: (normalizedText ?? markdown)?.length ?? 0,
		text: normalizedText,
		markdown,
	};
}
