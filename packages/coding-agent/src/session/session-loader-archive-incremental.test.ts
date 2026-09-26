import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import type { SessionEntry, SessionHeader } from "./session-entries";
import {
	appendSessionArchive,
	loadSessionArchive,
	loadSessionFile,
	type SessionArchive,
	sessionArchivePath,
	visitEntriesFromFile,
} from "./session-loader";
import { FileSessionStorage, MemorySessionStorage, SessionWriteConflictError } from "./session-storage";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function message(id: string, content = id): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-26T00:00:00.000Z",
		message: { role: "user", content, timestamp: 0 },
	};
}

async function fixture() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-incremental-archive-"));
	dirs.push(dir);
	const file = path.join(dir, "session.jsonl");
	const storage = new FileSessionStorage();
	const header: SessionHeader = {
		type: "session",
		id: "session",
		version: 3,
		cwd: dir,
		timestamp: "2026-09-26T00:00:00.000Z",
	};
	await storage.writeText(file, `${JSON.stringify(header)}\n${JSON.stringify(message("keep"))}\n`);
	const batch = (id: string, beforeId: string | null): SessionArchive => ({
		version: 1,
		sessionId: "session",
		sessionFile: file,
		records: [{ id, beforeId, line: JSON.stringify(message(id)) }],
	});
	return { storage, file, header, batch };
}

test("compaction appends only its new compressed batch and rejects a stale writer without changing durable history", async () => {
	const { storage, file, batch } = await fixture();
	const firstSize = await appendSessionArchive(file, storage, batch("old", "keep"), null);
	const firstBytes = await Bun.file(sessionArchivePath(file)).text();
	const reads = spyOn(storage, "readText");
	const ranges = spyOn(storage, "readTextRange");
	const rewrites = spyOn(storage, "writeTextAtomic");
	const appends = spyOn(storage, "appendTextAtomic");
	try {
		const next = await appendSessionArchive(file, storage, batch("later", "keep"), firstSize);
		expect(reads).not.toHaveBeenCalled();
		expect(ranges).not.toHaveBeenCalled();
		expect(rewrites).not.toHaveBeenCalled();
		expect(appends).toHaveBeenCalledTimes(1);
		const bytes = await Bun.file(sessionArchivePath(file)).text();
		expect(bytes.slice(0, firstSize)).toBe(firstBytes);
		expect(Buffer.byteLength(bytes)).toBe(next);
		await expect(appendSessionArchive(file, storage, batch("stale", "keep"), firstSize)).rejects.toBeInstanceOf(
			SessionWriteConflictError,
		);
		expect(await Bun.file(sessionArchivePath(file)).text()).toBe(bytes);
	} finally {
		reads.mockRestore();
		ranges.mockRestore();
		rewrites.mockRestore();
		appends.mockRestore();
	}
	expect((await loadSessionFile(file)).entries.map(entry => entry.id)).toEqual(["session", "old", "later", "keep"]);
});

test("legacy archive plus successive nested anchors reopens in original order and full consumers retain payloads", async () => {
	const { storage, file, batch } = await fixture();
	const legacy = gzipSync(JSON.stringify(batch("first", "second"))).toString("base64");
	await storage.writeText(sessionArchivePath(file), legacy);
	let size = await appendSessionArchive(file, storage, batch("second", "third"), Buffer.byteLength(legacy));
	size = await appendSessionArchive(file, storage, batch("third", "keep"), size);
	for (let cycle = 0; cycle < 3; cycle++) {
		const loaded = await loadSessionFile(file);
		expect(loaded.archiveSize).toBe(size);
		expect(loaded.entries.map(entry => entry.id)).toEqual(["session", "first", "second", "third", "keep"]);
		expect(loaded.entries[1]).toEqual(message("first"));
	}
	const archive = await loadSessionArchive(file, storage, "session");
	expect(archive?.records.map(record => JSON.parse(record.line))).toEqual([
		message("first"),
		message("second"),
		message("third"),
	]);
	const visited: string[] = [];
	await visitEntriesFromFile(file, entry => {
		visited.push(entry.id);
	});
	expect(visited).toEqual(["session", "first", "second", "third", "keep"]);
});

test("retainEntry spills active and archive payloads while full reopen remains lossless", async () => {
	const { storage, file, batch } = await fixture();
	let size = await appendSessionArchive(file, storage, batch("old", "keep"), null);
	size = await appendSessionArchive(file, storage, batch("older", "old"), size);
	const spilled = new Map<string, SessionEntry>();
	const loaded = await loadSessionFile(file, storage, {
		retainEntry: entry => {
			spilled.set(entry.id, entry);
			return message(entry.id, "spilled");
		},
	});
	expect([...spilled.keys()].sort()).toEqual(["keep", "old", "older"]);
	expect(loaded.entries.slice(1)).toEqual([
		message("older", "spilled"),
		message("old", "spilled"),
		message("keep", "spilled"),
	]);
	expect((await loadSessionFile(file)).entries.slice(1)).toEqual([message("older"), message("old"), message("keep")]);
	await expect(
		loadSessionFile(file, storage, {
			retainEntry: () => {
				throw new Error("spill failed");
			},
		}),
	).rejects.toThrow("Cannot retain session entry");
});

test("interrupted active rewrite retains older archives and deduplicates equal active rows on reopen", async () => {
	const { storage, file, header, batch } = await fixture();
	const size = await appendSessionArchive(file, storage, batch("old", "keep"), null);
	await appendSessionArchive(file, storage, batch("keep", null), size);
	const loaded = await loadSessionFile(file);
	expect(loaded.entries).toEqual([header, message("old"), message("keep")]);
	expect([...(loaded.archivedEntryIds ?? [])]).toEqual(["old", "keep"]);
	await storage.writeText(file, `${JSON.stringify(header)}\n`);
	expect((await loadSessionFile(file)).entries).toEqual(loaded.entries);
});

test("corrupt later batches and cyclic anchors are rejected without replacing active history", async () => {
	const { storage, file, batch } = await fixture();
	const size = await appendSessionArchive(file, storage, batch("old", "keep"), null);
	await storage.appendTextAtomic(sessionArchivePath(file), "broken\n", { expectedSize: size });
	const loaded = await loadSessionFile(file);
	expect(loaded.archiveSize).toBeUndefined();
	expect(loaded.entries.map(entry => entry.id)).toEqual(["session", "keep"]);
	await expect(loadSessionArchive(file, storage, "session")).rejects.toThrow("corrupt");
	await storage.unlink(sessionArchivePath(file));
	const cyclicSize = await appendSessionArchive(file, storage, batch("one", "two"), null);
	await appendSessionArchive(file, storage, batch("two", "one"), cyclicSize);
	const cyclic = await loadSessionFile(file);
	expect(cyclic.archiveSize).toBeUndefined();
	expect(cyclic.entries.map(entry => entry.id)).toEqual(["session", "keep"]);
});

test("legacy migration receives intact active and archived payloads despite lazy retention", async () => {
	const { storage, file, header, batch } = await fixture();
	await appendSessionArchive(file, storage, batch("old", "keep"), null);
	const legacyHeader = { ...header, version: 2 };
	const content = `${JSON.stringify(legacyHeader)}\n${JSON.stringify(message("keep"))}\n`;
	await storage.writeText(file, content);
	const memory = new MemorySessionStorage();
	await memory.writeText(file, content);
	await memory.writeText(sessionArchivePath(file), await storage.readText(sessionArchivePath(file)));
	for (const backend of [storage, memory]) {
		const retained: string[] = [];
		const loaded = await loadSessionFile(file, backend, {
			retainEntry: entry => {
				retained.push(entry.id);
				return message(entry.id, "lost migration input");
			},
		});
		expect(retained).toEqual([]);
		expect(loaded.entries).toEqual([legacyHeader, message("old"), message("keep")]);
	}
});

test("a corrupt colliding archive cannot replace active payloads in a lazy backing store", async () => {
	const { storage, file, batch } = await fixture();
	const corrupt = batch("keep", null);
	corrupt.records[0]!.line = JSON.stringify(message("keep", "corrupt replacement"));
	await appendSessionArchive(file, storage, corrupt, null);
	const retained = new Map<string, SessionEntry>();
	const loaded = await loadSessionFile(file, storage, {
		retainEntry: entry => {
			retained.set(entry.id, entry);
			return message(entry.id, "lazy");
		},
	});
	expect(loaded.archiveSize).toBeUndefined();
	expect(retained.get("keep")).toEqual(message("keep"));
});
