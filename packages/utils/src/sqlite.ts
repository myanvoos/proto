import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { getDbBusyTimeoutMs } from "./env";
import { withFileLockSync } from "./file-lock";
import { isEnoent } from "./fs-error";
import * as logger from "./logger";

const BUSY_MAX_ATTEMPTS = 4;
const BUSY_BASE_DELAY_MS = 100;
const SQLITE_STORE_SUFFIXES = ["-wal", "-shm", "-journal", ""];

type SqliteFileIdentity = string | null | undefined;

class SqliteAttemptFailure extends Error {
	readonly original: unknown;
	readonly identity: SqliteFileIdentity;
	readonly canRecover: boolean;
	readonly db?: Database;

	constructor(original: unknown, identity: SqliteFileIdentity, options: { canRecover?: boolean; db?: Database } = {}) {
		super(original instanceof Error ? original.message : String(original));
		this.original = original;
		this.identity = identity;
		this.canRecover = options.canRecover ?? true;
		this.db = options.db;
	}
}

function sqliteFileIdentity(dbPath: string): SqliteFileIdentity {
	try {
		const stat = fs.statSync(dbPath);
		return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
	} catch (error) {
		return isEnoent(error) ? null : undefined;
	}
}

function closeFailedDatabase(db: Database | undefined, error: unknown, identity: SqliteFileIdentity): void {
	try {
		db?.close();
	} catch (closeError) {
		const original = error instanceof Error ? error : new Error(String(error));
		const detail = closeError instanceof Error ? closeError.message : String(closeError);
		original.message += `; failed to close the SQLite handle: ${detail}`;
		throw new SqliteAttemptFailure(original, identity, { canRecover: false });
	}
}

export interface SqliteOpenOptions {
	/** Preserve a corrupt store and its sidecars, recreate it, and run the initializer once more. */
	recoverCorruption?: boolean;
	/** Runs after preservation and before the replacement is initialized. */
	onCorruptionPreserved?: (backupPath: string, error: unknown) => void;
}

function openConnection(dbPath: string): Database {
	const db = new Database(dbPath);
	// WAL recovery can bypass the busy handler, so callers also retry BUSY (#2421).
	db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
	return db;
}

async function openWithBusyRetries<T>(
	dbPath: string,
	initialize: (db: Database) => T | Promise<T>,
	options: SqliteOpenOptions,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		let db: Database | undefined;
		const identity = sqliteFileIdentity(dbPath);
		try {
			db = openConnection(dbPath);
			return await initialize(db);
		} catch (error) {
			if (options.recoverCorruption && isSqliteCorruptionError(error)) {
				throw new SqliteAttemptFailure(error, identity, { db });
			}
			closeFailedDatabase(db, error, identity);
			if (!isSqliteBusyError(error) || attempt + 1 >= BUSY_MAX_ATTEMPTS) {
				throw new SqliteAttemptFailure(error, identity);
			}
			await Bun.sleep(BUSY_BASE_DELAY_MS * 2 ** attempt);
		}
	}
}

function openOnce<T>(dbPath: string, initialize: (db: Database) => T, options: SqliteOpenOptions): T {
	let db: Database | undefined;
	const identity = sqliteFileIdentity(dbPath);
	try {
		db = openConnection(dbPath);
		return initialize(db);
	} catch (error) {
		if (options.recoverCorruption && isSqliteCorruptionError(error)) {
			throw new SqliteAttemptFailure(error, identity, { db });
		}
		closeFailedDatabase(db, error, identity);
		throw new SqliteAttemptFailure(error, identity);
	}
}

function quarantineCorruptSqliteStore(dbPath: string, db: Database | undefined): string {
	const backupPath = `${dbPath}.corrupt-${Date.now()}-${crypto.randomUUID()}`;
	const preserved: string[] = [];
	// Closing a failed WAL connection can truncate its WAL: copy evidence before
	// closing, and remove originals only after every copy succeeded.
	for (const suffix of SQLITE_STORE_SUFFIXES) {
		try {
			fs.chmodSync(`${dbPath}${suffix}`, 0o600);
			fs.copyFileSync(`${dbPath}${suffix}`, `${backupPath}${suffix}`, fs.constants.COPYFILE_EXCL);
			preserved.push(suffix);
		} catch (error) {
			if (isEnoent(error) && suffix !== "") continue;
			throw error;
		}
	}
	db?.close();

	const removed: string[] = [];
	try {
		// The main file goes last so a failed sidecar removal cannot leave a path
		// at which another startup creates an empty database.
		for (const suffix of preserved) {
			try {
				fs.unlinkSync(`${dbPath}${suffix}`);
				removed.push(suffix);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	} catch (error) {
		for (const suffix of removed) {
			try {
				fs.copyFileSync(`${backupPath}${suffix}`, `${dbPath}${suffix}`, fs.constants.COPYFILE_EXCL);
			} catch (rollbackError) {
				logger.error("SQLite quarantine rollback failed; original preserved at backup path", {
					path: `${dbPath}${suffix}`,
					backupPath: `${backupPath}${suffix}`,
					error: String(rollbackError),
				});
			}
		}
		throw error;
	}
	return backupPath;
}

function corruptionPreservationError(corruption: unknown, dbPath: string, preservationError: unknown): Error {
	const annotated = annotateSqliteError(corruption, dbPath);
	const detail = preservationError instanceof Error ? preservationError.message : String(preservationError);
	annotated.message += `; failed to preserve the corrupt database: ${detail}`;
	return annotated;
}

function recoverCorruptDatabase(dbPath: string, error: unknown, options: SqliteOpenOptions): void {
	if (!(error instanceof SqliteAttemptFailure)) throw annotateSqliteError(error, dbPath);
	const failure = error;
	if (!options.recoverCorruption || !failure.canRecover || !isSqliteCorruptionError(failure.original)) {
		throw annotateSqliteError(failure.original, dbPath);
	}

	let backupPath: string | null;
	try {
		try {
			// A waiter whose file was already replaced by a peer adopts the replacement.
			backupPath = withFileLockSync(`${dbPath}.recovery`, () => {
				const currentIdentity = sqliteFileIdentity(dbPath);
				if (failure.identity === undefined || currentIdentity === undefined) {
					throw new Error("could not verify the corrupt database file identity");
				}
				if (currentIdentity !== failure.identity) return null;
				return quarantineCorruptSqliteStore(dbPath, failure.db);
			});
		} finally {
			closeFailedDatabase(failure.db, failure.original, failure.identity);
		}
	} catch (preservationError) {
		throw corruptionPreservationError(failure.original, dbPath, preservationError);
	}

	if (backupPath === null) return;
	logger.warn("SQLite database corrupt; preserved damaged store before recreating it", {
		path: dbPath,
		backupPath,
		warning: "Stored credentials from this database may require re-login.",
	});
	options.onCorruptionPreserved?.(backupPath, failure.original);
}

/**
 * Opens and initializes a store, retrying BUSY failures up to four total attempts and closing failed
 * connections. The initializer may run again on a fresh connection; on success it owns the handle.
 * With `recoverCorruption`, a corrupt store is preserved as `<db>.corrupt-<ts>-<uuid>` (mode 0600,
 * serialized across processes) and recreated once. Final failures keep their SQLite codes and name the path.
 */
export async function openSqliteDatabase<T>(
	dbPath: string,
	initialize: (db: Database) => T | Promise<T>,
	options: SqliteOpenOptions = {},
): Promise<T> {
	try {
		return await openWithBusyRetries(dbPath, initialize, options);
	} catch (error) {
		recoverCorruptDatabase(dbPath, error, options);
	}

	try {
		return await openWithBusyRetries(dbPath, initialize, {});
	} catch (error) {
		throw annotateSqliteError(error instanceof SqliteAttemptFailure ? error.original : error, dbPath);
	}
}

/** Synchronous {@link openSqliteDatabase} without the BUSY retry loop. */
export function openSqliteDatabaseSync<T>(
	dbPath: string,
	initialize: (db: Database) => T,
	options: SqliteOpenOptions = {},
): T {
	try {
		return openOnce(dbPath, initialize, options);
	} catch (error) {
		recoverCorruptDatabase(dbPath, error, options);
	}

	try {
		return openOnce(dbPath, initialize, {});
	} catch (error) {
		throw annotateSqliteError(error instanceof SqliteAttemptFailure ? error.original : error, dbPath);
	}
}

/** Prefixes the failing store's path without losing SQLite result codes or the original stack. */
export function annotateSqliteError(error: unknown, dbPath: string): Error {
	const annotated = error instanceof Error ? error : new Error(String(error));
	annotated.message = `Database ${JSON.stringify(dbPath)}: ${annotated.message}`;
	return annotated;
}

/** Checkpoints committed WAL frames without waiting for concurrent readers. */
export function checkpointWal(db: Database): void {
	db.run("PRAGMA wal_checkpoint(PASSIVE)");
}

export function isSqliteBusyError(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	const code = err.code;
	return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

export function isSqliteCorruptionError(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	const code = err.code;
	return typeof code === "string" && (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB");
}
