import type { Database, Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { EDITOR_LIMITS } from "@oh-my-pi/pi-tui";
import { checkpointWal, getHistoryDbPath, logger, openSqliteDatabaseSync, postmortem } from "@oh-my-pi/pi-utils";

export interface HistoryEntry {
	id: number;

	prompt: string;

	created_at: number;

	cwd?: string;

	sessionId?: string;
}

type HistoryRow = {
	id: number;
	prompt: string;
	created_at: number;
	cwd: string | null;
	session_id: string | null;
};

type HistoryCandidate = {
	id: number;
	created_at: number;
	bytes: number;
};

// Bound tokenization, generated SQL/FTS input, and SQLite expression depth.
const SEARCH_QUERY_BYTES = 4096;
const SEARCH_QUERY_TOKENS = 64;
const PROMPT_BYTES_SQL = "length(CAST(prompt AS BLOB))";
const ROW_BYTES_SQL = `${PROMPT_BYTES_SQL} + coalesce(length(CAST(cwd AS BLOB)), 0) + coalesce(length(CAST(session_id AS BLOB)), 0)`;
const ELIGIBLE_SQL = `${PROMPT_BYTES_SQL} <= ${EDITOR_LIMITS.draftBytes} AND (${ROW_BYTES_SQL}) <= ${EDITOR_LIMITS.historyBytes}`;
const CANDIDATE_SQL = `SELECT id, created_at, (${ROW_BYTES_SQL}) AS bytes FROM history`;

const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

function escapeLikePattern(text: string): string {
	return text.replace(/[\\%_]/g, "\\$&");
}

function normalizePrompt(prompt: string): string {
	return prompt
		.replace(/\r\n?/g, "\n")
		.replace(/[^\S\n]+\n/g, "\n")
		.trim();
}

const HISTORY_DATA_VERSION = 1;

const HISTORY_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	prompt TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	cwd TEXT,
	session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC);
`;

let cancelExitCleanup: (() => void) | undefined;

export class HistoryStorage {
	#db: Database;
	static #instance?: HistoryStorage;
	#sessionResolver?: () => string | undefined;

	#upsertRowStmt: Statement;
	#recentStmt: Statement;
	#searchStmt: Statement;
	#rowStmt: Statement;
	#substringStmt?: Statement;
	#substringTokenCount = 0;

	private constructor(db: Database) {
		this.#db = db;

		const hadFts = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_fts'").get();
		this.#db.run(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
${HISTORY_TABLE_DDL}
		`);

		const rebuilt = this.#rebuildHistory();

		this.#db.run(`
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(prompt, content='history', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
	INSERT INTO history_fts(rowid, prompt) VALUES (new.id, new.prompt);
END;
		`);

		if (rebuilt || !hadFts) {
			try {
				this.#db.run("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
			} catch (error) {
				logger.warn("HistoryStorage FTS rebuild failed", { error: String(error) });
			}
		}
		this.#recentStmt = this.#db.prepare(
			`${CANDIDATE_SQL} WHERE ${ELIGIBLE_SQL} ORDER BY created_at DESC, id DESC LIMIT ?`,
		);
		this.#searchStmt = this.#db.prepare(
			`${CANDIDATE_SQL} WHERE ${ELIGIBLE_SQL} AND id IN (SELECT rowid FROM history_fts WHERE history_fts MATCH ?) ORDER BY created_at DESC, id DESC LIMIT ?`,
		);
		this.#rowStmt = this.#db.prepare("SELECT id, prompt, created_at, cwd, session_id FROM history WHERE id = ?");
		this.#upsertRowStmt = this.#db.prepare(`
INSERT INTO history (prompt, created_at, cwd, session_id)
VALUES (?, ${SQLITE_NOW_EPOCH}, ?, ?)
ON CONFLICT(prompt) DO UPDATE SET
	created_at = excluded.created_at,
	cwd = excluded.cwd,
	session_id = excluded.session_id
		`);

		// Schema/FTS setup can leave a sizable initial WAL. Checkpoint it before
		// the interactive session so shutdown only handles writes made in-session.
		checkpointWal(this.#db);
	}

	static open(dbPath: string = getHistoryDbPath()): HistoryStorage {
		const existing = HistoryStorage.#instance;
		if (existing) return existing;

		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		return openSqliteDatabaseSync(
			dbPath,
			db => {
				const instance = new HistoryStorage(db);
				cancelExitCleanup = postmortem.register("history-storage", () => HistoryStorage.close());
				HistoryStorage.#instance = instance;
				return instance;
			},
			{ recoverCorruption: true },
		);
	}

	/** Checkpoints and closes the process-wide database, and permits reopening it. */
	static close(): void {
		const instance = HistoryStorage.#instance;
		HistoryStorage.#instance = undefined;
		cancelExitCleanup?.();
		cancelExitCleanup = undefined;
		if (instance) instance.#close();
	}

	#close(): void {
		checkpointWal(this.#db);
		this.#substringStmt?.finalize();
		this.#rowStmt.finalize();
		this.#upsertRowStmt.finalize();
		this.#recentStmt.finalize();
		this.#searchStmt.finalize();
		this.#db.close();
	}

	setSessionResolver(resolver: () => string | undefined): void {
		this.#sessionResolver = resolver;
	}

	/**
	 * Stores an eligible prompt synchronously, durable when this method returns.
	 * Rejects input above the shared expansion ceiling (16 MiB) before normalization;
	 * each metadata string is capped at the draft ceiling (4 MiB). Never truncates.
	 * Expanded prompts above the draft ceiling stay durable but are not retrieved.
	 */
	add(prompt: string, cwd?: string, sessionId?: string): Promise<void> {
		if (Buffer.byteLength(prompt) > EDITOR_LIMITS.expandedBytes) return Promise.resolve();
		const trimmed = normalizePrompt(prompt);
		if (!trimmed) return Promise.resolve();
		const session = sessionId ?? this.#sessionResolver?.();
		if (
			Buffer.byteLength(cwd ?? "") > EDITOR_LIMITS.draftBytes ||
			Buffer.byteLength(session ?? "") > EDITOR_LIMITS.draftBytes
		)
			return Promise.resolve();
		try {
			this.#upsertRowStmt.run(trimmed, cwd ?? null, session || null);
		} catch (error) {
			logger.error("HistoryStorage add failed", { error: String(error) });
		}
		return Promise.resolve();
	}

	/**
	 * Newest eligible rows, capped at 1000 and an 8 MiB UTF-8 payload prefix.
	 * Prompts above the shared draft ceiling remain on disk but are excluded.
	 * Metadata is included in the byte budget; no rejected strings are hydrated.
	 */
	getRecent(limit: number): HistoryEntry[] {
		const safeLimit = this.#normalizeLimit(limit);
		if (safeLimit === 0) return [];

		try {
			return this.#db.transaction(() => {
				const rows = this.#recentStmt.all(safeLimit) as HistoryCandidate[];
				return this.#hydrate(rows);
			})();
		} catch (error) {
			logger.error("HistoryStorage getRecent failed", { error: String(error) });
			return [];
		}
	}

	/** Same payload admission as getRecent; queries over 4 KiB or 64 tokens return no results. */
	search(query: string, limit: number): HistoryEntry[] {
		if (Buffer.byteLength(query) > SEARCH_QUERY_BYTES) return [];
		return this.#db.transaction(() => this.#search(query, limit))();
	}

	#search(query: string, limit: number): HistoryEntry[] {
		const safeLimit = this.#normalizeLimit(limit);
		if (safeLimit === 0) return [];

		const tokens = this.#tokenize(query);
		if (tokens.length === 0 || tokens.length > SEARCH_QUERY_TOKENS) return [];

		const ftsQuery = tokens.map(tok => `"${tok.replace(/"/g, '""')}"*`).join(" ");
		let ftsRows: HistoryCandidate[] = [];
		try {
			ftsRows = this.#searchStmt.all(ftsQuery, safeLimit) as HistoryCandidate[];
		} catch (error) {
			logger.debug("HistoryStorage FTS query failed, using substring only", { error: String(error) });
		}

		let subRows: HistoryCandidate[] = [];
		try {
			subRows = this.#searchSubstring(tokens, safeLimit);
		} catch (error) {
			logger.error("HistoryStorage substring search failed", { error: String(error) });
		}

		if (ftsRows.length === 0) {
			return this.#hydrate(subRows);
		}

		const rowsById = new Map<number, HistoryCandidate>();
		for (const row of ftsRows) {
			rowsById.set(row.id, row);
		}
		for (const row of subRows) {
			if (!rowsById.has(row.id)) rowsById.set(row.id, row);
		}

		return this.#hydrate(
			[...rowsById.values()].sort((a, b) => b.created_at - a.created_at || b.id - a.id).slice(0, safeLimit),
		);
	}

	matchingSessionIds(query: string, limit = 500): string[] {
		const seen = new Set<string>();
		const ids: string[] = [];
		for (const entry of this.search(query, limit)) {
			const id = entry.sessionId;
			if (!id || seen.has(id)) continue;
			seen.add(id);
			ids.push(id);
		}
		return ids;
	}

	#historySchemaHasColumn(column: string): boolean {
		const columns = this.#db.prepare("PRAGMA table_info(history)").all() as Array<{ name: string }>;
		return columns.some(col => col.name === column);
	}

	#rebuildHistory(): boolean {
		const versionRow = this.#db.prepare("PRAGMA user_version").get() as { user_version: number };
		if (versionRow.user_version >= HISTORY_DATA_VERSION) return false;
		this.#db.run("PRAGMA temp_store = FILE");
		this.#db.transaction(() => {
			if (!this.#historySchemaHasColumn("session_id")) {
				this.#db.run("ALTER TABLE history ADD COLUMN session_id TEXT");
			}
			this.#db.run("DROP TRIGGER IF EXISTS history_ai");
			this.#db.run("DROP TABLE IF EXISTS history_fts");
			// Keep normalization winners on disk, not in an archive-sized JS map.
			// Oversized legacy prompts stay byte-for-byte intact in the durable table.
			this.#db.run("CREATE TEMP TABLE history_normalized (id INTEGER PRIMARY KEY, prompt TEXT NOT NULL UNIQUE)");
			const rows = this.#db.prepare<{ id: number; prompt: string }, []>(
				`SELECT id, prompt FROM history WHERE ${PROMPT_BYTES_SQL} <= ${EDITOR_LIMITS.draftBytes} ORDER BY created_at DESC, id DESC`,
			);
			const insert = this.#db.prepare("INSERT OR IGNORE INTO history_normalized (id, prompt) VALUES (?, ?)");
			try {
				for (const row of rows.iterate()) {
					const prompt = normalizePrompt(row.prompt);
					if (prompt) insert.run(row.id, prompt);
				}
			} finally {
				rows.finalize();
				insert.finalize();
			}
			this.#db.run(
				`DELETE FROM history WHERE ${PROMPT_BYTES_SQL} <= ${EDITOR_LIMITS.draftBytes} AND id NOT IN (SELECT id FROM history_normalized)`,
			);
			this.#db.run(
				"UPDATE history SET prompt = (SELECT prompt FROM history_normalized WHERE id = history.id) WHERE id IN (SELECT id FROM history_normalized)",
			);
			this.#db.run("DROP TABLE history_normalized");
			this.#db.run(`PRAGMA user_version = ${HISTORY_DATA_VERSION}`);
		})();
		return true;
	}

	#normalizeLimit(limit: number): number {
		if (!Number.isFinite(limit)) return 0;
		const clamped = Math.max(0, Math.floor(limit));
		return Math.min(clamped, 1000);
	}

	#tokenize(query: string): string[] {
		return query
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(tok => tok.length > 0);
	}

	#searchSubstring(tokens: string[], limit: number): HistoryCandidate[] {
		if (!this.#substringStmt || this.#substringTokenCount !== tokens.length) {
			this.#substringStmt?.finalize();
			this.#substringStmt = undefined;
			const whereClause = Array(tokens.length).fill("prompt LIKE ? ESCAPE '\\' COLLATE NOCASE").join(" AND ");
			this.#substringStmt = this.#db.prepare(
				`${CANDIDATE_SQL} WHERE ${ELIGIBLE_SQL} AND ${whereClause} ORDER BY created_at DESC, id DESC LIMIT ?`,
			);
			this.#substringTokenCount = tokens.length;
		}
		return this.#substringStmt.all(...tokens.map(tok => `%${escapeLikePattern(tok)}%`), limit) as HistoryCandidate[];
	}

	#hydrate(rows: HistoryCandidate[]): HistoryEntry[] {
		const entries: HistoryEntry[] = [];
		let bytes = 0;
		for (const candidate of rows) {
			if (bytes + candidate.bytes > EDITOR_LIMITS.historyBytes) break;
			bytes += candidate.bytes;
			const row = this.#rowStmt.get(candidate.id) as HistoryRow;
			entries.push(this.#toEntry(row));
		}
		return entries;
	}

	#toEntry(row: HistoryRow): HistoryEntry {
		return {
			id: row.id,
			prompt: row.prompt,
			created_at: row.created_at,
			cwd: row.cwd ?? undefined,
			sessionId: row.session_id ?? undefined,
		};
	}
}
