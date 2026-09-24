import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BlobStore, type BlobSweepResult, sweepUnreferencedBlobs } from "./blob-store";

let root: string | undefined;

afterEach(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
	root = undefined;
});

async function setup(): Promise<{ blobs: string; sessions: string }> {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-blob-final-gc-"));
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

test("incomplete per-candidate scan aborts the whole sweep", async () => {
	const { blobs, sessions } = await setup();
	const store = new BlobStore(blobs);
	const candidates = await Promise.all(
		Array.from({ length: 33 }, (_, index) => store.put(Buffer.from(`candidate-${index}`))),
	);
	for (const candidate of candidates) await age(candidate.path);
	const transcript = path.join(sessions, "session.jsonl");
	await fs.writeFile(transcript, "{}\n");

	let transcriptReads = 0;
	const originalReadFile = fs.readFile;
	const readSpy = spyOn(fs, "readFile").mockImplementation((async (file: unknown, ...args: unknown[]) => {
		if (file === transcript && ++transcriptReads === 3) return Buffer.from("{bad json\n");
		return originalReadFile(file as Parameters<typeof fs.readFile>[0], ...(args as []));
	}) as typeof fs.readFile);
	let result: BlobSweepResult;
	try {
		result = await sweepUnreferencedBlobs(blobs, sessions, { graceMs: 0 });
	} finally {
		readSpy.mockRestore();
	}

	expect(result.aborted).toBe(true);
	expect(result.removed).toBe(0);
	for (const candidate of candidates) expect(await store.has(candidate.hash)).toBe(true);
});

test("putSync published during final reference scan survives final synchronous recheck", async () => {
	const { blobs, sessions } = await setup();
	const store = new BlobStore(blobs);
	const payload = Buffer.from("sync publication wins");
	const blob = store.putSync(payload);
	await age(blob.path);
	const transcript = path.join(sessions, "session.jsonl");
	await fs.writeFile(transcript, "{}\n");

	let releaseScan!: () => void;
	let scanReached!: () => void;
	const scanGate = new Promise<void>(resolve => (releaseScan = resolve));
	const reached = new Promise<void>(resolve => (scanReached = resolve));
	let transcriptReads = 0;
	const originalReadFile = fs.readFile;
	const readSpy = spyOn(fs, "readFile").mockImplementation((async (file: unknown, ...args: unknown[]) => {
		const result = await originalReadFile(file as Parameters<typeof fs.readFile>[0], ...(args as []));
		if (file === transcript && ++transcriptReads === 3) {
			scanReached();
			await scanGate;
		}
		return result;
	}) as typeof fs.readFile);
	try {
		const sweep = sweepUnreferencedBlobs(blobs, sessions, { graceMs: 0 });
		await reached;
		store.putSync(payload);
		releaseScan();
		const result = await sweep;
		expect(result.removed).toBe(0);
		expect(await store.get(blob.hash)).toEqual(payload);
	} finally {
		releaseScan();
		readSpy.mockRestore();
	}
});
