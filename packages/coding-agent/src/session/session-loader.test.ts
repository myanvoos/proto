import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BlobStore } from "./blob-store";
import type { FileEntry } from "./session-entries";
import { loadEntriesFromFileStream, parseSessionContent, resolveBlobRefsInEntries } from "./session-loader";

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

		const streamed = await loadEntriesFromFileStream(file);
		const fullText = parseSessionContent(content);
		expect(streamed).toEqual(fullText);
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
