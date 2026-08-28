import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDbBusyTimeoutMs, getHistoryDbPath, logger } from "@oh-my-pi/pi-utils";

const TITLE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS session_titles (
	session_id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
`;

interface TitleIndexHandle {
	dbPath: string;
	db: Database;
	upsert: Statement;
	select: Statement;
}

let handle: TitleIndexHandle | undefined;

let failedPath: string | undefined;

function closeHandle(): void {
	if (!handle) return;
	try {
		handle.upsert.finalize();
		handle.select.finalize();
		handle.db.close();
	} catch {}
	handle = undefined;
}

function openTitleIndex(): TitleIndexHandle | undefined {
	const dbPath = getHistoryDbPath();
	if (handle?.dbPath === dbPath) return handle;
	if (failedPath === dbPath) return undefined;
	closeHandle();
	try {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);

		db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
		db.run(`PRAGMA journal_mode=WAL;\nPRAGMA synchronous=NORMAL;\n${TITLE_TABLE_DDL}`);
		handle = {
			dbPath,
			db,
			upsert: db.prepare(`
INSERT INTO session_titles (session_id, title, updated_at)
VALUES (?, ?, CAST(strftime('%s','now') AS INTEGER))
ON CONFLICT(session_id) DO UPDATE SET
	title = excluded.title,
	updated_at = excluded.updated_at
			`),
			select: db.prepare("SELECT title FROM session_titles WHERE session_id = ?"),
		};
		failedPath = undefined;
		return handle;
	} catch (error) {
		failedPath = dbPath;
		logger.warn("Session title index unavailable", { dbPath, error: String(error) });
		return undefined;
	}
}

export function recordSessionTitle(sessionId: string, title: string): void {
	const index = openTitleIndex();
	if (!index) return;
	try {
		index.upsert.run(sessionId, title);
	} catch (error) {
		logger.debug("Session title index write failed", { sessionId, error: String(error) });
	}
}

export function lookupSessionTitle(sessionId: string): string | undefined {
	const index = openTitleIndex();
	if (!index) return undefined;
	try {
		const row = index.select.get(sessionId) as { title: string } | null;
		return row?.title ?? undefined;
	} catch (error) {
		logger.debug("Session title index read failed", { sessionId, error: String(error) });
		return undefined;
	}
}

export function resetSessionTitleIndexForTests(): void {
	closeHandle();
	failedPath = undefined;
}
