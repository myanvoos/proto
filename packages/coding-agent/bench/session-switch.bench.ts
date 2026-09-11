/**
 * Session browser switch-latency harness: selector open (list), session open (load),
 * context build, transcript rebuild + full render. Real fixture via --fixture=<file.jsonl>,
 * deterministic synthetic session otherwise; --list-dir=<dir> adds a listing scan.
 * Run: bun bench/session-switch.bench.ts [--fixture=...] [--list-dir=...] [--width=120] [--out=file.json]
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { ChatTranscriptBuilder } from "../src/modes/components/chat-transcript-builder";
import { initThemeSync } from "../src/modes/theme/theme";
import { buildSessionContext } from "../src/session/session-context";
import { SessionManager } from "../src/session/session-manager";

function argValue(flag: string): string | undefined {
	const prefix = `--${flag}=`;
	return process.argv
		.slice(2)
		.find(a => a.startsWith(prefix))
		?.slice(prefix.length);
}

function stats(samples: number[]): { p50: number; p90: number; p99: number; n: number } {
	const sorted = [...samples].sort((a, b) => a - b);
	const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
	return { p50: pick(0.5), p90: pick(0.9), p99: pick(0.99), n: sorted.length };
}

async function makeSyntheticFixture(messages: number): Promise<string> {
	const entry = (id: string, parentId: string | null, message: Record<string, unknown>): string =>
		`${JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(), message })}\n`;
	const lines: string[] = [
		`${JSON.stringify({ type: "session", id: "bench-synth", cwd: os.tmpdir(), timestamp: new Date().toISOString() })}\n`,
	];
	let parent: string | null = null;
	for (let i = 0; i < messages; i++) {
		const id = `msg-${i}`;
		if (i % 2 === 0) {
			lines.push(
				entry(id, parent, {
					role: "user",
					content: `User message ${i}: analyze this code.\n\n\`\`\`typescript\nconst x${i} = ${i};\n\`\`\`\n\n${"detail ".repeat(40)}`,
				}),
			);
		} else {
			lines.push(
				entry(id, parent, {
					role: "assistant",
					content: [
						{
							type: "text",
							text: `Assistant reply ${i}:\n\n- point one\n- point two\n\n\`\`\`ts\nfn(${i});\n\`\`\``,
						},
						{ type: "toolCall", id: `call-${i}`, name: "read_file", arguments: { path: `/tmp/file-${i}.ts` } },
					],
					stopReason: "toolUse",
					api: "bench",
					provider: "bench",
					model: "bench",
					usage: {
						input: 10,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 20,
						cost: { input: 0, output: 0, total: 0 },
					},
				}),
			);
		}
		parent = id;
	}
	const file = path.join(os.tmpdir(), `session-switch-bench-${Date.now()}.jsonl`);
	await Bun.write(file, lines.join(""));
	return file;
}

async function timeAsync(samples: number[], fn: () => Promise<void>): Promise<void> {
	const start = performance.now();
	await fn();
	samples.push(performance.now() - start);
}

const rows: string[] = [];
function row(label: string, s: { p50: number; p90: number; p99: number; n: number }): void {
	const line = `${label}.p50=${s.p50.toFixed(3)}ms p90=${s.p90.toFixed(3)}ms p99=${s.p99.toFixed(3)}ms (n=${s.n})`;
	rows.push(line);
	console.log(line);
}

await Settings.init({ inMemory: true });
initThemeSync();
const width = Number(argValue("width") ?? 120);
const fixtureArg = argValue("fixture");
const listDir = argValue("list-dir");

let fixture = fixtureArg;
let tempDir: string | undefined;
if (!fixture) {
	fixture = await makeSyntheticFixture(2000);
	console.log(`(synthetic fixture: ${fixture})`);
} else {
	// Work on a copy so measurement never touches the real session file.
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-switch-"));
	const copy = path.join(tempDir, path.basename(fixture));
	await fs.copyFile(fixture, copy);
	fixture = copy;
	console.log(`(fixture copy: ${fixture})`);
}

// --- selector open: listing scan (warm module cache; cold = first-run of a fresh process)
if (listDir) {
	const listSamples: number[] = [];
	for (let i = 0; i < 5; i++) await timeAsync(listSamples, () => SessionManager.list(listDir, undefined));
	row("list", stats(listSamples));
}

// --- session open (full JSONL load)
const openSamples: number[] = [];
let manager: SessionManager | undefined;
for (let i = 0; i < 5; i++) {
	await timeAsync(openSamples, async () => {
		manager = await SessionManager.open(fixture!, undefined, undefined, { initialCwd: process.cwd() });
	});
}
if (!manager) throw new Error("session failed to open");
const entries = manager
	.getEntries()
	.filter((e): e is typeof e & { message: NonNullable<(typeof e)["message"]> } => e.type === "message" && !!e.message);
const leafId = entries.at(-1)?.id ?? null;
row("open", stats(openSamples));
console.log(`(entries: ${entries.length})`);

// --- context build
if (leafId) {
	const ctxSamples: number[] = [];
	for (let i = 0; i < 20; i++) {
		const start = performance.now();
		buildSessionContext(entries, leafId);
		ctxSamples.push(performance.now() - start);
	}
	row("context", stats(ctxSamples));
}

// --- transcript rebuild + full render
const builder = new ChatTranscriptBuilder({
	ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
	requestRender: () => {},
});
const rebuildSamples: number[] = [];
const renderSamples: number[] = [];
for (let i = 0; i < 10; i++) {
	const start = performance.now();
	builder.rebuild(entries);
	rebuildSamples.push(performance.now() - start);
	const rstart = performance.now();
	const lines = builder.container.render(width);
	renderSamples.push(performance.now() - rstart);
	if (lines.length === 0) throw new Error("transcript render produced no lines");
}
row("rebuild", stats(rebuildSamples));
row("render", stats(renderSamples));

await manager.close?.();
if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });

const out = argValue("out");
if (out) {
	await Bun.write(out, `${JSON.stringify({ date: new Date().toISOString(), fixture, rows }, null, 2)}\n`);
	console.log(`written: ${out}`);
}
process.exit(0);
