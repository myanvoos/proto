import { describe, expect, it } from "bun:test";
import { SqlSessionStorage, type SqlSessionStorageClient } from "./sql-session-storage";

async function createSqlite(): Promise<{ client: Bun.SQL; storage: SqlSessionStorage; table: string }> {
	const client = new Bun.SQL("sqlite://:memory:");
	const storage = await SqlSessionStorage.create({ client });
	return { client, storage, table: storage.table };
}

describe("SqlSessionStorage rename", () => {
	it("keeps the row on a same-path rename and rejects a missing one", async () => {
		const { client, storage, table } = await createSqlite();
		const sessionPath = "/sessions/p/same.jsonl";
		await storage.writeText(sessionPath, "keep-me\n");

		await storage.rename(sessionPath, sessionPath);
		expect(await storage.readText(sessionPath)).toBe("keep-me\n");
		const rows: unknown = await client.unsafe(`SELECT path FROM ${table}`);
		expect(rows).toEqual([{ path: sessionPath }]);

		await client.unsafe(`DELETE FROM ${table} WHERE path = ?`, [sessionPath]);
		await expect(storage.rename(sessionPath, sessionPath)).rejects.toMatchObject({ code: "ENOENT" });
		await client.end();
	});

	it("does not delete the destination when the source vanished or the move fails", async () => {
		const { client, storage, table } = await createSqlite();
		const source = "/sessions/p/source.jsonl";
		const destination = "/sessions/p/destination.jsonl";
		await storage.writeText(source, "source\n");
		await storage.writeText(destination, "destination\n");
		await client.unsafe(
			`CREATE TRIGGER reject_session_move BEFORE UPDATE OF path ON ${table} ` +
				`WHEN OLD.path = '${source}' BEGIN SELECT RAISE(ABORT, 'move rejected'); END`,
		);

		await expect(storage.rename(source, destination)).rejects.toThrow("move rejected");
		expect(await storage.readText(source)).toBe("source\n");
		expect(await storage.readText(destination)).toBe("destination\n");

		await client.unsafe(`DELETE FROM ${table} WHERE path = ?`, [source]);
		await expect(storage.rename(source, destination)).rejects.toMatchObject({ code: "ENOENT" });
		const rows: unknown = await client.unsafe(`SELECT path, content FROM ${table}`);
		expect(rows).toEqual([{ path: destination, content: "destination\n" }]);
		await client.end();
	});
});

describe("SqlSessionStorage MySQL dialect", () => {
	it("binds upsert update values instead of the deprecated VALUES() function", async () => {
		const queries: Array<{ sql: string; values?: unknown[] }> = [];
		const client: SqlSessionStorageClient = {
			options: { adapter: "mysql" },
			async unsafe(sql, values) {
				queries.push({ sql, values });
				return [];
			},
			async transaction(callback) {
				return callback(client);
			},
		};
		const storage = await SqlSessionStorage.create({ client });
		await storage.writeText("/s/replace.jsonl", "body\n");
		const writer = storage.openWriter("/s/m.jsonl");
		await writer.append("chunk\n");
		await writer.close();

		const upserts = queries.filter(query => query.sql.includes("ON DUPLICATE KEY UPDATE"));
		expect(upserts).toHaveLength(2);
		expect(upserts.every(query => !/VALUES\(\w+\)/i.test(query.sql))).toBe(true);
		const replace = upserts.find(query => query.sql.includes("title_updated_at"));
		expect(replace?.values?.slice(6)).toEqual(["body\n", expect.any(Number), null, null, null]);
		const append = upserts.find(query => query.sql.includes("CONCAT"));
		expect(append?.values).toEqual(["/s/m.jsonl", "chunk\n", expect.any(Number), "chunk\n", expect.any(Number)]);
	});
});
