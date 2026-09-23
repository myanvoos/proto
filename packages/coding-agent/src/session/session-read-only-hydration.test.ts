/**
 * Read-only transcripts (history://, subagent transcript views) used to hydrate every image blob in the file before
 * collapsing to the latest compaction, so long or remotely compacted sessions stalled on I/O for images the view
 * never shows. Only the retained transcript is hydrated now.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BlobStore } from "./blob-store";
import type { CompactionEntry, SessionMessageEntry } from "./session-entries";
import { loadSessionMessagesReadOnly } from "./session-loader";

const timestamp = new Date(0).toISOString();
const header = { type: "session", version: 3, id: "session", timestamp, cwd: "/tmp" };
const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function imageEntry(id: string, parentId: string | null, data: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content: [{ type: "image", data, mimeType: "image/png" }], timestamp: 0 },
	};
}

async function setup(): Promise<{ dir: string; store: BlobStore; reads: string[] }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-read-only-hydration-"));
	tempDirs.push(dir);
	const store = new BlobStore(path.join(dir, "blobs"));
	const get = store.get.bind(store);
	const reads: string[] = [];
	vi.spyOn(BlobStore.prototype, "get").mockImplementation(async hash => {
		reads.push(hash);
		return get(hash);
	});
	return { dir, store, reads };
}

async function writeSession(dir: string, entries: unknown[]): Promise<string> {
	const file = path.join(dir, "session.jsonl");
	await Bun.write(file, `${[header, ...entries].map(value => JSON.stringify(value)).join("\n")}\n`);
	return file;
}

describe("read-only session hydration", () => {
	it("reads only images the transcript retains past a reset boundary", async () => {
		const { dir, store, reads } = await setup();
		const discarded = await store.put(Buffer.from("discarded"));
		const retained = await store.put(Buffer.from("retained"));
		const file = await writeSession(dir, [
			imageEntry("old", null, discarded.ref),
			{ type: "reset_boundary", id: "reset", parentId: "old", timestamp },
			imageEntry("visible", "reset", retained.ref),
		]);

		const messages = await loadSessionMessagesReadOnly(file);

		expect(reads).toEqual([retained.hash]);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			content: [{ type: "image", data: Buffer.from("retained").toString("base64") }],
		});
	});

	it("reads no image hidden before a compaction or in its remote replacement history", async () => {
		const { dir, store, reads } = await setup();
		const compactedAway = await store.put(Buffer.from("compacted away"));
		const hidden = await store.put(Buffer.from("data:image/png;base64,aGlkZGVu"));
		const compaction: CompactionEntry = {
			type: "compaction",
			id: "compact",
			parentId: "keep",
			timestamp,
			firstKeptEntryId: "keep",
			summary: "remote summary",
			tokensBefore: 1000,
			preserveData: {
				openaiRemoteCompaction: {
					provider: "openai",
					replacementHistory: [
						{ type: "message", role: "user", content: [{ type: "input_image", image_url: hidden.ref }] },
					],
				},
			},
		};
		const file = await writeSession(dir, [
			imageEntry("old", null, compactedAway.ref),
			{
				type: "message",
				id: "keep",
				parentId: "old",
				timestamp,
				message: { role: "user", content: "keep", timestamp: 0 },
			},
			compaction,
		]);

		const messages = await loadSessionMessagesReadOnly(file);

		expect(reads).toEqual([]);
		expect(messages.map(message => message.role)).toEqual(["user", "compactionSummary"]);
		expect(messages[1]).toMatchObject({ summary: "remote summary" });
	});
});
