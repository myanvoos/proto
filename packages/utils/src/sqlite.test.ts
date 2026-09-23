import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
	annotateSqliteError,
	isSqliteBusyError,
	isSqliteCorruptionError,
	openSqliteDatabase,
	openSqliteDatabaseSync,
} from "./sqlite";
import { TempDir } from "./temp";

function sqliteError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function backupNames(dir: TempDir): string[] {
	return fs.readdirSync(dir.path()).filter(name => name.startsWith("store.db.corrupt-"));
}

async function failure(run: () => Promise<unknown>): Promise<Error> {
	try {
		await run();
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error(`non-Error rejection: ${String(error)}`);
	}
	throw new Error("expected the open to fail");
}

test("annotation names the database path and keeps the SQLite code", async () => {
	using dir = TempDir.createSync("@proto-sqlite-annotate-");
	const dbPath = dir.join("store.db");
	const error = await failure(() => openSqliteDatabase(dbPath, db => db.run("INSERT INTO missing VALUES (1)")));

	expect(error.message).toStartWith(`Database ${JSON.stringify(dbPath)}: `);
	expect(error.message).toContain("no such table: missing");

	const original = sqliteError("SQLITE_IOERR", "disk I/O error");
	expect(annotateSqliteError(original, dbPath)).toBe(original);
	expect((original as Error & { code: string }).code).toBe("SQLITE_IOERR");
});

test("BUSY failures retry on fresh connections for at most four attempts", async () => {
	using dir = TempDir.createSync("@proto-sqlite-busy-");
	const dbPath = dir.join("store.db");
	const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
	const handles: Database[] = [];

	let error: Error;
	let delays: unknown[];
	try {
		error = await failure(() =>
			openSqliteDatabase(dbPath, db => {
				handles.push(db);
				throw sqliteError("SQLITE_BUSY_RECOVERY", "database is locked");
			}),
		);
	} finally {
		delays = sleep.mock.calls.map(([ms]) => ms);
		sleep.mockRestore();
	}

	expect(isSqliteBusyError(error)).toBe(true);
	expect(error.message).toContain(dbPath);
	expect(handles).toHaveLength(4);
	expect(new Set(handles).size).toBe(4);
	expect(delays).toEqual([100, 200, 400]);
	for (const handle of handles) expect(() => handle.query("SELECT 1").get()).toThrow();
});

test("non-BUSY failures surface on the first attempt", async () => {
	using dir = TempDir.createSync("@proto-sqlite-ioerr-");
	let attempts = 0;
	const error = await failure(() =>
		openSqliteDatabase(
			dir.join("store.db"),
			() => {
				attempts++;
				throw sqliteError("SQLITE_IOERR", "disk I/O error");
			},
			{ recoverCorruption: true },
		),
	);
	expect(attempts).toBe(1);
	expect((error as Error & { code?: string }).code).toBe("SQLITE_IOERR");
	expect(backupNames(dir)).toEqual([]);
});

test("corruption is not recovered unless opted in", async () => {
	using dir = TempDir.createSync("@proto-sqlite-no-recover-");
	const dbPath = dir.join("store.db");
	const damaged = Buffer.from("not a sqlite database".repeat(64));
	fs.writeFileSync(dbPath, damaged);

	const error = await failure(() =>
		openSqliteDatabase(dbPath, db => db.query("SELECT name FROM sqlite_master").all()),
	);

	expect(isSqliteCorruptionError(error)).toBe(true);
	expect(error.message).toContain(dbPath);
	expect(fs.readFileSync(dbPath)).toEqual(damaged);
	expect(backupNames(dir)).toEqual([]);
});

test("opted-in corruption recovery quarantines a private backup and recreates the store", () => {
	using dir = TempDir.createSync("@proto-sqlite-recover-");
	const dbPath = dir.join("store.db");
	const damaged = Buffer.from("not a sqlite database".repeat(64));
	fs.writeFileSync(dbPath, damaged, { mode: 0o644 });
	const preserved: string[] = [];

	const rows = openSqliteDatabaseSync(
		dbPath,
		db => {
			try {
				db.run("CREATE TABLE IF NOT EXISTS entries (value TEXT)");
				db.run("INSERT INTO entries VALUES ('fresh')");
				return db.query<{ value: string }, []>("SELECT value FROM entries").all();
			} finally {
				db.close();
			}
		},
		{
			recoverCorruption: true,
			onCorruptionPreserved: (backupPath, error) => {
				expect(isSqliteCorruptionError(error)).toBe(true);
				preserved.push(backupPath);
			},
		},
	);

	expect(rows).toEqual([{ value: "fresh" }]);
	const backups = backupNames(dir);
	expect(backups).toHaveLength(1);
	expect(preserved).toEqual([dir.join(backups[0]!)]);
	expect(backups[0]).toMatch(/^store\.db\.corrupt-\d+-[0-9a-f-]{36}$/);
	expect(fs.readFileSync(preserved[0]!)).toEqual(damaged);
	expect(fs.statSync(preserved[0]!).mode & 0o777).toBe(0o600);

	const reopened = new Database(dbPath);
	try {
		expect(reopened.query("SELECT value FROM entries").all()).toEqual([{ value: "fresh" }]);
	} finally {
		reopened.close();
	}
});
