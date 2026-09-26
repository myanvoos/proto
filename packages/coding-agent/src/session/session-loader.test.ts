import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BlobStore } from "./blob-store";
import type { FileEntry } from "./session-entries";
import {
	estimateResolvedBlobBytes,
	loadEntriesFromFileStream,
	parseSessionContent,
	resolveBlobRefsInEntries,
	resolveBlobRefsInEntriesSync,
} from "./session-loader";

test("stream loading distinguishes a malformed complete record from a torn final record", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-stream-session-load-"));
	try {
		const completeFile = path.join(dir, "complete.jsonl");
		await Bun.write(completeFile, '{"type":"session","id":"complete"}\n{broken}\n');
		const complete = await loadEntriesFromFileStream(completeFile);
		expect(complete.entries.map(entry => entry.type)).toEqual(["session"]);
		expect(complete.malformedRecords).toBe(1);
		expect(complete.malformedCompleteRecords).toBe(1);

		const tornFile = path.join(dir, "torn.jsonl");
		await Bun.write(tornFile, '{"type":"session","id":"torn"}\n{broken');
		const torn = await loadEntriesFromFileStream(tornFile);
		expect(torn.entries.map(entry => entry.type)).toEqual(["session"]);
		expect(torn.malformedRecords).toBe(1);
		expect(torn.malformedCompleteRecords).toBe(0);

		const incompleteFile = path.join(dir, "incomplete.jsonl");
		await Bun.write(
			incompleteFile,
			'{"type":"session","id":"incomplete","version":3}\n{"type":"custom","id":"torn-tail"',
		);
		const incomplete = await loadEntriesFromFileStream(incompleteFile, { retainEntry: entry => entry });
		expect(incomplete.malformedRecords).toBe(1);
		expect(incomplete.malformedCompleteRecords).toBe(0);
		await Bun.write(
			incompleteFile,
			'{"type":"session","id":"incomplete","version":3}\n{"type":"custom","id":"torn-tail"\n',
		);
		const terminated = await loadEntriesFromFileStream(incompleteFile);
		expect(terminated.malformedCompleteRecords).toBe(1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("large streamed resumes preserve every message exactly across parse batches", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-stream-session-batches-"));
	try {
		const file = path.join(dir, "large.jsonl");
		const records: unknown[] = [
			{ type: "session", version: 3, id: "large", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
		];
		for (let index = 0; index < 2_000; index++) {
			records.push({
				type: "message",
				id: `entry-${index}`,
				parentId: index === 0 ? null : `entry-${index - 1}`,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: {
					role: index % 2 === 0 ? "user" : "developer",
					content: [{ type: "text", text: `${index}: λ界🙂 ${"payload ".repeat(80)}` }],
					timestamp: index,
				},
			});
		}
		const content = `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
		await Bun.write(file, content);

		const { sourceSize, ...streamed } = await loadEntriesFromFileStream(file);
		const fullText = parseSessionContent(content);
		expect(streamed).toEqual(fullText);
		// The freshness token of the next rewrite is the exact snapshot the stream consumed.
		expect(sourceSize).toBe(Buffer.byteLength(content, "utf8"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

class InstrumentedBlobStore extends BlobStore {
	#active = 0;
	#maxActive = 0;
	#calls = new Map<string, number>();
	#startedAtLimit = Promise.withResolvers<void>();
	#release = Promise.withResolvers<void>();
	#limit: number;

	constructor(limit: number) {
		super("/unused");
		this.#limit = limit;
	}

	get maxActive(): number {
		return this.#maxActive;
	}

	get calls(): ReadonlyMap<string, number> {
		return this.#calls;
	}

	get startedAtLimit(): Promise<void> {
		return this.#startedAtLimit.promise;
	}

	release(): void {
		this.#release.resolve();
	}

	override async get(hash: string): Promise<Buffer | null> {
		this.#active++;
		this.#maxActive = Math.max(this.#maxActive, this.#active);
		this.#calls.set(hash, (this.#calls.get(hash) ?? 0) + 1);
		if (this.#active >= this.#limit) this.#startedAtLimit.resolve();
		await this.#release.promise;
		this.#active--;
		return Buffer.from(hash.slice(0, 8));
	}
}

test("blob rehydration bounds reads and deduplicates in-flight hashes", async () => {
	const limit = 8;
	const uniqueHashes = Array.from({ length: 16 }, (_, index) => index.toString(16).padStart(64, "0"));
	const entries = uniqueHashes.flatMap((hash, index) => {
		const image = { type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" };
		const duplicate = { ...image };
		return [
			{
				type: "custom",
				customType: "test",
				id: `entry-${index}`,
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				data: { images: [image, duplicate] },
			},
		] satisfies FileEntry[];
	});
	const blobStore = new InstrumentedBlobStore(limit);
	const resolving = resolveBlobRefsInEntries(entries, blobStore);
	await blobStore.startedAtLimit;
	blobStore.release();
	await resolving;

	expect(blobStore.maxActive).toBeLessThanOrEqual(limit);
	expect(blobStore.calls.size).toBe(uniqueHashes.length);
	for (const count of blobStore.calls.values()) expect(count).toBe(1);
});

test("lazy synchronous hydration matches async image and replay payload resolution without resolving ordinary data", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-sync-session-blobs-"));
	try {
		const store = new BlobStore(dir);
		const image = store.putSync(Buffer.from("image bytes"));
		const url = store.putSync(Buffer.from("data:image/png;base64,aW1hZ2U="));
		const replay = store.putSync(
			Buffer.from(JSON.stringify({ images: [{ data: image.ref, mimeType: "image/png" }] })),
		);
		const broken = store.putSync(Buffer.from("{invalid"));
		const missing = `blob:sha256:${"a".repeat(64)}`;
		const entries: FileEntry[] = [
			{
				type: "custom",
				customType: "replay",
				id: "entry",
				parentId: null,
				timestamp: "now",
				data: {
					content: [{ type: "image", data: image.ref }],
					images: [{ data: image.ref, mimeType: "image/png" }],
					generated: { type: "image_generation_call", result: image.ref },
					url: { image_url: url.ref },
					replay: { __protoReplayBlob: replay.ref },
					broken: { __protoReplayBlob: broken.ref },
					missing: { images: [{ data: missing }] },
					ordinary: { data: image.ref },
				},
			},
		];
		const sync = structuredClone(entries);
		await resolveBlobRefsInEntries(entries, store);
		resolveBlobRefsInEntriesSync(sync, store);
		expect(sync).toEqual(entries);
		expect(sync[0]).toMatchObject({
			data: {
				content: [{ type: "image", data: Buffer.from("image bytes").toString("base64") }],
				url: { image_url: "data:image/png;base64,aW1hZ2U=" },
				replay: { images: [{ data: Buffer.from("image bytes").toString("base64"), mimeType: "image/png" }] },
				broken: { __protoReplayBlob: broken.ref },
				missing: { images: [{ data: missing }] },
				ordinary: { data: image.ref },
			},
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("blob admission estimates expansion without loading blobs and rejects unknowable nested replay size", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-session-blob-estimate-"));
	const store = new BlobStore(dir);
	const read = spyOn(store, "getSync");
	try {
		const blob = store.putSync(Buffer.from("x"));
		const value = {
			images: [
				{ data: blob.ref, mimeType: "image/png" },
				{ data: blob.ref, mimeType: "image/png" },
			],
		};
		const estimate = estimateResolvedBlobBytes(value, store);
		expect(estimate).toBeGreaterThanOrEqual(2 * Buffer.byteLength("eA==", "utf16le"));
		expect(estimateResolvedBlobBytes({ ordinary: { data: blob.ref } }, store)).toBe(0);
		expect(estimateResolvedBlobBytes({ __protoReplayBlob: blob.ref }, store)).toBe(Number.POSITIVE_INFINITY);
		expect(read).not.toHaveBeenCalled();
	} finally {
		read.mockRestore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
