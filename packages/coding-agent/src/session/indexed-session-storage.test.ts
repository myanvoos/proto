import { expect, test } from "bun:test";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "./indexed-session-storage";
import { SESSION_TITLE_SLOT_BYTES } from "./session-entries";
import { serializeTitleSlot } from "./session-title-slot";
import { SqlSessionStorage } from "./sql-session-storage";

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

for (const operation of ["append", "truncate"] as const) {
	test(`a rejected writer ${operation} restores the index and permits a guarded retry`, async () => {
		const client = new Bun.SQL("sqlite://:memory:");
		try {
			const storage = await SqlSessionStorage.create({ client });
			await storage.writeText(PATH, "seed\n");
			const before = storage.statSync(PATH);
			await client.unsafe(
				`CREATE TRIGGER reject_content BEFORE UPDATE OF content ON ${storage.table} ` +
					"BEGIN SELECT RAISE(ABORT, 'write rejected'); END",
			);
			const writer = storage.openWriter(PATH, { flags: operation === "truncate" ? "w" : "a" });
			if (operation === "append") await expect(writer.append("lost\n")).rejects.toThrow("write rejected");
			await expect(writer.flush()).rejects.toThrow("write rejected");
			await expect(writer.close()).rejects.toThrow("write rejected");
			await expect(storage.drain()).rejects.toThrow("write rejected");
			await storage.drain();
			expect(await storage.readText(PATH)).toBe("seed\n");
			expect(storage.statSync(PATH)).toEqual(before);

			await client.unsafe("DROP TRIGGER reject_content");
			const retry = storage.openWriter(PATH);
			await retry.append("ok\n");
			await retry.close();
			expect(await storage.readText(PATH)).toBe("seed\nok\n");
			expect(storage.statSync(PATH).size).toBe(8);
			await storage.writeTextAtomic(PATH, "replacement\n", { expectedSize: 8 });
			expect(await storage.readText(PATH)).toBe("replacement\n");
		} finally {
			await client.end();
		}
	});
}

test("a failed queued append rebases later appends without changing their order", async () => {
	const client = new Bun.SQL("sqlite://:memory:");
	try {
		const storage = await SqlSessionStorage.create({ client });
		await storage.writeText(PATH, "seed\n");
		await client.unsafe(
			`CREATE TRIGGER reject_lost BEFORE UPDATE OF content ON ${storage.table} ` +
				"WHEN NEW.content LIKE '%lost%' BEGIN SELECT RAISE(ABORT, 'write rejected'); END",
		);
		const first = storage.openWriter(PATH);
		const second = storage.openWriter(PATH);
		const third = storage.openWriter(PATH);
		const results = await Promise.allSettled([first.append("lost\n"), second.append("é\n"), third.append("last\n")]);
		expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
		await expect(first.close()).rejects.toThrow("write rejected");
		await second.close();
		await third.close();
		await expect(storage.drain()).rejects.toThrow("write rejected");
		expect(await storage.readText(PATH)).toBe("seed\né\nlast\n");
		expect(storage.statSync(PATH).size).toBe(Buffer.byteLength("seed\né\nlast\n"));
	} finally {
		await client.end();
	}
});

for (const flags of ["a", "w"] as const) {
	test(`failed queued ${flags} writer changes do not survive in the index`, async () => {
		const client = new Bun.SQL("sqlite://:memory:");
		try {
			const storage = await SqlSessionStorage.create({ client });
			await storage.writeText(PATH, CONTENT);
			const before = storage.statSync(PATH);
			await client.unsafe(
				`CREATE TRIGGER reject_content BEFORE UPDATE OF content ON ${storage.table} ` +
					"BEGIN SELECT RAISE(ABORT, 'write rejected'); END",
			);
			const writer = storage.openWriter(PATH, { flags });
			writer.appendSync?.("first\n");
			writer.appendSync?.("second\n");
			await expect(writer.flush()).rejects.toThrow("write rejected");
			await expect(writer.close()).rejects.toThrow("write rejected");
			await expect(storage.drain()).rejects.toThrow("write rejected");
			expect(storage.statSync(PATH)).toEqual(before);
			expect(await storage.readText(PATH)).toBe(CONTENT);
		} finally {
			await client.end();
		}
	});
}

for (const replacement of ["truncate", "rewrite"] as const) {
	test(`a rejected append preserves a newer queued ${replacement} and its append`, async () => {
		const client = new Bun.SQL("sqlite://:memory:");
		try {
			const storage = await SqlSessionStorage.create({ client });
			await storage.writeText(PATH, "seed\n");
			await client.unsafe(
				`CREATE TRIGGER reject_lost BEFORE UPDATE OF content ON ${storage.table} ` +
					"WHEN NEW.content LIKE '%lost%' BEGIN SELECT RAISE(ABORT, 'write rejected'); END",
			);
			const first = storage.openWriter(PATH);
			const failed = expect(first.append("lost\n")).rejects.toThrow("write rejected");
			if (replacement === "rewrite") storage.writeTextSync(PATH, "replacement\n");
			const next = storage.openWriter(PATH, { flags: replacement === "truncate" ? "w" : "a" });
			const appended = next.append("ok\n");
			const expected = replacement === "truncate" ? "ok\n" : "replacement\nok\n";
			const optimistic = storage.statSync(PATH);
			expect(optimistic.size).toBe(Buffer.byteLength(expected));
			await failed;
			await appended;
			await expect(first.close()).rejects.toThrow("write rejected");
			await next.close();
			await expect(storage.drain()).rejects.toThrow("write rejected");
			expect(storage.statSync(PATH)).toEqual(optimistic);
			expect(await storage.readText(PATH)).toBe(expected);
		} finally {
			await client.end();
		}
	});
}

test("a failed writer creation restores a missing index entry", async () => {
	const client = new Bun.SQL("sqlite://:memory:");
	try {
		const storage = await SqlSessionStorage.create({ client });
		await client.unsafe(
			`CREATE TRIGGER reject_insert BEFORE INSERT ON ${storage.table} ` +
				"BEGIN SELECT RAISE(ABORT, 'write rejected'); END",
		);
		const writer = storage.openWriter(PATH);
		await expect(writer.append("lost\n")).rejects.toThrow("write rejected");
		await expect(writer.close()).rejects.toThrow("write rejected");
		await expect(storage.drain()).rejects.toThrow("write rejected");
		expect(storage.existsSync(PATH)).toBe(false);
		expect(() => storage.statSync(PATH)).toThrow("ENOENT");
		await expect(storage.readText(PATH)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await client.end();
	}
});
