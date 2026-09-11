#!/usr/bin/env bun
/**
 * Real-TUI session-browser switch latency: spawns the actual coding-agent TUI
 * in a pty, opens the session browser via /resume, measures open paint,
 * per-cursor-move repaint, and enter->resumed transcript paint.
 * Run: bun scripts/pty-switch-probe.ts [--moves=12]
 */
const argValue = (flag: string): string | undefined => {
	const prefix = `--${flag}=`;
	return Bun.argv
		.slice(2)
		.find(a => a.startsWith(prefix))
		?.slice(prefix.length);
};
const moves = Number(argValue("moves") ?? "12");

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const proc = Bun.spawn(["script", "-qec", `bun ${cli}`, "/dev/null"], {
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
	env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "1" },
});
const stdin = proc.stdin as unknown as { write: (d: string) => number; end: () => void; flush: () => void };
const decoder = new TextDecoder();
let outBuf = "";
const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
void (async () => {
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			outBuf += decoder.decode(value, { stream: true });
		}
	} catch {}
})();

async function waitForGrow(predicate: (total: number) => boolean, timeoutMs: number): Promise<number | null> {
	const start = performance.now();
	for (;;) {
		if (predicate(outBuf.length)) return performance.now() - start;
		if (performance.now() - start > timeoutMs) return null;
		await Bun.sleep(4);
	}
}

// Wait for composer paint.
await Bun.sleep(2500);
if (!outBuf.includes("\u276f") && !outBuf.includes("|")) {
	console.log(JSON.stringify({ error: "no composer paint", head: outBuf.slice(-400).replace(/\x1b/g, "<E>") }));
	proc.kill();
	process.exit(1);
}

// Open session browser: type /resume + enter.
let mark = outBuf.length;
const t0 = performance.now();
stdin.write("/resume\r");
stdin.flush();
// Overlay paints: session rows contain "ago" (formatDate) or "No sessions".
let openMs: number | null = null;
for (;;) {
	if (outBuf.slice(mark).includes("ago") || outBuf.slice(mark).includes("No sessions")) {
		openMs = performance.now() - t0;
		break;
	}
	if (performance.now() - t0 > 30000) break;
	await Bun.sleep(4);
}

// Cursor moves: down/up arrows repaint the selection.
const moveSamples: number[] = [];
const seq = ["\x1b[B", "\x1b[B", "\x1b[A", "\x1b[B", "\x1b[A", "\x1b[A"];
for (let i = 0; i < Math.min(moves, seq.length * 2); i++) {
	const key = seq[i % seq.length]!;
	const before = outBuf.length;
	const tMove = performance.now();
	stdin.write(key);
	stdin.flush();
	const grew = await waitForGrow(total => total > before, 5000);
	if (grew !== null) moveSamples.push(performance.now() - tMove);
	await Bun.sleep(60);
}

// Select: enter -> status "Resumed session" and transcript paint.
mark = outBuf.length;
const t2 = performance.now();
stdin.write("\r");
stdin.flush();
let switchMs: number | null = null;
for (;;) {
	if (outBuf.slice(mark).includes("Resumed session") || outBuf.slice(mark).includes("Resumed session in")) {
		switchMs = performance.now() - t2;
		break;
	}
	if (performance.now() - t2 > 60000) break;
	await Bun.sleep(4);
}

const sorted = [...moveSamples].sort((a, b) => a - b);
const p = (q: number) =>
	sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(1) : null;
console.log(
	JSON.stringify({
		openMs: openMs === null ? null : +openMs.toFixed(1),
		moves: moveSamples.length,
		moveMs: { p50: p(0.5), p90: p(0.9) },
		switchMs: switchMs === null ? null : +switchMs.toFixed(1),
		switchTail: switchMs === null ? outBuf.slice(-400).replace(/\x1b/g, "<E>") : undefined,
	}),
);

stdin.write("\u0003");
await Bun.sleep(150);
stdin.write("\u0003");
stdin.end();
proc.kill();
await proc.exited;
process.exit(0);
