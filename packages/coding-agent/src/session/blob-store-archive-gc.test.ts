import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { BlobStore, sweepUnreferencedBlobs } from "./blob-store";
import { loadSessionFile } from "./session-loader";

let root: string | undefined;

afterEach(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
	root = undefined;
});

async function setup(): Promise<{ blobs: string; sessions: string }> {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-blob-archive-gc-"));
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

function archiveText(sessionFile: string, sessionId: string, recordLines: string[]): string {
	return gzipSync(
		Buffer.from(
			JSON.stringify({
				version: 1,
				sessionId,
				sessionFile,
				records: recordLines.map((line, index) => ({ id: `entry-${index}`, beforeId: null, line })),
			}),
			"utf8",
		),
	).toString("base64");
}

test("archive-only blob references survive GC and remain readable", async () => {
	const { blobs, sessions } = await setup();
	const store = new BlobStore(blobs);
	const payload = Buffer.from("archived image replay payload");
	const blob = await store.put(payload);
	const sessionFile = path.join(sessions, "session.jsonl");
	const archivedRow = JSON.stringify({ id: "entry-0", message: { content: [{ type: "image", data: blob.ref }] } });
	await fs.writeFile(`${sessionFile}.archive.jsonl.gz`, archiveText(sessionFile, "session-id", [archivedRow]));
	await fs.writeFile(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 4, id: "session-id", timestamp: "2026-09-24T00:00:00.000Z", cwd: root })}\n`,
	);
	await age(blob.path);

	const result = await sweepUnreferencedBlobs(blobs, sessions, { graceMs: 0 });

	expect(result.aborted).toBe(false);
	expect(result.removed).toBe(0);
	const loaded = await loadSessionFile(sessionFile);
	expect(loaded.entries.some(entry => entry.id === "entry-0")).toBe(true);
	expect(await store.get(blob.hash)).toEqual(payload);
});

test("corrupt archive makes blob GC fail closed", async () => {
	const { blobs, sessions } = await setup();
	const store = new BlobStore(blobs);
	const blob = await store.put(Buffer.from("archive protected"));
	await fs.writeFile(path.join(sessions, "session.jsonl.archive.jsonl.gz"), "not base64 gzip");
	await age(blob.path);

	const result = await sweepUnreferencedBlobs(blobs, sessions, { graceMs: 0 });

	expect(result.aborted).toBe(true);
	expect(result.removed).toBe(0);
	expect(await store.has(blob.hash)).toBe(true);
});
