import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { getBlobsDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import { runGcCommand } from "./gc-cli";

const tempDirs: string[] = [];
const old = new Date("2020-01-01T00:00:00Z");

async function fixture() {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-gc-blob-scan-"));
	tempDirs.push(agentDir);
	const sessionsDir = getSessionsDir(agentDir);
	return {
		agentDir,
		sessionsDir,
		archiveDir: path.join(path.dirname(sessionsDir), "archive", "sessions"),
		blobsDir: getBlobsDir(agentDir),
	};
}

async function writeBlob(blobsDir: string, hash: string): Promise<string> {
	const file = path.join(blobsDir, hash);
	await Bun.write(file, "blob");
	await fs.utimes(file, old, old);
	return file;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("blob GC streaming reference scan", () => {
	it("keeps refs split anywhere in giant single-line plain, gzip archive, and backup transcripts", async () => {
		const { agentDir, sessionsDir, archiveDir, blobsDir } = await fixture();
		const blockBytes = 64 * 1024;
		const refLength = "blob:sha256:".length + 64;
		const live: string[] = [];
		const transcriptFiles = [
			path.join(sessionsDir, "project", "plain.jsonl"),
			path.join(archiveDir, "project", "archived.jsonl.gz"),
			path.join(sessionsDir, "project", "parent", "backup.jsonl.compaction.bak"),
		];
		for (const [kind, file] of transcriptFiles.entries()) {
			const bytes = Buffer.alloc(refLength * blockBytes, "x");
			bytes.write('{"type":"message","message":{"content":"');
			const suffix = '"}}\n';
			bytes.write(suffix, bytes.length - suffix.length);
			for (let split = 1; split < refLength; split++) {
				const hash = (0xabcd + kind * refLength + split).toString(16).padStart(64, "0");
				const ref = `BLOB:SHA256:${hash.toUpperCase()}`;
				bytes.write(` ${ref} `, split * blockBytes - split - 1);
				live.push(await writeBlob(blobsDir, hash));
			}
			await Bun.write(file, file.endsWith(".gz") ? gzipSync(bytes) : bytes);
		}
		const orphan = await writeBlob(blobsDir, "f".repeat(64));
		const result = await runGcCommand({ flags: { agentDir, blobs: true, archive: false, wal: false, apply: true } });
		expect(result.blobs?.referenced).toBe(live.length);
		expect(result.blobs?.deleted).toBe(1);
		expect(result.blobs?.errors).toEqual([]);
		for (const file of live) expect(await Bun.file(file).exists()).toBe(true);
		expect(await Bun.file(orphan).exists()).toBe(false);
	});

	it("does not retain word-boundary lookalikes at chunk edges or a cropped overlap", async () => {
		const { agentDir, sessionsDir, blobsDir } = await fixture();
		const blockBytes = 64 * 1024;
		const hashes = ["1", "2", "3", "4", "5", "6"].map(value => value.repeat(64));
		const bytes = Buffer.alloc(7 * blockBytes, "x");
		bytes.write('{"type":"message","message":{"content":"');
		const ref = (index: number) => `blob:sha256:${hashes[index]}`;
		// The preceding word character is in the previous chunk.
		bytes.write(`${ref(0)} `, blockBytes);
		// The following word character is in the next chunk.
		bytes.write(` ${ref(1)}_`, 2 * blockBytes - ref(1).length - 1);
		// The first scan rejects the leading x; cropping it must not create a new match.
		bytes.write(`x${ref(2)} `, 3 * blockBytes - ref(2).length - 2);
		// A 65th hex digit is not a boundary, even when it lands in the next chunk.
		bytes.write(` ${ref(3)}a `, 4 * blockBytes - ref(3).length - 1);
		// Valid boundaries include a split UTF-8 character, not only ASCII punctuation.
		bytes.write(`é${ref(4)} `, 5 * blockBytes - 1);
		// An actual delimiter after the last hash byte must make the reference live.
		bytes.write(` ${ref(5)} `, 6 * blockBytes - ref(5).length - 1);
		bytes.write('"}}\n', bytes.length - 4);
		await Bun.write(path.join(sessionsDir, "edges.jsonl"), bytes);
		const blobs = await Promise.all(hashes.map(hash => writeBlob(blobsDir, hash)));
		const result = await runGcCommand({ flags: { agentDir, blobs: true, archive: false, wal: false, apply: true } });
		expect(result.blobs?.referenced).toBe(2);
		expect(result.blobs?.deleted).toBe(4);
		for (const [index, file] of blobs.entries()) expect(await Bun.file(file).exists()).toBe(index >= 4);
	});

	it("accepts complete references at EOF and never joins incomplete references between files", async () => {
		const { agentDir, sessionsDir, archiveDir, blobsDir } = await fixture();
		const start = "a".repeat(64);
		const eof = "b".repeat(64);
		const incomplete = "c".repeat(64);
		const split = "d".repeat(64);
		await Bun.write(path.join(sessionsDir, "a.jsonl"), `blob:sha256:${start}`);
		await Bun.write(
			path.join(archiveDir, "eof.jsonl.gz"),
			gzipSync(`${"x".repeat(64 * 1024 - 77)} blob:sha256:${eof}`),
		);
		await Bun.write(path.join(archiveDir, "incomplete.jsonl.saved.bak"), `blob:sha256:${incomplete.slice(0, 63)}`);
		await Bun.write(path.join(sessionsDir, "b.jsonl"), `blob:sha256:${split.slice(0, 32)}`);
		await Bun.write(path.join(sessionsDir, "c.jsonl"), split.slice(32));
		await Bun.write(path.join(sessionsDir, "empty.jsonl"), "");
		const hashes = [start, eof, incomplete, split];
		const blobs = await Promise.all(hashes.map(hash => writeBlob(blobsDir, hash)));
		const result = await runGcCommand({ flags: { agentDir, blobs: true, archive: false, wal: false, apply: true } });
		expect(result.blobs?.referenced).toBe(2);
		expect(result.blobs?.deleted).toBe(2);
		for (const [index, file] of blobs.entries()) expect(await Bun.file(file).exists()).toBe(index < 2);
	});

	it("keeps every blob and releases the GC lock when a gzip archive is truncated", async () => {
		const { agentDir, sessionsDir, archiveDir, blobsDir } = await fixture();
		const liveHash = "a".repeat(64);
		const orphanHash = "b".repeat(64);
		const live = await writeBlob(blobsDir, liveHash);
		const orphan = await writeBlob(blobsDir, orphanHash);
		await Bun.write(path.join(sessionsDir, "live.jsonl"), `blob:sha256:${liveHash}`);
		const compressed = gzipSync(`blob:sha256:${liveHash} ${"x".repeat(2 * 1024 * 1024)}`);
		const archive = path.join(archiveDir, "truncated.jsonl.gz");
		await Bun.write(archive, compressed.subarray(0, compressed.length - 8));
		await expect(
			runGcCommand({ flags: { agentDir, blobs: true, archive: false, wal: false, apply: true } }),
		).rejects.toThrow();
		expect(await Bun.file(live).exists()).toBe(true);
		expect(await Bun.file(orphan).exists()).toBe(true);
		await Bun.write(archive, compressed);
		const retry = await runGcCommand({ flags: { agentDir, blobs: true, archive: false, wal: false, apply: true } });
		expect(retry.blobs?.deleted).toBe(1);
		expect(await Bun.file(live).exists()).toBe(true);
		expect(await Bun.file(orphan).exists()).toBe(false);
	});

	it("keeps every blob when a gzip archive has a corrupt checksum", async () => {
		const { agentDir, archiveDir, blobsDir } = await fixture();
		const hash = "e".repeat(64);
		const orphan = await writeBlob(blobsDir, hash);
		const compressed = gzipSync(`blob:sha256:${"f".repeat(64)} ${"x".repeat(2 * 1024 * 1024)}`);
		compressed[compressed.length - 8] = compressed[compressed.length - 8]! ^ 0xff;
		await Bun.write(path.join(archiveDir, "corrupt.jsonl.gz"), compressed);
		await expect(
			runGcCommand({ flags: { agentDir, blobs: true, archive: false, wal: false, apply: true } }),
		).rejects.toThrow();
		expect(await Bun.file(orphan).exists()).toBe(true);
	});
});
