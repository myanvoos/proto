import { expect, test } from "bun:test";
import { initThemeSync, theme } from "../../modes/theme/theme";
import { renderSearchResult } from "./render";

initThemeSync();

function strip(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// The model-facing transcript a provider without an answer returns: a heading, a count and an
// indented listing of the same sources that also arrive structured in `details.response.sources`.
const SOURCE_TRANSCRIPT = [
	"## Sources",
	"2 sources",
	"[1] TUI Rendering Engine",
	"    https://example.com/one",
	"    A snippet long enough that a reflow would move its continuation to the card margin.",
	"[2] TUI Components",
	"    https://example.com/two",
	"    Another snippet.",
].join("\n");

const SOURCES = [
	{ title: "TUI Rendering Engine", url: "https://example.com/one", snippet: "A snippet." },
	{ title: "TUI Components", url: "https://example.com/two", snippet: "Another snippet." },
];

function render(response: Record<string, unknown>, text: string): string[] {
	const component = renderSearchResult(
		{ content: [{ type: "text", text }], details: { response } } as never,
		{ expanded: false, isPartial: false } as never,
		theme,
		{ query: "tui rendering" },
	);
	return component.render(100).map(strip);
}

test("a provider with sources and no answer does not replay the listing as the answer", () => {
	const lines = render({ provider: "duckduckgo", sources: SOURCES }, SOURCE_TRANSCRIPT);
	const joined = lines.join("\n");

	expect(joined).toContain("No answer text returned");
	// The transcript's own heading must not masquerade as a section label, and its indented
	// listing must not be reflowed into the Answer body.
	expect(joined).not.toContain("## Sources");
	expect(joined).not.toContain("[1] TUI Rendering Engine");
	expect(joined).not.toContain("would move its continuation");

	// The structured sources are still shown, once.
	expect(joined).toContain("Sources");
	expect(joined.match(/TUI Rendering Engine/g)?.length).toBe(1);
});

test("a real answer is still rendered", () => {
	const lines = render({ provider: "perplexity", sources: SOURCES, answer: "Proto renders TUIs." }, "ignored");
	expect(lines.join("\n")).toContain("Proto renders TUIs.");
});

test("with no sources at all the raw text is still the fallback answer", () => {
	const lines = render({ provider: "none", sources: [] }, "Nothing structured, just prose.");
	expect(lines.join("\n")).toContain("Nothing structured, just prose.");
});
