import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findMostRecentSession, listSessions } from "../packages/coding-agent/src/session/session-listing";
import { loadSessionFile, parseSessionContent } from "../packages/coding-agent/src/session/session-loader";
import { FileSessionStorage } from "../packages/coding-agent/src/session/session-storage";
import { serializeTitleSlot } from "../packages/coding-agent/src/session/session-title-slot";
import { formatArtifact, runSuite } from "./harness";

// Long sessions are the normal case for this agent, so the paths that touch a whole transcript are the
// ones that decide whether turn 500 feels like turn 5. This suite pins their growth curve.

const SLOT = serializeTitleSlot({ title: "Scale fixture", source: "auto", updatedAt: "2026-09-19T00:00:00.000Z" });
const TOOL_RESULT_TEXT = "x".repeat(2_000);

function messageEntry(index: number): string {
	const role = index % 3 === 0 ? "user" : "assistant";
	const content =
		index % 3 === 2
			? [{ type: "toolCall", id: `call_${index}`, name: "read", arguments: { path: `file-${index}.ts` } }]
			: [{ type: "text", text: `turn ${index}: ${TOOL_RESULT_TEXT}` }];
	return JSON.stringify({ type: "message", message: { role, content, timestamp: index } });
}

let fixtureId = 0;

function buildTranscript(entries: number): string {
	fixtureId++;
	const header = JSON.stringify({
		type: "session",
		id: `bench-${fixtureId}`,
		cwd: "/bench",
		timestamp: new Date(1_700_000_000_000 + fixtureId).toISOString(),
	});
	const lines: string[] = [SLOT.slice(0, -1), header];
	for (let i = 0; i < entries; i++) lines.push(messageEntry(i));
	return `${lines.join("\n")}\n`;
}

async function writeFixture(dir: string, name: string, entries: number): Promise<string> {
	const file = path.join(dir, name);
	await Bun.write(file, buildTranscript(entries));
	return file;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-session-scale-"));
const storage = new FileSessionStorage();
const sizes = [500, 2_000, 8_000] as const;

const parseFixtures = new Map<number, string>();
const fileFixtures = new Map<number, string>();
for (const entries of sizes) {
	parseFixtures.set(entries, buildTranscript(entries));
	fileFixtures.set(entries, await writeFixture(root, `session-${entries}.jsonl`, entries));
}

// A directory of many sessions is what the resume picker walks.
const listingDir = path.join(root, "listing");
await fs.mkdir(listingDir, { recursive: true });
for (let i = 0; i < 200; i++) await writeFixture(listingDir, `list-${i}.jsonl`, 200);

const cases = [
	...sizes.map(entries => ({
		name: `parse-${entries}-entries`,
		runs: 10,
		run: () => parseSessionContent(parseFixtures.get(entries)!),
	})),
	...sizes.map(entries => ({
		name: `load-file-${entries}-entries`,
		runs: 10,
		run: () => loadSessionFile(fileFixtures.get(entries)!, storage),
	})),
	{
		// Warm path: what a re-render of the resume picker costs once the scan cache is populated.
		name: "list-200-sessions-warm",
		runs: 5,
		warmup: 1,
		run: () => listSessions(listingDir, storage),
	},
];

// The cold scan is the number that matters on the first open, and the scan cache is keyed per file, so it
// can only be measured once per directory. Do it before the suite warms anything up.
const coldDir = path.join(root, "cold-listing");
await fs.mkdir(coldDir, { recursive: true });
for (let i = 0; i < 200; i++) await writeFixture(coldDir, `cold-${i}.jsonl`, 200);
const coldStart = Bun.nanoseconds();
const coldSessions = await listSessions(coldDir, storage);
const coldMs = (Bun.nanoseconds() - coldStart) / 1e6;

// Resuming without a breadcrumb calls findMostRecentSession and then the picker lists the same directory.
// Both walk the same files, so this measures whether the expensive scan is shared or paid twice.
const resumeDir = path.join(root, "resume-listing");
await fs.mkdir(resumeDir, { recursive: true });
for (let i = 0; i < 100; i++) await writeFixture(resumeDir, `resume-${i}.jsonl`, 200);
const resumeStart = Bun.nanoseconds();
await findMostRecentSession(resumeDir, storage);
await listSessions(resumeDir, storage);
const resumeMs = (Bun.nanoseconds() - resumeStart) / 1e6;

const artifact = await runSuite("session-scale", cases);
process.stdout.write(`${formatArtifact(artifact)}\n`);
process.stdout.write(`cold list of ${coldSessions.length} sessions (200 entries each): ${coldMs.toFixed(1)} ms\n`);
process.stdout.write(`cold findMostRecentSession + listSessions over 100 sessions: ${resumeMs.toFixed(1)} ms\n`);

// Growth check: doubling the transcript should roughly double the work, not quadruple it.
const parseTimes = sizes.map(entries => artifact.cases.find(c => c.name === `parse-${entries}-entries`)!.median);
process.stdout.write(
	`parse growth 500->2000: ${(parseTimes[1]! / parseTimes[0]!).toFixed(2)}x for 4x input; ` +
		`2000->8000: ${(parseTimes[2]! / parseTimes[1]!).toFixed(2)}x for 4x input\n`,
);

await fs.rm(root, { recursive: true, force: true });
