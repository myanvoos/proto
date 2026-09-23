import type { Database } from "bun:sqlite";
import { getModelDbPath, isSqliteCorruptionError, openSqliteDatabaseSync } from "@oh-my-pi/pi-utils";
import type { Api, Model, ModelSpec } from "./types";

const CACHE_SCHEMA_VERSION = 13;
const HEADER_RESTORE_VERSION = 1;

interface CacheRow {
	provider_id: string;
	version: number;
	updated_at: number;
	authoritative: number;
	static_fingerprint: string;
	models: string;
	header_omitted_model_ids: string;
	unrestorable_header_model_ids: string;
	header_restore_version: number;
}

interface TableInfoRow {
	name: string;
}

interface CacheEntry<TApi extends Api = Api> {
	models: ModelSpec<TApi>[];
	fresh: boolean;
	authoritative: boolean;
	updatedAt: number;

	headerOmittedModelIds: readonly string[];

	unrestorableHeaderModelIds: readonly string[];

	legacyHeaderRestoreMarkers: boolean;

	staticFingerprint: string;
}

let sharedDb: Database | null = null;
let sharedDbPath: string | null = null;

function initializeDb(db: Database): void {
	db.run("PRAGMA secure_delete = ON");
	db.run("PRAGMA journal_mode = WAL");
	db.run(`
		CREATE TABLE IF NOT EXISTS model_cache (
			provider_id TEXT PRIMARY KEY,
			version INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			authoritative INTEGER NOT NULL DEFAULT 0,
			static_fingerprint TEXT NOT NULL DEFAULT '',
			header_omitted_model_ids TEXT NOT NULL DEFAULT '[]',
			unrestorable_header_model_ids TEXT NOT NULL DEFAULT '[]',
			header_restore_version INTEGER NOT NULL DEFAULT 0,
			models TEXT NOT NULL
		)
	`);
	migrateCacheSchema(db);
}

function closeSharedDb(): void {
	if (!sharedDb) return;
	sharedDb.close();
	sharedDb = null;
	sharedDbPath = null;
}

function runModelCacheDb<T>(resolvedPath: string, shared: boolean, useDb: (db: Database) => T): T {
	if (shared && sharedDb && sharedDbPath !== resolvedPath) closeSharedDb();
	if (shared && sharedDb) {
		try {
			return useDb(sharedDb);
		} catch (error) {
			if (!isSqliteCorruptionError(error)) throw error;
			// The opener owns recovery for new handles; drop the stale one so its WAL cannot attach to the replacement.
			closeSharedDb();
			return runModelCacheDb(resolvedPath, shared, useDb);
		}
	}

	return openSqliteDatabaseSync(
		resolvedPath,
		db => {
			initializeDb(db);
			const result = useDb(db);
			if (shared) {
				sharedDb = db;
				sharedDbPath = resolvedPath;
			} else {
				db.close();
			}
			return result;
		},
		{ recoverCorruption: true },
	);
}

function withModelCacheDb<T>(dbPath: string | undefined, useDb: (db: Database) => T): T {
	const resolvedPath = dbPath ?? getModelDbPath();
	return runModelCacheDb(resolvedPath, dbPath === undefined, useDb);
}

function migrateCacheSchema(db: Database): void {
	const stmt = db.prepare("PRAGMA table_info(model_cache)");
	try {
		const columns = stmt.all() as TableInfoRow[];
		if (!columns.some(column => column.name === "static_fingerprint")) {
			db.run("ALTER TABLE model_cache ADD COLUMN static_fingerprint TEXT NOT NULL DEFAULT ''");
		}
		if (!columns.some(column => column.name === "header_omitted_model_ids")) {
			db.run("ALTER TABLE model_cache ADD COLUMN header_omitted_model_ids TEXT NOT NULL DEFAULT '[]'");
		}
		if (!columns.some(column => column.name === "unrestorable_header_model_ids")) {
			db.run("ALTER TABLE model_cache ADD COLUMN unrestorable_header_model_ids TEXT NOT NULL DEFAULT '[]'");
		}
		if (!columns.some(column => column.name === "header_restore_version")) {
			db.run("ALTER TABLE model_cache ADD COLUMN header_restore_version INTEGER NOT NULL DEFAULT 0");
		}
	} finally {
		stmt.finalize();
	}

	db.run("DELETE FROM model_cache WHERE version <> ?", [CACHE_SCHEMA_VERSION]);
}

export function readModelCache<TApi extends Api>(
	providerId: string,
	ttlMs: number,
	now: () => number,
	dbPath?: string,
): CacheEntry<TApi> | null {
	try {
		return withModelCacheDb(dbPath, db => {
			const stmt = db.query<CacheRow, [string]>("SELECT * FROM model_cache WHERE provider_id = ?");
			try {
				const row = stmt.get(providerId);
				if (!row || row.version !== CACHE_SCHEMA_VERSION) {
					return null;
				}
				const models = JSON.parse(row.models) as ModelSpec<TApi>[];
				const parsedHeaderModelIds: unknown = JSON.parse(row.header_omitted_model_ids);
				const headerOmittedModelIds = Array.isArray(parsedHeaderModelIds)
					? parsedHeaderModelIds.filter((id): id is string => typeof id === "string")
					: [];
				const parsedUnrestorableModelIds: unknown = JSON.parse(row.unrestorable_header_model_ids);
				const unrestorableHeaderModelIds = Array.isArray(parsedUnrestorableModelIds)
					? parsedUnrestorableModelIds.filter((id): id is string => typeof id === "string")
					: [];
				const ageMs = now() - row.updated_at;
				const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ttlMs;
				return {
					models,
					fresh,
					authoritative: row.authoritative === 1,
					updatedAt: row.updated_at,
					headerOmittedModelIds,
					unrestorableHeaderModelIds,
					legacyHeaderRestoreMarkers: row.header_restore_version < HEADER_RESTORE_VERSION,
					staticFingerprint: row.static_fingerprint ?? "",
				};
			} finally {
				stmt.finalize();
			}
		});
	} catch {
		return null;
	}
}

function hasModelHeaders(model: Model<Api>): boolean {
	if (model.resolveHeaders) return true;
	const headers = model.headers;
	if (!headers) return false;
	for (const _key in headers) return true;
	return false;
}

function toCachedModelSpec<TApi extends Api>(model: Model<TApi>): ModelSpec<TApi> {
	const {
		headers: _headers,
		resolveHeaders: _resolveHeaders,
		compatConfig,
		supportsComputerUseConfig,
		...rest
	} = model;
	return { ...rest, supportsComputerUse: supportsComputerUseConfig, compat: compatConfig };
}

function headersEqual(left: Record<string, string> | undefined, right: Record<string, string> | undefined): boolean {
	if (!left || !right) return left === right;
	for (const key in left) {
		if (right[key] !== left[key]) return false;
	}
	for (const key in right) {
		if (!(key in left)) return false;
	}
	return true;
}

export function writeModelCache<TApi extends Api>(
	providerId: string,
	updatedAt: number,
	models: Model<TApi>[],
	authoritative: boolean,
	staticFingerprint: string,
	dbPath?: string,
	staticHeaderSources: readonly Model<TApi>[] = [],
	restorableHeaderFallback?: Record<string, string>,
): void {
	try {
		withModelCacheDb(dbPath, db => {
			const headerOmittedModelIds: string[] = [];
			const unrestorableHeaderModelIds: string[] = [];
			const cachedModels: ModelSpec<TApi>[] = [];
			const staticById = new Map(staticHeaderSources.map(model => [model.id, model]));
			for (const model of models) {
				if (hasModelHeaders(model)) {
					headerOmittedModelIds.push(model.id);

					const staticHeaderSource =
						staticById.get(model.id) ?? (model.requestModelId ? staticById.get(model.requestModelId) : undefined);

					// A request-time resolver is restorable only when the static source carries the same hook.
					const matchesStatic = model.resolveHeaders
						? staticHeaderSource?.resolveHeaders === model.resolveHeaders
						: staticHeaderSource
							? headersEqual(model.headers, staticHeaderSource.headers)
							: headersEqual(model.headers, restorableHeaderFallback);
					if (!matchesStatic) {
						unrestorableHeaderModelIds.push(model.id);
					}
				}
				cachedModels.push(toCachedModelSpec(model));
			}
			db.run(
				`INSERT OR REPLACE INTO model_cache (
					provider_id, version, updated_at, authoritative, static_fingerprint,
					header_omitted_model_ids, unrestorable_header_model_ids,
					header_restore_version, models
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					providerId,
					CACHE_SCHEMA_VERSION,
					updatedAt,
					authoritative ? 1 : 0,
					staticFingerprint,
					JSON.stringify(headerOmittedModelIds),
					JSON.stringify(unrestorableHeaderModelIds),
					HEADER_RESTORE_VERSION,
					JSON.stringify(cachedModels),
				],
			);
		});
	} catch {}
}
