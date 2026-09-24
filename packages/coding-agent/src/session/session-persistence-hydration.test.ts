import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BlobStore } from "./blob-store";
import type { FileEntry } from "./session-entries";
import { loadEntriesFromFile, resolveBlobRefsInEntries } from "./session-loader";
import { PERSISTED_REPLAY_BLOB_KEY, prepareEntryForPersistence } from "./session-persistence";

function messageEntry(content: unknown[], extra: Record<string, unknown> = {}): FileEntry {
	return {
		type: "message",
		id: "message-1",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "assistant", content, timestamp: 1, ...extra },
	} as unknown as FileEntry;
}

function sessionHeader(): FileEntry {
	return {
		type: "session",
		version: 3,
		id: "session-1",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/tmp",
	};
}

function withBlobStore<T>(run: (store: BlobStore, dir: string) => Promise<T>): Promise<T> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-replay-persistence-"));
	const store = new BlobStore(path.join(dir, "blobs"));
	return run(store, dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test("oversized signed and provider replay payloads spill as bounded blobs and hydrate byte-for-byte", async () => {
	await withBlobStore(async store => {
		const large = "provider reasoning ".repeat(30_000);
		const source = messageEntry(
			[
				{ type: "thinking", thinking: large, thinkingSignature: "thinking-signature" },
				{ type: "text", text: large, textSignature: "text-signature" },
				{ type: "toolCall", name: "run", arguments: large, thoughtSignature: "tool-signature" },
				{ type: "redactedThinking", data: large },
				{ type: "reasoning", encrypted_content: large },
			],
			{ providerPayload: { type: "anthropicCompaction", provider: "anthropic", content: large } },
		);
		const persisted = prepareEntryForPersistence(source, store);
		const encoded = JSON.stringify(persisted);

		expect(encoded.length).toBeLessThan(500_000);
		expect(encoded).toContain(PERSISTED_REPLAY_BLOB_KEY);
		await resolveBlobRefsInEntries([persisted], store);
		expect(persisted).toEqual(source);

		const compaction = {
			type: "compaction",
			id: "compaction-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			summary: "summary",
			firstKeptEntryId: "message-1",
			tokensBefore: 1,
			preserveData: { anthropicCompaction: { provider: "anthropic", content: large } },
		} as unknown as FileEntry;
		const persistedCompaction = prepareEntryForPersistence(compaction, store);
		expect(JSON.stringify(persistedCompaction).length).toBeLessThan(500_000);
		await resolveBlobRefsInEntries([persistedCompaction], store);
		expect(persistedCompaction).toEqual(compaction);

		const normal = messageEntry([{ type: "thinking", thinking: "short", thinkingSignature: "intact-signature" }]);
		expect(prepareEntryForPersistence(normal, store)).toEqual(normal);
	});
});

test("old unbounded replay records remain loadable without a replay blob marker", async () => {
	await withBlobStore(async (_store, dir) => {
		const large = "old provider payload ".repeat(30_000);
		const source = messageEntry([{ type: "thinking", thinking: large, thinkingSignature: "old-signature" }]);
		const file = path.join(dir, "old-session.jsonl");
		await Bun.write(file, `${JSON.stringify(sessionHeader())}\n${JSON.stringify(source)}\n`);

		const loaded = await loadEntriesFromFile(file);
		expect(loaded).toHaveLength(2);
		expect(loaded[1]).toEqual(source);
	});
});

test("image content continues to externalize and hydrate through the existing image blob path", async () => {
	await withBlobStore(async store => {
		const source = messageEntry([{ type: "image", data: "AQID".repeat(600), mimeType: "image/png" }]);
		const persisted = prepareEntryForPersistence(source, store);
		expect(JSON.stringify(persisted).length).toBeLessThan(JSON.stringify(source).length);
		await resolveBlobRefsInEntries([persisted], store);
		expect(persisted).toEqual(source);
	});
});
