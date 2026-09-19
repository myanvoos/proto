import { initThemeSync } from "../packages/coding-agent/src/modes/theme/theme";
import { getMarkdownTheme } from "../packages/coding-agent/src/modes/theme/tui-adapters";
import { Markdown } from "../packages/tui/src/components/markdown";
import { Lexer } from "../packages/utils/src/marked/core";
import { formatArtifact, runSuite } from "./harness";

// Assistant messages are markdown, so the block lexer runs on every render of every message. Its cost has
// to scale with the number of blocks, not with the square of it.
initThemeSync();
const theme = getMarkdownTheme();

function headings(count: number): string {
	return "# x\n".repeat(count);
}

function document(blocks: number): string {
	return Array.from({ length: blocks }, (_, i) => `## Heading ${i}\n\nSome text $x^2$ here.\n`).join("\n");
}

const lexFixtures = new Map([2_000, 8_000, 16_000].map(n => [n, headings(n)]));
// Markdown keeps a global render cache keyed on the text, so every run must use a document it has not seen;
// reusing one fixture would measure the cache instead of the renderer.
let renderRun = 0;

const artifact = await runSuite("markdown-render", [
	...[...lexFixtures.keys()].map(n => ({
		name: `lex-${n}-blocks`,
		runs: 8,
		run: () => Lexer.lex(lexFixtures.get(n)!),
	})),
	...[500, 2_000, 4_000].map(n => ({
		// The full production path: lex, parse, and render to terminal rows at a realistic width.
		name: `render-${n}-blocks`,
		runs: 8,
		run: () => new Markdown(`${document(n)}\n\nrun ${renderRun++}`, 0, 0, theme).render(80),
	})),
]);
process.stdout.write(`${formatArtifact(artifact)}\n`);
