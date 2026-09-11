/**
 * End-to-end keystroke→terminal-write latency through the DEFAULT async scheduler
 * (cadence included), unlike perf-run which isolates compose cost with syncScheduler.
 * Measures cold first frame + steady-state echo at several transcript sizes.
 * Run: bun bench/input-latency-probe.ts [--keys=120]
 */
import { TUI } from "../src";
import { Editor } from "../src/components/editor";
import { Markdown } from "../src/components/markdown";
import {
	BENCH_ROWS,
	BENCH_WIDTH,
	FakeTerminal,
	makeEditorTheme,
	makeMarkdownCorpus,
	makeMarkdownTheme,
	stats,
} from "./perf-helpers";

function argValue(flag: string): string | undefined {
	const prefix = `--${flag}=`;
	return process.argv
		.slice(2)
		.find(a => a.startsWith(prefix))
		?.slice(prefix.length);
}

class RecordingTerminal extends FakeTerminal {
	lastWriteAt = 0;
	override write(data: string): void {
		this.lastWriteAt = performance.now();
		super.write(data);
	}
}

async function waitForWrite(terminal: RecordingTerminal, since: number, timeoutMs = 2000): Promise<number> {
	while (performance.now() - since > -1 && terminal.lastWriteAt <= since) {
		if (performance.now() - since > timeoutMs)
			throw new Error(
				`no frame within timeout (lastWriteAt=${terminal.lastWriteAt.toFixed(1)} since=${since.toFixed(1)} now=${performance.now().toFixed(1)})`,
			);
		await Bun.sleep(1);
	}
	return terminal.lastWriteAt - since;
}

async function drain(ms: number): Promise<void> {
	await Bun.sleep(ms);
}

const KEYS = Number(argValue("keys") ?? 120);
const CHARS = "abcdefghijklmnopqrstuvwxyz";
const rows: string[] = [];

async function runConfig(blocks: number): Promise<void> {
	const terminal = new RecordingTerminal();
	terminal.columns = BENCH_WIDTH;
	terminal.rows = BENCH_ROWS;
	const tui = new TUI(terminal, false);
	const editor = new Editor(makeEditorTheme());
	editor.focused = true;
	if (blocks > 0) tui.addChild(new Markdown(makeMarkdownCorpus(blocks), 1, 0, makeMarkdownTheme()));
	tui.addChild(editor);
	tui.setFocus(editor);

	const start = performance.now();
	tui.start();
	tui.requestRender(true);
	const firstFrame = await waitForWrite(terminal, start);

	// Warm up: 30 chars, then settle so cadence state is steady.
	for (let i = 0; i < 30; i++) {
		terminal.onInputHandler!(CHARS[i % CHARS.length]!);
		await drain(20);
	}

	const samples: number[] = [];
	for (let i = 0; i < KEYS; i++) {
		const ch = CHARS[i % CHARS.length];
		const t0 = performance.now();
		terminal.onInputHandler!(ch);
		const latency = await waitForWrite(terminal, t0);
		samples.push(latency);
		await drain(6);
		if (i % 20 === 19) {
			// Balance editor growth.
			for (let k = 0; k < 20; k++) terminal.onInputHandler!("\x7f");
			await drain(20);
		}
	}

	const s = stats(samples);
	const line = `blocks=${String(blocks).padStart(4)} firstFrameMs=${firstFrame.toFixed(2)} echo.p50=${s.p50.toFixed(2)}ms p90=${s.p90.toFixed(2)}ms p99=${s.p99.toFixed(2)}ms (n=${s.n})`;
	rows.push(line);
	console.log(line);
	tui.stop();
}

console.log(`input-latency-probe: default scheduler, ${KEYS} keys/config`);
for (const blocks of [0, 40, 200]) await runConfig(blocks);

const out = argValue("out");
if (out) {
	await Bun.write(out, `${rows.join("\n")}\n`);
	console.log(`written: ${out}`);
}
process.exit(0);
