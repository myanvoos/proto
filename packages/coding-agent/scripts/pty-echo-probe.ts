#!/usr/bin/env bun
/**
 * Real-TUI echo latency probe: spawns the actual coding-agent TUI in a pty
 * (via `script`), types keystrokes, and measures time-from-write-to-echo
 * on the pty master. Measures the FULL production stack.
 * Run: bun scripts/pty-echo-probe.ts [--keys=40] [--prompt-text]
 */

const argValue = (flag: string): string | undefined => {
	const prefix = `--${flag}=`;
	return Bun.argv
		.slice(2)
		.find(a => a.startsWith(prefix))
		?.slice(prefix.length);
};
const keys = Number(argValue("keys") ?? "40");

// Find CLI entry.
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
const outResolved = () => {};
const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
void (async () => {
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			outBuf += decoder.decode(value, { stream: true });
			outResolved();
		}
	} catch {}
})();

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	return new Promise(resolve => {
		const start = performance.now();
		const check = (): void => {
			if (predicate()) resolve(true);
			else if (performance.now() - start > timeoutMs) resolve(false);
			else setTimeout(check, 5);
		};
		check();
	});
}

async function typeAndMeasure(ch: string): Promise<number> {
	outBuf = "";
	const t0 = performance.now();
	stdin.write(ch);
	stdin.flush();
	// Echo appears as the char (possibly ANSI-wrapped); accept any output containing it.
	const ok = await waitFor(() => outBuf.includes(ch), 3000);
	return ok ? performance.now() - t0 : Number.NaN;
}

// Wait for the TUI first paint.
await waitFor(() => outBuf.includes("|") || outBuf.includes("\u276f"), 30000);
await Bun.sleep(1500); // let startup settle (MCP, model registry, etc.)

const CHARS = "abcdefghijkmnopqrstuvwxyz";
const samples: number[] = [];
for (let i = 0; i < keys; i++) {
	const ch = CHARS[i % CHARS.length]!;
	const ms = await typeAndMeasure(ch);
	if (Number.isFinite(ms)) samples.push(ms);
	await Bun.sleep(120);
	if (i % 10 === 9) {
		for (let k = 0; k < 10; k++) stdin.write("\u007f");
		stdin.flush();
		await Bun.sleep(300);
	}
}

// Sort stats
const sorted = [...samples].sort((a, b) => a - b);
const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
console.log(
	JSON.stringify({
		keys: samples.length,
		echoMs: { p50: +p(0.5).toFixed(1), p90: +p(0.9).toFixed(1), p99: +p(0.99).toFixed(1) },
	}),
);

stdin.write("\u0003"); // ctrl-c
await Bun.sleep(200);
stdin.write("\u0003");
stdin.end();
proc.kill();
await proc.exited;
process.exit(0);
