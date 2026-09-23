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

const SCAN_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS session_scan (
	path TEXT PRIMARY KEY,
	size INTEGER NOT NULL,
	mtime_ms REAL NOT NULL,
	version INTEGER NOT NULL,
	payload TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
`;

// 2: scan payloads cap accumulated search text; v1 rows carry full-transcript copies.
const SCAN_PAYLOAD_VERSION = 2;

const SCAN_ROW_LIMIT = 4096;

const SCAN_PRUNE_INTERVAL = 256;

let scanWritesSincePrune = 0;

export interface PersistedSessionScan {
	size: number;
	mtimeMs: number;
	payload: string;
}

interface TitleIndexHandle {
	dbPath: string;
	db: Database;
	upsert: Statement;
	select: Statement;
	scanUpsert: Statement;
	scanSelect: Statement;
}

let handle: TitleIndexHandle | undefined;

let failedPath: string | undefined;

function closeHandle(): void {
	if (!handle) return;
	try {
		handle.upsert.finalize();
		handle.select.finalize();
		handle.scanUpsert.finalize();
		handle.scanSelect.finalize();
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
		db.run(`PRAGMA journal_mode=WAL;\nPRAGMA synchronous=NORMAL;\n${TITLE_TABLE_DDL}\n${SCAN_TABLE_DDL}`);
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
			scanUpsert: db.prepare(`
INSERT INTO session_scan (path, size, mtime_ms, version, payload, updated_at)
VALUES (?, ?, ?, ?, ?, CAST(strftime('%s','now') AS INTEGER))
ON CONFLICT(path) DO UPDATE SET
	size = excluded.size,
	mtime_ms = excluded.mtime_ms,
	version = excluded.version,
	payload = excluded.payload,
	updated_at = excluded.updated_at
			`),
			scanSelect: db.prepare(
				`SELECT size, mtime_ms AS mtimeMs, payload FROM session_scan WHERE path = ? AND version = ${SCAN_PAYLOAD_VERSION}`,
			),
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

export function lookupSessionScan(file: string): PersistedSessionScan | undefined {
	const index = openTitleIndex();
	if (!index) return undefined;
	try {
		const row = index.scanSelect.get(file) as PersistedSessionScan | null;
		return row ?? undefined;
	} catch (error) {
		logger.debug("Session scan index read failed", { file, error: String(error) });
		return undefined;
	}
}

export function recordSessionScan(file: string, size: number, mtimeMs: number, payload: string): void {
	const index = openTitleIndex();
	if (!index) return;
	try {
		index.scanUpsert.run(file, size, mtimeMs, SCAN_PAYLOAD_VERSION, payload);
		if (++scanWritesSincePrune >= SCAN_PRUNE_INTERVAL) {
			scanWritesSincePrune = 0;
			index.db.run(
				`DELETE FROM session_scan WHERE path NOT IN (SELECT path FROM session_scan ORDER BY updated_at DESC, rowid DESC LIMIT ${SCAN_ROW_LIMIT})`,
			);
		}
	} catch (error) {
		logger.debug("Session scan index write failed", { file, error: String(error) });
	}
}
