import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BlobStore, sweepUnreferencedBlobs } from "./blob-store";

let root: string | undefined;

afterEach(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
	root = undefined;
});

async function setup(): Promise<{ blobs: string; sessions: string }> {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-blob-gc-"));
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

test("shared blob references in forked session transcripts survive global sweep after source deletion", async () => {
	const { blobs, sessions } = await setup();
	const store = new BlobStore(blobs);
	const blob = await store.put(Buffer.from("shared image"));
	const source = path.join(sessions, "source.jsonl");
	const fork = path.join(sessions, "fork", "fork.jsonl");
	await fs.mkdir(path.dirname(fork), { recursive: true });
	await fs.writeFile(source, JSON.stringify({ image: blob.ref }) + "\n");
	await fs.writeFile(fork, JSON.stringify({ image: blob.ref }) + "\n");
	await fs.rm(source);
	await age(blob.path);

	const result = await sweepUnreferencedBlobs(blobs, sessions, { graceMs: 0 });

	expect(result.removed).toBe(0);
	expect(await store.has(blob.hash)).toBe(true);
});

test("old blobs made unreachable by compaction are removed after the grace period", async () => {
	const { blobs, sessions } = await setup();
	const store = new BlobStore(blobs);
	const blob = await store.put(Buffer.from("compacted image"));
	await age(blob.path);

	const result = await sweepUnreferencedBlobs(blobs, sessions, { graceMs: 24 * 60 * 60 * 1000 });

	expect(result.removed).toBe(1);
	expect(await store.has(blob.hash)).toBe(false);
});

test("foreign blob-directory files and corrupt transcripts are never swept", async () => {
	const { blobs, sessions } = await setup();
	const store = new BlobStore(blobs);
	const blob = await store.put(Buffer.from("potentially referenced image"));
	const foreign = path.join(blobs, "notes.txt");
	await fs.writeFile(foreign, "leave me alone");
	await age(blob.path);
	await fs.writeFile(path.join(sessions, "broken.jsonl"), "{bad json\n");

	const result = await sweepUnreferencedBlobs(blobs, sessions, { graceMs: 0 });

	expect(result.aborted).toBe(true);
	expect(await store.has(blob.hash)).toBe(true);
	expect(await fs.readFile(foreign, "utf8")).toBe("leave me alone");
});

test("fresh blobs and extension display files are left alone", async () => {
	const { blobs, sessions } = await setup();
	const store = new BlobStore(blobs);
	const blob = await store.put(Buffer.from("just written"), { extension: "png" });

	const result = await sweepUnreferencedBlobs(blobs, sessions, { graceMs: 60 * 60 * 1000 });

	expect(result.removed).toBe(0);
	expect(await store.has(blob.hash)).toBe(true);
	expect(await fs.stat(blob.displayPath)).toBeDefined();
});

test("a blob actively being rewritten during sweep is not removed", async () => {
	const { blobs, sessions } = await setup();
	const store = new BlobStore(blobs);
	const payload = Buffer.alloc(4 * 1024 * 1024, 0x5a);
	const original = await store.put(payload);
	await age(original.path);

	const write = store.put(payload);
	const result = await sweepUnreferencedBlobs(blobs, sessions, { graceMs: 0 });
	await write;

	expect(result.removed).toBe(0);
	expect(await store.has(original.hash)).toBe(true);
});
