import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AuthCredential,
	type AuthCredentialStore,
	isSqliteBusyError,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai";
import { AsyncDrain, getAgentDbPath, getDbBusyTimeoutMs, isRecord, logger } from "@oh-my-pi/pi-utils";
import type { RawSettings as Settings } from "../config/settings";

/** Row shape for settings table queries */
type SettingsRow = {
	key: string;
	value: string;
};

/** Row shape for model_usage table queries */
type ModelUsageRow = {
	model_key: string;
	last_used_at: number;
};

/** Row shape for model_perf table queries */
type ModelPerfRow = {
	model_key: string;
	samples: number;
	output_tokens: number;
	gen_ms: number;
	ttft_samples: number;
	ttft_ms: number;
};

/** One completed request's timing, folded into the per-model aggregates. */
interface ModelPerfSample {
	/** Output tokens the provider reported for the turn. */
	outputTokens: number;
	/** Total request duration in milliseconds. */
	durationMs: number;
	/** Time to first token in milliseconds; omit when the provider did not report one. */
	ttftMs?: number;
}

/** Validated, insert-ready model_perf sample (see {@link normalizeModelPerfSample}). */
type ModelPerfInsert = {
	modelKey: string;
	outputTokens: number;
	durationMs: number;
	ttftSamples: 0 | 1;
	ttftMs: number;
};

/** Recency-weighted per-model performance averages. */
export interface ModelPerfStats {
	/** Decayed sample count backing the averages. */
	samples: number;
	/** Average output tokens/sec over the total request duration. */
	tps: number;
	/** Average time-to-first-token in milliseconds; null when no sample reported one. */
	ttftMs: number | null;
}

/**
 * Decay threshold for model_perf running sums: once a model accumulates this
 * many samples, each new sample first halves every aggregate, turning the
 * plain average into a recency-weighted one (provider speeds drift over time).
 */
const MODEL_PERF_DECAY_AT = 256;
/** Batch window for deferred model_perf writes; matches prompt-history's drain cadence. */
const MODEL_PERF_FLUSH_DELAY_MS = 100;

/**
 * Validates one request timing and shapes it for the model_perf upsert.
 * Returns null for unmeasurable samples (no tokens, no duration). Out-of-range
 * TTFT (>= duration) is bogus latency data; the sample still measures throughput.
 */
function normalizeModelPerfSample(modelKey: string, sample: ModelPerfSample): ModelPerfInsert | null {
	const { outputTokens, durationMs } = sample;
	if (!Number.isFinite(outputTokens) || outputTokens <= 0) return null;
	if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
	const ttftMs =
		sample.ttftMs !== undefined && Number.isFinite(sample.ttftMs) && sample.ttftMs > 0 && sample.ttftMs < durationMs
			? sample.ttftMs
			: undefined;
	return { modelKey, outputTokens, durationMs, ttftSamples: ttftMs !== undefined ? 1 : 0, ttftMs: ttftMs ?? 0 };
}

/** Current agent.db schema version; bump when schema changes require migration. */
export const SCHEMA_VERSION = 6;
const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

/** Singleton instances per database path */
const instances = new Map<string, AgentStorage>();

/**
 * Unified SQLite storage for agent settings, model usage, and auth credentials.
 * Delegates auth credential operations to AuthCredentialStore from @oh-my-pi/pi-ai.
 * Uses singleton pattern per database path; access via AgentStorage.open().
 */
export class AgentStorage {
	#db: Database;
	#authStore: AuthCredentialStore;

	#listSettingsStmt: Statement;
	#upsertModelUsageStmt: Statement;
	#listModelUsageStmt: Statement;
	#upsertModelPerfStmt: Statement;
	#listModelPerfStmt: Statement;
	#upsertCommandUsageStmt: Statement;
	#listCommandUsageStmt: Statement;
	#modelUsageCache: string[] | null = null;
	/** Coalesces per-turn perf samples into one deferred transaction off the turn's hot path. */
	#perfDrain = new AsyncDrain<ModelPerfInsert>(MODEL_PERF_FLUSH_DELAY_MS);

	private constructor(dbPath: string) {
		this.#ensureDir(dbPath);
		try {
			this.#db = new Database(dbPath);
		} catch (err) {
			const dir = path.dirname(dbPath);
			const dirExists = fs.existsSync(dir);
			const errMsg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Failed to open agent database at '${dbPath}': ${errMsg}\n` +
					`Directory '${dir}' exists: ${dirExists}\n` +
					`Ensure the directory is writable and not corrupted.`,
			);
		}

		this.#initializeSchema();
		this.#hardenPermissions(dbPath);

		// Create AuthCredentialStore with our open database
		this.#authStore = new SqliteAuthCredentialStore(this.#db);

		this.#listSettingsStmt = this.#db.prepare("SELECT key, value FROM settings");
		this.#upsertModelUsageStmt = this.#db.prepare(
			`INSERT INTO model_usage (model_key, last_used_at) VALUES (?, ${SQLITE_NOW_EPOCH}) ON CONFLICT(model_key) DO UPDATE SET last_used_at = ${SQLITE_NOW_EPOCH}`,
		);
		this.#listModelUsageStmt = this.#db.prepare(
			"SELECT model_key, last_used_at FROM model_usage ORDER BY last_used_at DESC",
		);
		// Recency-weighted upsert: past MODEL_PERF_DECAY_AT samples, every new
		// sample first halves the aggregates so old measurements fade out.
		this.#upsertModelPerfStmt = this.#db.prepare(
			`INSERT INTO model_perf (model_key, samples, output_tokens, gen_ms, ttft_samples, ttft_ms, updated_at)
VALUES (?1, 1, ?2, ?3, ?4, ?5, ${SQLITE_NOW_EPOCH})
ON CONFLICT(model_key) DO UPDATE SET
	samples = (CASE WHEN model_perf.samples >= ${MODEL_PERF_DECAY_AT} THEN model_perf.samples / 2 ELSE model_perf.samples END) + 1,
	output_tokens = (CASE WHEN model_perf.samples >= ${MODEL_PERF_DECAY_AT} THEN model_perf.output_tokens * 0.5 ELSE model_perf.output_tokens END) + excluded.output_tokens,
	gen_ms = (CASE WHEN model_perf.samples >= ${MODEL_PERF_DECAY_AT} THEN model_perf.gen_ms * 0.5 ELSE model_perf.gen_ms END) + excluded.gen_ms,
	ttft_samples = (CASE WHEN model_perf.samples >= ${MODEL_PERF_DECAY_AT} THEN model_perf.ttft_samples * 0.5 ELSE model_perf.ttft_samples END) + excluded.ttft_samples,
	ttft_ms = (CASE WHEN model_perf.samples >= ${MODEL_PERF_DECAY_AT} THEN model_perf.ttft_ms * 0.5 ELSE model_perf.ttft_ms END) + excluded.ttft_ms,
	updated_at = ${SQLITE_NOW_EPOCH}`,
		);
		this.#listModelPerfStmt = this.#db.prepare(
			"SELECT model_key, samples, output_tokens, gen_ms, ttft_samples, ttft_ms FROM model_perf",
		);
		this.#upsertCommandUsageStmt = this.#db.prepare(
			`INSERT INTO command_usage (name, count, last_used_at) VALUES (?, 1, ${SQLITE_NOW_EPOCH})
ON CONFLICT(name) DO UPDATE SET count = command_usage.count + 1, last_used_at = ${SQLITE_NOW_EPOCH}`,
		);
		this.#listCommandUsageStmt = this.#db.prepare("SELECT name, count FROM command_usage");
	}

	/**
	 * Creates tables if missing and migrates legacy settings.
	 * AuthCredentialStore handles auth_credentials and cache tables.
	 */
	#initializeSchema(): void {
		// Install the busy handler BEFORE any lock-taking statement (incl.
		// `PRAGMA journal_mode=WAL`, which acquires an exclusive lock during WAL
		// recovery). Without this, concurrent omp startups can crash here with
		// `SQLITE_BUSY` / `SQLITE_BUSY_RECOVERY`. See issue #2421. Headless
		// hosts bound the wait so lock contention cannot freeze the protocol
		// loop for the full interactive timeout.
		this.#db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
		this.#db.run(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS model_usage (
	model_key TEXT PRIMARY KEY,
	last_used_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);

CREATE TABLE IF NOT EXISTS model_perf (
	model_key TEXT PRIMARY KEY,
	samples REAL NOT NULL DEFAULT 0,
	output_tokens REAL NOT NULL DEFAULT 0,
	gen_ms REAL NOT NULL DEFAULT 0,
	ttft_samples REAL NOT NULL DEFAULT 0,
	ttft_ms REAL NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);

CREATE TABLE IF NOT EXISTS command_usage (
	name TEXT PRIMARY KEY,
	count INTEGER NOT NULL DEFAULT 0,
	last_used_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);

CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
`);

		const settingsInfo = this.#db.prepare("PRAGMA table_info(settings)").all() as Array<{ name?: string }>;
		const hasSettingsTable = settingsInfo.length > 0;
		const hasKey = settingsInfo.some(column => column.name === "key");
		const hasValue = settingsInfo.some(column => column.name === "value");

		if (!hasSettingsTable) {
			this.#db.run(`
CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
`);
		} else if (!hasKey || !hasValue) {
			// Migrate v1 schema: single JSON blob in `data` column → per-key rows
			let legacySettings: Record<string, unknown> | null = null;
			const row = this.#db.prepare("SELECT data FROM settings WHERE id = 1").get() as { data?: string } | undefined;
			if (row?.data) {
				try {
					const parsed = JSON.parse(row.data);
					if (isRecord(parsed)) {
						legacySettings = parsed;
					} else {
						logger.warn("AgentStorage legacy settings invalid shape");
					}
				} catch (error) {
					logger.warn("AgentStorage failed to parse legacy settings", { error: String(error) });
				}
			}

			const migrate = this.#db.transaction((settings: Record<string, unknown> | null) => {
				this.#db.run("DROP TABLE settings");
				this.#db.run(`
CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
`);
				if (settings) {
					const insert = this.#db.prepare(
						`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ${SQLITE_NOW_EPOCH})`,
					);
					for (const [key, value] of Object.entries(settings)) {
						if (value === undefined) continue;
						const serialized = JSON.stringify(value);
						if (serialized === undefined) continue;
						insert.run(key, serialized);
					}
				}
			});

			migrate(legacySettings);
		}

		const versionRow = this.#db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as
			| { version?: number }
			| undefined;
		const schemaVersion = typeof versionRow?.version === "number" ? versionRow.version : 0;
		if (versionRow?.version !== undefined && versionRow.version !== SCHEMA_VERSION) {
			logger.warn("AgentStorage schema version mismatch", {
				current: versionRow.version,
				expected: SCHEMA_VERSION,
			});
		}
		if (schemaVersion < SCHEMA_VERSION) {
			this.#migrateSchema(schemaVersion);
		}
		this.#db.prepare("INSERT OR REPLACE INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION);
	}

	#migrateSchema(fromVersion: number): void {
		if (fromVersion < 4) {
			// v3 → v4: Add disabled column to auth_credentials (handled by AuthCredentialStore)
			// Nothing to do here - AuthCredentialStore will handle this migration
		}
		if (fromVersion < 5) {
			this.#migrateSchemaV4ToV5();
		}
		if (fromVersion < 6) {
			// v5 → v6: TPS switched from the post-TTFT decode window to total
			// request duration (hidden reasoning made decode-window rates bogus).
			// Purge the stale aggregates; live samples rebuild them.
			this.#db.run("DELETE FROM model_perf");
		}
	}

	#migrateSchemaV4ToV5(): void {
		const migrate = this.#db.transaction(() => {
			this.#db.run("ALTER TABLE settings RENAME TO settings_legacy");
			this.#db.run(`
CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
`);
			this.#db.run(`
INSERT INTO settings (key, value, updated_at)
SELECT key, value, updated_at
FROM settings_legacy
`);
			this.#db.run("DROP TABLE settings_legacy");

			this.#db.run("ALTER TABLE model_usage RENAME TO model_usage_legacy");
			this.#db.run(`
CREATE TABLE model_usage (
	model_key TEXT PRIMARY KEY,
	last_used_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
`);
			this.#db.run(`
INSERT INTO model_usage (model_key, last_used_at)
SELECT model_key, last_used_at
FROM model_usage_legacy
`);
			this.#db.run("DROP TABLE model_usage_legacy");
		});
		migrate();
	}

	/**
	 * Returns singleton instance for the given database path, creating if needed.
	 * Retries on the `SQLITE_BUSY` family (including `SQLITE_BUSY_RECOVERY`) with
	 * exponential backoff. See issue #2421.
	 * @param dbPath - Path to the SQLite database file (defaults to config path)
	 * @returns AgentStorage instance for the given path
	 */
	static async open(dbPath: string = getAgentDbPath()): Promise<AgentStorage> {
		const existing = instances.get(dbPath);
		if (existing) return existing;

		const maxRetries = 4;
		const baseDelayMs = 100;
		let lastError: Error | undefined;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const storage = new AgentStorage(dbPath);
				instances.set(dbPath, storage);
				return storage;
			} catch (err) {
				if (!isSqliteBusyError(err)) {
					throw err;
				}
				lastError = err instanceof Error ? err : new Error(String(err));
				if (attempt < maxRetries - 1) {
					await Bun.sleep(baseDelayMs * 2 ** attempt);
				}
			}
		}

		throw new Error(
			`Failed to open agent database at '${dbPath}' after ${maxRetries} attempts: ${lastError?.message}`,
			{ cause: lastError },
		);
	}
	/** @internal Reset all singletons and close their databases — test-only. */
	static resetInstance(): void {
		for (const storage of instances.values()) storage.#close();
		instances.clear();
	}

	#close(): void {
		this.#listSettingsStmt.finalize();
		this.#upsertModelUsageStmt.finalize();
		this.#listModelUsageStmt.finalize();
		this.#upsertModelPerfStmt.finalize();
		this.#listModelPerfStmt.finalize();
		this.#upsertCommandUsageStmt.finalize();
		this.#listCommandUsageStmt.finalize();
		// SqliteAuthCredentialStore.close() finalizes its own statements and
		// closes the shared #db handle — must run after our statements finalize.
		this.#authStore.close();
	}

	/**
	 * Reads legacy settings persisted in the agent.db `settings` table.
	 * The canonical settings store is `config.yml`; this accessor only
	 * exists so the config loader can migrate values from older installs.
	 * @returns Settings object, or null if no settings are stored
	 */
	getSettings(): Settings | null {
		const rows = (this.#listSettingsStmt.all() as SettingsRow[]) ?? [];
		if (rows.length === 0) return null;
		const settings: Record<string, unknown> = {};
		for (const row of rows) {
			try {
				settings[row.key] = JSON.parse(row.value) as unknown;
			} catch (error) {
				logger.warn("AgentStorage failed to parse setting", {
					key: row.key,
					error: String(error),
				});
			}
		}
		return settings as Settings;
	}

	/**
	 * Records model usage, updating the last-used timestamp.
	 * @param modelKey - Model key in "provider/modelId" format
	 */
	recordModelUsage(modelKey: string): void {
		try {
			this.#upsertModelUsageStmt.run(modelKey);
			this.#modelUsageCache = null;
		} catch (error) {
			logger.warn("AgentStorage failed to record model usage", { modelKey, error: String(error) });
		}
	}

	/**
	 * Gets model keys ordered by most recently used.
	 * Results are cached until recordModelUsage is called.
	 * @returns Array of model keys ("provider/modelId") in MRU order
	 */
	getModelUsageOrder(): string[] {
		if (this.#modelUsageCache) {
			return this.#modelUsageCache;
		}
		try {
			const rows = this.#listModelUsageStmt.all() as ModelUsageRow[];
			this.#modelUsageCache = rows.map(row => row.model_key);
			return this.#modelUsageCache;
		} catch (error) {
			logger.warn("AgentStorage failed to get model usage order", { error: String(error) });
			return [];
		}
	}
	/**
	 * Records one slash-command invocation, bumping its usage count and
	 * last-used timestamp. Frequency-ranked autocomplete reads these counts.
	 * @param name - Canonical command name (e.g. "model", "skill:review")
	 */
	recordCommandUsage(name: string): void {
		try {
			this.#upsertCommandUsageStmt.run(name);
		} catch (error) {
			logger.warn("AgentStorage failed to record command usage", { name, error: String(error) });
		}
	}

	/**
	 * Gets slash-command usage counts keyed by canonical command name.
	 * @returns Command name → invocation count
	 */
	listCommandUsage(): Record<string, number> {
		try {
			const rows = this.#listCommandUsageStmt.all() as Array<{ name: string; count: number }>;
			const counts: Record<string, number> = {};
			for (const row of rows) counts[row.name] = row.count;
			return counts;
		} catch (error) {
			logger.warn("AgentStorage failed to list command usage", { error: String(error) });
			return {};
		}
	}

	/**
	 * Folds one completed request's timing into the model's perf aggregates.
	 * TPS is measured over the total request duration — not the post-TTFT
	 * decode window, which undercounts generation time (and so inflates the
	 * rate) when reasoning tokens are generated before the first visible
	 * token. Invalid samples (no tokens, no duration) are dropped.
	 *
	 * Deferred like prompt history: samples are batched and written in one
	 * transaction after {@link MODEL_PERF_FLUSH_DELAY_MS}, keeping SQLite off
	 * the turn-completion hot path. Fire-and-forget safe — flush failures are
	 * logged, never thrown; await the returned promise only to observe the flush.
	 * @param modelKey - Model key in "provider/modelId" format
	 */
	recordModelPerf(modelKey: string, sample: ModelPerfSample): Promise<void> {
		const row = normalizeModelPerfSample(modelKey, sample);
		if (!row) return Promise.resolve();
		return this.#perfDrain.push(row, rows => this.#flushModelPerf(rows));
	}

	#flushModelPerf(rows: ModelPerfInsert[]): void {
		try {
			this.#db.transaction((batch: ModelPerfInsert[]) => {
				for (const row of batch) this.#foldModelPerf(row);
			})(rows);
		} catch (error) {
			logger.warn("AgentStorage failed to record model perf", { error: String(error) });
		}
	}

	#foldModelPerf(row: ModelPerfInsert): void {
		this.#upsertModelPerfStmt.run(row.modelKey, row.outputTokens, row.durationMs, row.ttftSamples, row.ttftMs);
	}

	/**
	 * Returns recency-weighted TPS/TTFT averages for every model with recorded
	 * requests, keyed by "provider/modelId". Read by the /models browser.
	 */
	getModelPerf(): Map<string, ModelPerfStats> {
		const stats = new Map<string, ModelPerfStats>();
		try {
			for (const row of this.#listModelPerfStmt.all() as ModelPerfRow[]) {
				if (row.gen_ms <= 0 || row.output_tokens <= 0) continue;
				stats.set(row.model_key, {
					samples: row.samples,
					tps: (row.output_tokens * 1000) / row.gen_ms,
					ttftMs: row.ttft_samples > 0 ? row.ttft_ms / row.ttft_samples : null,
				});
			}
		} catch (error) {
			logger.warn("AgentStorage failed to read model perf", { error: String(error) });
		}
		return stats;
	}

	/**
	 * Checks if any auth credentials exist in storage.
	 * @returns True if at least one credential is stored
	 */
	hasAuthCredentials(): boolean {
		return this.#authStore.listAuthCredentials().length > 0;
	}

	/**
	 * Returns the underlying {@link AuthCredentialStore} so callers that need
	 * the lower-level pi-ai abstraction (e.g. `findAnthropicAuth(store)`) can
	 * reuse this storage's open database connection instead of opening their
	 * own.
	 */
	get authStore(): AuthCredentialStore {
		return this.#authStore;
	}

	/**
	 * Lists auth credentials, optionally filtered by provider.
	 * Only returns active (non-disabled) credentials by default.
	 * @param provider - Optional provider name to filter by
	 * @param includeDisabled - If true, includes disabled credentials
	 * @returns Array of stored credentials with their database IDs
	 */
	listAuthCredentials(provider?: string, includeDisabled = false): StoredAuthCredential[] {
		const credentials = this.#authStore.listAuthCredentials(provider);
		if (!includeDisabled) return credentials;

		const stmt = this.#db.prepare(
			provider
				? "SELECT id, provider, credential_type, data, disabled_cause FROM auth_credentials WHERE provider = ? ORDER BY id ASC"
				: "SELECT id, provider, credential_type, data, disabled_cause FROM auth_credentials ORDER BY id ASC",
		);
		const rows = (provider ? stmt.all(provider) : stmt.all()) as Array<{
			id: number;
			provider: string;
			credential_type: string;
			data: string;
			disabled_cause: string | null;
		}>;

		const results: StoredAuthCredential[] = [];
		for (const row of rows) {
			try {
				const parsed = JSON.parse(row.data);
				if (!parsed || typeof parsed !== "object") continue;

				let credential: AuthCredential;
				if (row.credential_type === "api_key" && typeof (parsed as { key?: unknown }).key === "string") {
					credential = { type: "api_key", key: (parsed as { key: string }).key };
				} else if (row.credential_type === "oauth") {
					credential = { type: "oauth", ...(parsed as Record<string, unknown>) } as AuthCredential;
				} else {
					continue;
				}

				results.push({ id: row.id, provider: row.provider, credential, disabledCause: row.disabled_cause });
			} catch {}
		}
		return results;
	}

	/**
	 * Atomically replaces all credentials for a provider.
	 * Useful for OAuth token refresh where old tokens should be discarded.
	 * @param provider - Provider name (e.g., "anthropic", "openai")
	 * @param credentials - New credentials to store
	 * @returns Array of newly stored credentials with their database IDs
	 */
	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[] {
		return this.#authStore.replaceAuthCredentialsForProvider(provider, credentials);
	}

	/**
	 * Updates an existing auth credential by ID.
	 * @param id - Database row ID of the credential to update
	 * @param credential - New credential data
	 */
	updateAuthCredential(id: number, credential: AuthCredential): void {
		this.#authStore.updateAuthCredential(id, credential);
	}

	/**
	 * Disables an auth credential by ID with a persisted cause.
	 * @param id - Database row ID of the credential to disable
	 * @param disabledCause - Human-readable cause stored with the disabled row
	 */
	deleteAuthCredential(id: number, disabledCause: string): void {
		this.#authStore.deleteAuthCredential(id, disabledCause);
	}

	/**
	 * Disables all auth credentials for a provider with a persisted cause.
	 * @param provider - Provider name whose credentials should be disabled
	 * @param disabledCause - Human-readable cause stored with the disabled rows
	 */
	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void {
		this.#authStore.deleteAuthCredentialsForProvider(provider, disabledCause);
	}

	/**
	 * Gets a cached value by key. Returns null if not found or expired.
	 */
	getCache(key: string): string | null {
		return this.#authStore.getCache(key);
	}

	/**
	 * Sets a cached value with expiry time (unix seconds).
	 */
	setCache(key: string, value: string, expiresAtSec: number): void {
		this.#authStore.setCache(key, value, expiresAtSec);
	}

	/**
	 * Deletes expired cache entries. Call periodically for cleanup.
	 */
	cleanExpiredCache(): void {
		this.#authStore.cleanExpiredCache();
	}

	/**
	 * Ensures the parent directory for the database file exists.
	 * @param dbPath - Path to the database file
	 */
	#ensureDir(dbPath: string): void {
		const dir = path.dirname(dbPath);
		try {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			// EEXIST is fine - directory already exists
			if (code !== "EEXIST") {
				throw new Error(`Failed to create agent storage directory '${dir}': ${code || err}`);
			}
		}
		// Verify directory was created
		if (!fs.existsSync(dir)) {
			throw new Error(`Agent storage directory '${dir}' does not exist after creation attempt`);
		}
	}

	#hardenPermissions(dbPath: string): void {
		const dir = path.dirname(dbPath);
		try {
			fs.chmodSync(dir, 0o700);
		} catch (error) {
			logger.warn("AgentStorage failed to chmod agent dir", { path: dir, error: String(error) });
		}

		if (!fs.existsSync(dbPath)) return;
		try {
			fs.chmodSync(dbPath, 0o600);
		} catch (error) {
			logger.warn("AgentStorage failed to chmod db file", { path: dbPath, error: String(error) });
		}
	}
}
