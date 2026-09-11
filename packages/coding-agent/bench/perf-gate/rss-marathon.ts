#!/usr/bin/env bun
/**
 * Marathon RSS harness: drives a real AgentSession with a mock model through
 * hundreds of turns with heavy tool outputs (read/worker/grep payloads) and
 * repeated compaction (forced + usage-driven auto-compaction). Samples RSS
 * per round; the gate is peak RSS (VmHWM) <= 800MB with no runaway growth.
 * Usage: bun bench/perf-gate/rss-marathon.ts [rounds]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { median } from "./lib";

const ROUNDS = Number(process.argv[2] ?? 120);
const TOOL_CALLS_PER_ROUND = 3;
const AUTO_COMPACT_INPUT_TOKENS = 160_000;

function readVmHwmKb(): number {
	const text = fs.readFileSync("/proc/self/status", "utf8");
	const m = text.match(/VmHWM:\s+(\d+) kB/);
	return m ? Number(m[1]) : -1;
}

function bigPayload(kb: number, seed: number): string {
	const line = `payload ${seed}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor `.slice(
		0,
		100,
	);
	let out = "";
	while (out.length < kb * 1024) out += line;
	return out.slice(0, kb * 1024);
}

function textContent(text: string): [{ type: "text"; text: string }] {
	return [{ type: "text", text }];
}

// Tool call counter across the whole marathon; handler pattern:
//   - 1..TOOL_CALLS_PER_ROUND calls in a turn -> toolCall (stopReason toolUse)
//   - then -> final text (stopReason stop) with large token usage to push
//     auto-compaction pressure.
let globalTurnCalls = 0;
let round = 0;
function contextTokens(context: { messages: unknown[] }): number {
	let chars = 0;
	for (const m of context.messages) {
		const content = (m as { content?: unknown }).content;
		if (typeof content === "string") chars += content.length;
		else if (Array.isArray(content)) {
			for (const b of content) {
				if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
					chars += typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text.length : 0;
				}
			}
		}
	}
	return Math.ceil(chars / 4) + 2000;
}

const mockHandler: MockHandler = context => {
	const lastMsg = context.messages[context.messages.length - 1] as { content?: unknown } | undefined;
	const lastText =
		typeof lastMsg?.content === "string"
			? lastMsg.content
			: Array.isArray(lastMsg?.content)
				? lastMsg.content
						.map(b =>
							b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
								? (b as { text: string }).text
								: "",
						)
						.join(" ")
				: "";
	// Compaction summarize prompts embed the branch-summary instruction; answer
	// them small so recovery compaction can complete inside the mock.
	if (lastText.includes("structured summary of the supplied conversation")) {
		return {
			content: textContent("Summary of earlier work: features implemented, tools run, results archived."),
			stopReason: "stop",
			usage: { input: 4000, output: 800, cacheRead: 0, cacheWrite: 0 },
		};
	}
	globalTurnCalls++;
	if (globalTurnCalls % (TOOL_CALLS_PER_ROUND + 1) === 0) {
		round++;
		return {
			content: textContent(`Round ${round} summary: ${bigPayload(3 + (round % 4), round)}`),
			stopReason: "stop",
			usage: {
				input: Math.max(contextTokens(context), AUTO_COMPACT_INPUT_TOKENS),
				output: 1200,
				cacheRead: 0,
				cacheWrite: 0,
			},
		};
	}
	const toolNames = ["fake_read", "fake_worker", "fake_grep"];
	return {
		content: [
			{
				type: "toolCall",
				name: toolNames[globalTurnCalls % toolNames.length] ?? "fake_read",
				arguments: { path: `/tmp/file-${globalTurnCalls}.txt`, kb: 60 + ((globalTurnCalls * 37) % 120) },
			},
		],
		stopReason: "toolUse",
		usage: { input: contextTokens(context), output: 300 },
	};
};

const TOOLS = [
	{
		name: "fake_read",
		label: "fake_read",
		description: "Returns file contents",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, kb: { type: "number" } },
			required: ["path"],
		},
		execute: (_id: string, params: { path: string; kb?: number }) => {
			const kb = params?.kb ?? 100;
			return {
				content: textContent(bigPayload(kb, globalTurnCalls)),
				details: undefined,
			};
		},
	},
	{
		name: "fake_worker",
		label: "fake_worker",
		description: "Simulates a subagent worker output",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, kb: { type: "number" } },
			required: ["path"],
		},
		execute: (_id: string, params: { path: string; kb?: number }) => {
			const kb = params?.kb ?? 80;
			const payload = JSON.stringify({
				worker: "worker-1",
				log: Array.from({ length: kb }, (_, i) => ({ step: i, out: bigPayload(1, i) })),
				result: bigPayload(20, 7),
			});
			return { content: textContent(payload), details: undefined };
		},
	},
	{
		name: "fake_grep",
		label: "fake_grep",
		description: "Returns grep-like matches",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, kb: { type: "number" } },
			required: ["path"],
		},
		execute: (_id: string, params: { path: string; kb?: number }) => {
			const kb = params?.kb ?? 60;
			const lines: string[] = [];
			const i = 0;
			while (lines.join("\n").length < kb * 1024) lines.push(`/src/file${i % 50}.ts:${i}: match text here ${i}`);
			return { content: textContent(lines.join("\n")), details: undefined };
		},
	},
];
void TOOLS;

await Settings.init({ inMemory: true });

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("bundled model missing");

const mock = createMockModel({ handler: mockHandler, provider: "anthropic", id: "claude-sonnet-4-5" });

const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: {
		model,
		systemPrompt: ["Marathon bench"],
		tools: TOOLS as never[],
		messages: [],
	},
	streamFn: mock.stream,
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-marathon-"));
const sessionManager = SessionManager.create(tmpDir, tmpDir);
const authStorage = await AuthStorage.create(":memory:");
authStorage.setRuntimeApiKey("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage);

const session = new AgentSession({
	agent,
	sessionManager,
	settings: Settings.isolated({}),
	modelRegistry,
	sideStreamFn: mock.stream,
});

const rssSeries: number[] = [];
const compactions: number[] = [];
const gcSamplesMs: number[] = [];
let prevMessages = 0;

// Idle baseline: session fully constructed, settled, before any turn runs.
// A short async-GC settle lets the allocator purge transient construction
// high-water, which is what a session sitting idle actually occupies.
Bun.gc(true);
await Bun.sleep(500);
Bun.gc(false);
await Bun.sleep(2000);
Bun.gc(false);
await Bun.sleep(500);
const bootIdleMb = process.memoryUsage().rss / 2 ** 20;
const bootIdleVmHwmMb = readVmHwmKb() / 1024;

const t0 = Date.now();
for (let r = 0; r < ROUNDS; r++) {
	await session.prompt(`marathon round ${r}`);
	// Multi-day sessions compact repeatedly: force a compaction checkpoint
	// every 20 rounds (the /compact path) on top of usage-pressure reporting.
	if ((r + 1) % 20 === 0) {
		await session.compact();
		// Real-live-set GC pause proxy: timed forced full GC with the session
		// transcript and components resident.
		const gcStart = Bun.nanoseconds();
		Bun.gc(true);
		gcSamplesMs.push(Number(Bun.nanoseconds() - gcStart) / 1e6);
	}
	mock.calls.length = 0; // MockModel retains every call context; clear so RSS reflects the app, not the harness
	const msgCount = session.messages.length;
	if (msgCount < prevMessages) compactions.push(r);
	prevMessages = msgCount;
	const mem = process.memoryUsage();
	rssSeries.push(mem.rss / 2 ** 20);
	if (r % 20 === 0) {
		process.stdout.write(
			`  round ${r}: rss ${rssSeries[rssSeries.length - 1]!.toFixed(0)}MB messages ${msgCount} compactions ${compactions.length}\n`,
		);
	}
}
const vmHwmMb = readVmHwmKb() / 1024;
const finalMem = process.memoryUsage();
await session.dispose();
authStorage.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

const sorted = [...rssSeries].sort((a, b) => a - b);
const result = {
	ts: new Date().toISOString(),
	rounds: ROUNDS,
	toolCallsPerRound: TOOL_CALLS_PER_ROUND,
	compactions: compactions.length,
	compactionRounds: compactions,
	gcPauseP50Ms: gcSamplesMs.length ? median(gcSamplesMs) : -1,
	gcPauseSamplesMs: gcSamplesMs,
	durationMs: Date.now() - t0,
	rssMedianMb: sorted[sorted.length >> 1],
	rssMaxMb: sorted[sorted.length - 1],
	bootIdleMb,
	bootIdleVmHwmMb,
	gate150Mb: bootIdleMb <= 150,
	rssFirst10AvgMb: rssSeries.slice(0, 10).reduce((a, b) => a + b, 0) / Math.min(10, rssSeries.length),
	heapUsedMb: finalMem.heapUsed / 2 ** 20,
	rssFinalMb: finalMem.rss / 2 ** 20,
	vmHwmMb,
	gate800Mb: vmHwmMb <= 800,
};
const file = path.join(import.meta.dir, "results", "rss-marathon.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(result, null, 2));
console.log(
	`rss-marathon: idle ${bootIdleMb.toFixed(0)}MB (gate 150MB: ${result.gate150Mb ? "PASS" : "FAIL"})  VmHWM ${vmHwmMb.toFixed(0)}MB (gate 800MB: ${result.gate800Mb ? "PASS" : "FAIL"})  rss median ${result.rssMedianMb.toFixed(0)}MB  max ${result.rssMaxMb.toFixed(0)}MB  final ${result.rssFinalMb.toFixed(0)}MB  heap ${result.heapUsedMb.toFixed(0)}MB  ${result.durationMs}ms  -> ${file}`,
);
process.exit(result.gate800Mb && result.gate150Mb ? 0 : 1);
