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
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-blob-regressions-"));
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

function archiveText(sessionFile: string, sessionId: string, row: string): string {
	return gzipSync(
		Buffer.from(
			JSON.stringify({
				version: 1,
				sessionId,
				sessionFile,
				records: [{ id: "entry-0", beforeId: null, line: row }],
			}),
		),
	).toString("base64");
}

test("put racing the final GC recheck cannot lose its published blob", async () => {
	const { blobs, sessions } = await setup();
	const store = new BlobStore(blobs);
	const payload = Buffer.from("racing payload");
	const blob = await store.put(payload);
	await age(blob.path);

	let releaseUnlink!: () => void;
	let atUnlink!: () => void;
	const unlinkGate = new Promise<void>(resolve => (releaseUnlink = resolve));
	const unlinkReached = new Promise<void>(resolve => (atUnlink = resolve));
	const originalUnlink = fs.unlink;
	const unlinkSpy = spyOn(fs, "unlink").mockImplementation(async file => {
		if (file === blob.path) {
			atUnlink();
			await unlinkGate;
		}
		return originalUnlink(file);
	});
	try {
		const sweep = sweepUnreferencedBlobs(blobs, sessions, { graceMs: 0 });
		await unlinkReached;
		const put = store.put(payload);
		releaseUnlink();
		await Promise.all([sweep, put]);
	} finally {
		releaseUnlink();
		unlinkSpy.mockRestore();
	}

	expect(await store.get(blob.hash)).toEqual(payload);
});

test("oversized archive aborts GC without deleting archive-referenced blobs", async () => {
	const { blobs, sessions } = await setup();
	const store = new BlobStore(blobs);
	const blob = await store.put(Buffer.from("oversized archive protected"));
	const sessionFile = path.join(sessions, "session.jsonl");
	const row = JSON.stringify({ id: "entry-0", message: { content: [{ type: "image", data: blob.ref }] } });
	const archive = archiveText(sessionFile, "session-id", row);
	await fs.writeFile(`${sessionFile}.archive.jsonl.gz`, `${archive}${" ".repeat(17 * 1024 * 1024)}`);
	await fs.writeFile(sessionFile, "{}\n");
	await age(blob.path);

	const result = await sweepUnreferencedBlobs(blobs, sessions, { graceMs: 0 });

	expect(result.aborted).toBe(true);
	expect(result.removed).toBe(0);
	expect(await store.has(blob.hash)).toBe(true);
});
