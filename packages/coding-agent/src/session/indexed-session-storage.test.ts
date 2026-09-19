import { expect, test } from "bun:test";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "./indexed-session-storage";
import { SESSION_TITLE_SLOT_BYTES } from "./session-entries";
import { serializeTitleSlot } from "./session-title-slot";

const SLOT = serializeTitleSlot({ title: "Fixture", source: "user", updatedAt: "2026-09-19T00:00:00.000Z" });
const BODY = Array.from({ length: 400 }, (_, i) => `{"type":"message","n":${i}}`).join("\n");
const CONTENT = `${SLOT}${BODY}`;
const PATH = "/sessions/fixture.jsonl";

/** Records how many content bytes each call pulled, which is what a SQL/Redis round trip actually costs. */
class CountingBackend implements SessionStorageBackend {
	bytesServed = 0;
	fullReads = 0;

	init(): Promise<void> {
		return Promise.resolve();
	}
	loadIndex(): Promise<Iterable<SessionStorageIndexEntry>> {
		return Promise.resolve([
			{ path: PATH, size: Buffer.byteLength(CONTENT, "utf8"), mtimeMs: 1 } satisfies SessionStorageIndexEntry,
		]);
	}
	readFull(path: string): Promise<string | null> {
		if (path !== PATH) return Promise.resolve(null);
		this.fullReads++;
		this.bytesServed += Buffer.byteLength(CONTENT, "utf8");
		return Promise.resolve(CONTENT);
	}
	readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		if (path !== PATH) return Promise.resolve(["", ""]);
		const buf = Buffer.from(CONTENT, "utf8");
		const prefix = buf.subarray(0, prefixBytes);
		const suffix = suffixBytes > 0 ? buf.subarray(Math.max(0, buf.length - suffixBytes)) : Buffer.alloc(0);
		this.bytesServed += prefix.length + suffix.length;
		return Promise.resolve([prefix.toString("utf8"), suffix.toString("utf8")]);
	}
	writeFull(): Promise<void> {
		return Promise.resolve();
	}
	append(): Promise<void> {
		return Promise.resolve();
	}
	updateSessionTitle(): Promise<void> {
		return Promise.resolve();
	}
	truncate(): Promise<void> {
		return Promise.resolve();
	}
	remove(): Promise<void> {
		return Promise.resolve();
	}
	move(): Promise<void> {
		return Promise.resolve();
	}
}

async function openStorage(): Promise<{ storage: IndexedSessionStorage; backend: CountingBackend }> {
	const backend = new CountingBackend();
	const storage = new IndexedSessionStorage(backend);
	await storage.initialize();
	backend.bytesServed = 0;
	backend.fullReads = 0;
	return { storage, backend };
}

const total = Buffer.byteLength(CONTENT, "utf8");

test("a head range returns the overlaid slot bytes without fetching the whole session", async () => {
	const { storage, backend } = await openStorage();
	const range = await storage.readTextRange(PATH, 0, SESSION_TITLE_SLOT_BYTES);

	expect(range).toBe(SLOT);
	expect(backend.fullReads).toBe(0);
	expect(backend.bytesServed).toBeLessThan(total);
});

test("a tail range returns the trailing bytes without fetching the whole session", async () => {
	const { storage, backend } = await openStorage();
	const start = total - 64;
	const range = await storage.readTextRange(PATH, start, total);

	expect(range).toBe(Buffer.from(CONTENT, "utf8").subarray(start, total).toString("utf8"));
	expect(backend.fullReads).toBe(0);
	expect(backend.bytesServed).toBeLessThan(total / 2);
});

test("an interior range matches a full read of the same bytes", async () => {
	const { storage } = await openStorage();
	const start = SESSION_TITLE_SLOT_BYTES + 10;
	const end = start + 120;

	expect(await storage.readTextRange(PATH, start, end)).toBe(
		Buffer.from(CONTENT, "utf8").subarray(start, end).toString("utf8"),
	);
});

test("an empty or inverted range reads nothing", async () => {
	const { storage, backend } = await openStorage();

	expect(await storage.readTextRange(PATH, 100, 100)).toBe("");
	expect(await storage.readTextRange(PATH, 200, 100)).toBe("");
	expect(backend.bytesServed).toBe(0);
});
