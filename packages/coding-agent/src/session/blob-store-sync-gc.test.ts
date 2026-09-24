import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { BlobStore, sweepUnreferencedBlobs } from "./blob-store";

let root: string | undefined;

afterEach(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
	root = undefined;
});

async function setup(): Promise<{ blobs: string; sessions: string }> {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-blob-sync-gc-"));
	const blobs = path.join(root, "blobs");
	const sessions = path.join(root, "sessions");
	await fs.mkdir(blobs, { recursive: true });
	await fs.mkdir(sessions, { recursive: true });
	return { blobs, sessions };
}

async function age(file: string): Promise<void> {
	const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
	await fs.utimes(file, old, old);
}

test("putSync during the final reference scan cannot publish a blob that GC then deletes", async () => {
	const { blobs, sessions } = await setup();
	const store = new BlobStore(blobs);
	const payload = Buffer.from("sync publication during GC");
	const blob = await store.put(payload);
	await age(blob.path);

	let releaseScan!: () => void;
	let scanReached!: () => void;
	const scanGate = new Promise<void>(resolve => (releaseScan = resolve));
	const reached = new Promise<void>(resolve => (scanReached = resolve));
	let sessionScans = 0;
	const originalReaddir = fs.readdir;
	const gatedReaddir = async (directory: Parameters<typeof fs.readdir>[0]) => {
		if (directory === sessions && ++sessionScans === 3) {
			scanReached();
			await scanGate;
		}
		return originalReaddir(directory, { withFileTypes: true });
	};
	const readdirSpy = spyOn(fs, "readdir").mockImplementation(gatedReaddir as unknown as typeof fs.readdir);
	try {
		const sweep = sweepUnreferencedBlobs(blobs, sessions, { graceMs: 0 });
		await reached;
		store.putSync(payload);
		releaseScan();
		await sweep;
	} finally {
		releaseScan();
		readdirSpy.mockRestore();
	}

	expect(await store.get(blob.hash)).toEqual(payload);
});

test("oversized decoded archive aborts blob GC", async () => {
	const { blobs, sessions } = await setup();
	const store = new BlobStore(blobs);
	const blob = await store.put(Buffer.from("protected by oversized archive"));
	const sessionFile = path.join(sessions, "session.jsonl");
	const oversizedArchive = gzipSync(
		Buffer.from(
			JSON.stringify({
				version: 1,
				sessionId: "session-id",
				sessionFile,
				records: [
					{
						id: "entry-0",
						beforeId: null,
						line: JSON.stringify({ id: "entry-0", text: "x".repeat(17 * 1024 * 1024) }),
					},
				],
			}),
		),
	).toString("base64");
	await fs.writeFile(`${sessionFile}.archive.jsonl.gz`, oversizedArchive);
	await fs.writeFile(sessionFile, "{}\n");
	await age(blob.path);

	const result = await sweepUnreferencedBlobs(blobs, sessions, { graceMs: 0 });

	expect(result.aborted).toBe(true);
	expect(result.removed).toBe(0);
	expect(await store.has(blob.hash)).toBe(true);
});
