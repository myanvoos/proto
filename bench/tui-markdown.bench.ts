import { initThemeSync } from "../packages/coding-agent/src/modes/theme/theme";
import { getMarkdownTheme } from "../packages/coding-agent/src/modes/theme/tui-adapters";
import { Markdown } from "../packages/tui/src/components/markdown";
import { formatArtifact, runSuite } from "./harness";

// The production theme, because the highlighter is most of the cost: an identity theme measures a
// configuration no user ever runs and understates streamed code blocks by roughly an order of magnitude.
initThemeSync();
const theme = getMarkdownTheme();

const WIDTH = 80;

/** Streams `text` into a fresh component in chunks of `chunkLines` lines, rendering after each append. */
function streamMarkdown(text: string, chunkLines: number): void {
	const lines = text.split("\n");
	const component = new Markdown("", 0, 0, theme, undefined, 2, false);
	component.transientRenderCache = true;
	let current = "";
	for (let i = 0; i < lines.length; i += chunkLines) {
		current += `${lines.slice(i, i + chunkLines).join("\n")}\n`;
		component.setText(current);
		component.render(WIDTH);
	}
}

function codeBlockSource(lineCount: number): string {
	const lines: string[] = [];
	for (let i = 0; i < lineCount; i++) {
		lines.push(`const value${i} = compute(alpha${i}, beta${i}); // streamed line ${i}`);
	}
	return ["```ts", ...lines, "```"].join("\n");
}

/** Realistic long assistant reply: prose blocks (each blank-line terminated) plus a closed code block. */
function assistantMessage(): string {
	const blocks: string[] = [];
	blocks.push("## Refactor plan");
	blocks.push(
		"The cache is keyed by source offset, so settled blocks freeze while the tail keeps mutating. " +
			"Each paragraph below is long enough to wrap across several terminal rows at width 80, which " +
			"makes the reuse path carry real weight instead of trivially passing through short lines.",
	);
	blocks.push("```ts\nexport function settle(fragment: string): string {\n\treturn fragment.trim();\n}\n```");
	for (let i = 0; i < 60; i++) {
		blocks.push(
			"- item " +
				i +
				": the renderer must keep appending rows without re-wrapping the ones that " +
				"already settled, otherwise long transcripts stall the pane while the model is still " +
				"streaming tokens into the transcript view.",
		);
		blocks.push(
			"Paragraph " +
				i +
				" follows the list and closes with a blank line so the block boundary " +
				"scanner can freeze it. The quick brown fox jumps over the lazy dog while the stream " +
				"keeps flowing and the differential renderer only repaints what actually changed.",
		);
	}
	blocks.push("Done.");
	return `${blocks.join("\n\n")}\n`;
}

const proseMessage = assistantMessage();

const artifact = await runSuite("tui-markdown", [
	{
		name: "stream-code-200-lines",
		setup: () => `${codeBlockSource(200)}\n`,
		run: text => streamMarkdown(text, 1),
		runs: 10,
		warmup: 2,
	},
	{
		name: "stream-code-1000-lines",
		setup: () => `${codeBlockSource(1000)}\n`,
		run: text => streamMarkdown(text, 1),
		runs: 5,
		warmup: 1,
	},
	{
		name: "stream-code-4000-lines",
		setup: () => `${codeBlockSource(4000)}\n`,
		run: text => streamMarkdown(text, 4),
		runs: 3,
		warmup: 1,
	},
	{
		name: "stream-assistant-message",
		setup: () => proseMessage,
		run: text => streamMarkdown(text, 1),
		runs: 10,
		warmup: 2,
	},
]);

console.log(formatArtifact(artifact));
