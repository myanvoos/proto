import * as fs from "node:fs/promises";
import * as os from "node:os";
import { ScrollView, type TUI } from "@oh-my-pi/pi-tui";
import { Settings } from "../src/config/settings";
import { AgentTranscriptViewer } from "../src/modes/components/agent-transcript-viewer";
import { TranscriptContainer } from "../src/modes/components/transcript-container";
import { initTheme } from "../src/modes/theme/theme";
import { AgentRegistry } from "../src/registry/agent-registry";

const MESSAGE_COUNT = 2_000;
const MESSAGE_BYTES = 3_800;
const WIDTH = 120;
const WARMUP = 10;
const SAMPLES = 100;

type MemorySample = Pick<NodeJS.MemoryUsage, "rss" | "heapUsed">;

function memorySample(): MemorySample {
	const usage = process.memoryUsage();
	return { rss: usage.rss, heapUsed: usage.heapUsed };
}

function forceSettledGc(): void {
	Bun.gc(true);
}

function makeMessageLine(index: number, body: string): string {
	return JSON.stringify({
		type: "message",
		id: `memory-bench-${index}`,
		parentId: index === 0 ? null : `memory-bench-${index - 1}`,
		timestamp: "2026-09-05T12:00:00.000Z",
		message: {
			role: "user",
			content: `${index.toString().padStart(4, "0")} ${body}`,
			timestamp: 1788609600000 + index,
		},
	});
}

interface RunResult {
	mode: "unconditional" | "revision-gated";
	setLinesCalls: number;
	elapsedMs: number;
	perFrameMs: number;
	before: MemorySample;
	during: MemorySample;
	after: MemorySample;
}

async function run(sessionFile: string, unconditional: boolean): Promise<RunResult> {
	const registry = new AgentRegistry();
	registry.register({
		id: "memory-bench-agent",
		displayName: "memory-bench-agent",
		kind: "sub",
		parentId: "Main",
		status: "parked",
		session: null,
		sessionFile,
	});
	const ui = {
		imageBudget: undefined,
		requestRender: () => {},
		requestComponentRender: () => {},
		resetDisplay: () => {},
	} as unknown as TUI;
	const viewer = new AgentTranscriptViewer({
		agentId: "memory-bench-agent",
		registry,
		ui,
		expandKeys: [],
		fleetKeys: [],
		requestRender: () => {},
		onClose: () => {},
		onFleetClose: () => {},
	});

	let setLinesCalls = 0;
	const originalSetLines = ScrollView.prototype.setLines;
	ScrollView.prototype.setLines = function (this: ScrollView, lines: readonly string[]): void {
		setLinesCalls++;
		originalSetLines.call(this, lines);
	};
	const originalRevision = TranscriptContainer.prototype.getRenderRevision;
	if (unconditional) {
		TranscriptContainer.prototype.getRenderRevision = (): number => Number.NaN;
	}
	try {
		viewer.render(WIDTH);
		for (let i = 0; i < WARMUP; i++) viewer.render(WIDTH);
		forceSettledGc();
		const before = memorySample();
		const start = performance.now();
		for (let i = 0; i < SAMPLES; i++) viewer.render(WIDTH);
		const elapsedMs = performance.now() - start;
		const during = memorySample();
		forceSettledGc();
		const after = memorySample();
		return {
			mode: unconditional ? "unconditional" : "revision-gated",
			setLinesCalls,
			elapsedMs,
			perFrameMs: elapsedMs / SAMPLES,
			before,
			during,
			after,
		};
	} finally {
		TranscriptContainer.prototype.getRenderRevision = originalRevision;
		ScrollView.prototype.setLines = originalSetLines;
		viewer.dispose();
	}
}

await Settings.init({ inMemory: true });
await initTheme("dark");
const directory = await fs.mkdtemp(`${os.tmpdir()}/proto-transcript-cache-bench-`);
try {
	const body = "x".repeat(MESSAGE_BYTES);
	const lines = Array.from({ length: MESSAGE_COUNT }, (_, index) => makeMessageLine(index, body));
	const sessionFile = `${directory}/session.jsonl`;
	await Bun.write(sessionFile, `${lines.join("\n")}\n`);
	const fixtureBytes = (await fs.stat(sessionFile)).size;

	const unconditional = await run(sessionFile, true);
	forceSettledGc();
	const revisionGated = await run(sessionFile, false);
	console.log(
		JSON.stringify(
			{
				fixture: { messages: MESSAGE_COUNT, bytes: fixtureBytes, width: WIDTH },
				warmup: WARMUP,
				samples: SAMPLES,
				runs: [unconditional, revisionGated],
			},
			null,
			2,
		),
	);
} finally {
	await fs.rm(directory, { recursive: true, force: true });
}
