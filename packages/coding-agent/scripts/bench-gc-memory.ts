import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { getBlobsDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import { runGcCommand } from "../src/cli/gc-cli";

// bun packages/coding-agent/scripts/bench-gc-memory.ts --mib 128 --runs 3
// Fixtures are prepared outside each measured process; each file is one JSONL line.
function option(name: string, fallback: number): number {
	const index = Bun.argv.indexOf(name);
	if (index < 0) return fallback;
	const value = Number(Bun.argv[index + 1]);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	return value;
}

async function writeTranscript(file: string, bytes: number, hash: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	const writer = Bun.file(file).writer();
	const block = "x".repeat(64 * 1024);
	const prefix = `{"type":"message","message":{"content":"blob:sha256:${hash} `;
	const suffix = ` blob:sha256:${hash}"}}\n`;
	try {
		writer.write(prefix);
		let remaining = bytes - prefix.length - suffix.length;
		while (remaining > 0) {
			const count = Math.min(block.length, remaining);
			writer.write(block.slice(0, count));
			await writer.flush();
			remaining -= count;
		}
		writer.write(suffix);
	} finally {
		await writer.end();
	}
}

const mib = option("--mib", 128);
const childIndex = Bun.argv.indexOf("--scan-agent-dir");
if (childIndex >= 0) {
	const agentDir = Bun.argv[childIndex + 1];
	if (!agentDir) throw new Error("Missing isolated fixture directory");
	Bun.gc(true);
	const before = process.memoryUsage();
	const started = performance.now();
	const result = await runGcCommand({ flags: { agentDir, blobs: true, archive: false, wal: false, apply: true } });
	const elapsedMs = performance.now() - started;
	const after = process.memoryUsage();
	Bun.gc(true);
	const collected = process.memoryUsage();
	if (result.blobs?.referenced !== 3 || result.blobs.deleted !== 1 || result.blobs.errors.length !== 0) {
		throw new Error(`Incorrect blob GC result: ${JSON.stringify(result.blobs)}`);
	}
	console.log(
		JSON.stringify({
			benchmark: "gc-blob-scan",
			mibPerTranscript: mib,
			transcripts: ["plain", "gzip-archive", "backup"],
			elapsedMs,
			before,
			after,
			collected,
			maxRssKiB: process.resourceUsage().maxRSS,
			referenced: result.blobs.referenced,
			deleted: result.blobs.deleted,
		}),
	);
} else {
	const runs = option("--runs", 3);
	const agentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "proto-gc-memory-"));
	try {
		const sessionsDir = getSessionsDir(agentDir);
		const archiveDir = path.join(path.dirname(sessionsDir), "archive", "sessions");
		const bytes = mib * 1024 * 1024;
		await writeTranscript(path.join(sessionsDir, "bench", "plain.jsonl"), bytes, "a".repeat(64));
		await writeTranscript(path.join(sessionsDir, "bench", "backup.jsonl.compaction.bak"), bytes, "b".repeat(64));
		const archiveSource = path.join(archiveDir, "bench", "archived.jsonl");
		await writeTranscript(archiveSource, bytes, "c".repeat(64));
		await pipeline(fs.createReadStream(archiveSource), createGzip(), fs.createWriteStream(`${archiveSource}.gz`));
		await fs.promises.unlink(archiveSource);
		for (const letter of ["a", "b", "c"]) {
			const blob = path.join(getBlobsDir(agentDir), letter.repeat(64));
			await Bun.write(blob, `blob-${letter}`);
			const old = new Date(Date.now() - 60 * 60 * 1000);
			await fs.promises.utimes(blob, old, old);
		}
		for (let run = 1; run <= runs; run++) {
			const orphan = path.join(getBlobsDir(agentDir), "d".repeat(64));
			await Bun.write(orphan, "unreferenced");
			const old = new Date(Date.now() - 60 * 60 * 1000);
			await fs.promises.utimes(orphan, old, old);
			const child = Bun.spawn(
				[process.execPath, import.meta.path, "--scan-agent-dir", agentDir, "--mib", String(mib)],
				{ stdout: "pipe", stderr: "inherit" },
			);
			const text = await new Response(child.stdout).text();
			if ((await child.exited) !== 0) throw new Error(`GC measurement ${run} failed:\n${text}`);
			const measurement = text.split("\n").find(line => line.startsWith('{"benchmark":'));
			if (!measurement) throw new Error(`GC measurement missing:\n${text}`);
			console.log(JSON.stringify({ run, ...JSON.parse(measurement) }));
		}
	} finally {
		await fs.promises.rm(agentDir, { recursive: true, force: true });
	}
}
