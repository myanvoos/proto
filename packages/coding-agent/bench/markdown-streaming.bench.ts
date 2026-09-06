import { Markdown } from "@oh-my-pi/pi-tui";
import { Settings } from "../src/config/settings";
import { getMarkdownTheme, initTheme } from "../src/modes/theme/theme";

const WIDTH = 100;
const WARMUP_FRAMES = 32;
const FRAMES = 256;
const EPISODES = 7;
const CHUNK_SIZE = 16;
const TAIL =
	"Streaming text preserves **bold**, `code`, and Unicode café 日本語. " +
	"This paragraph completes before the next starts.\n\n";

await Settings.init({ inMemory: true });
await initTheme("dark");
const mdTheme = getMarkdownTheme();

for (const blocks of [100, 1000]) {
	const prefix = Array.from(
		{ length: blocks },
		(_, index) => `Paragraph ${index}: completed **analysis** with a \`code span\` and Unicode café 日本語.\n\n`,
	).join("");
	const tail = TAIL.repeat(Math.ceil(((WARMUP_FRAMES + FRAMES) * CHUNK_SIZE) / TAIL.length));
	const durations: number[] = [];
	let finalRows = 0;
	for (let episode = 0; episode < EPISODES; episode++) {
		const markdown = new Markdown(prefix, 0, 0, mdTheme);
		markdown.transientRenderCache = true;
		markdown.render(WIDTH);
		for (let frame = 1; frame <= WARMUP_FRAMES + FRAMES; frame++) {
			const text = prefix + tail.slice(0, frame * CHUNK_SIZE);
			const start = Bun.nanoseconds();
			markdown.setText(text);
			finalRows = markdown.render(WIDTH).length;
			if (frame > WARMUP_FRAMES) durations.push((Bun.nanoseconds() - start) / 1e6);
		}
	}
	durations.sort((a, b) => a - b);
	const median = durations[Math.floor(durations.length / 2)]!;
	const p95 = durations[Math.floor(durations.length * 0.95)]!;
	console.log(
		JSON.stringify({
			fixture: "Markdown.setText+render append-only paragraphs",
			blocks,
			prefixChars: prefix.length,
			width: WIDTH,
			chunkChars: CHUNK_SIZE,
			warmupFrames: WARMUP_FRAMES,
			frames: FRAMES,
			episodes: EPISODES,
			finalRows,
			medianMs: median,
			p95Ms: p95,
		}),
	);
}
