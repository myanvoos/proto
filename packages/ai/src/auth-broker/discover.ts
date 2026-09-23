import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	$envExact,
	getAgentDbPath,
	getAgentDir,
	getAuthBrokerSnapshotCachePath,
	getConfigRootDir,
	isEnoent,
	logger,
	MAIN_CONFIG_FILENAMES,
} from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { type AuthAccountPolicies, parseAuthAccountPolicies, parseUsageReservePct } from "../auth/account-policy";
import { AuthStorage, type AuthStorageOptions } from "../auth-storage";
import * as AIError from "../error";
import { AuthBrokerClient, AuthBrokerError } from "./client";
import { type AuthBrokerAccountPool, RemoteAuthCredentialStore } from "./remote-store";
import { readAuthBrokerSnapshotCache, writeAuthBrokerSnapshotCache } from "./snapshot-cache";
import { DEFAULT_SNAPSHOT_CACHE_TTL_MS, type SnapshotResponse } from "./types";

export interface AuthBrokerClientConfig {
	url: string;
	token: string;
}

export interface ResolveAuthBrokerConfigOptions {
	agentDir?: string;
	configValueResolver?: (config: string) => Promise<string | undefined>;
}

export interface DiscoverAuthStorageOptions {
	agentDir?: string;
	configValueResolver?: (config: string) => Promise<string | undefined>;
	cachePath?: string;
	sourceLabel?: string;

	accountPool?: AuthBrokerAccountPool;
	/** Effective `auth.accountPolicies`; unset falls back to the main config file. */
	accountPolicies?: AuthAccountPolicies;
	/** Extra AuthStorage options; `defaultReservePct` unset falls back to the main config's `retry.usageReservePct`. */
	authStorageOptions?: Omit<AuthStorageOptions, "accountPolicies" | "configValueResolver" | "sourceLabel">;
}

export function getAuthBrokerTokenFilePath(): string {
	return path.join(getConfigRootDir(), "auth-broker.token");
}

async function defaultResolveConfigValue(config: string): Promise<string | undefined> {
	if (config.startsWith("!")) return undefined;
	const envValue = $envExact(config);
	return envValue || config;
}

// Token, config, and account-pool reads use node:fs: Bun.file reads here failed silently on Windows.
async function readTokenFile(): Promise<string | null> {
	try {
		const raw = await fs.readFile(getAuthBrokerTokenFilePath(), "utf8");
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (err) {
		if (isEnoent(err)) return null;
		logger.warn("auth-broker token file unreadable", { error: String(err) });
		return null;
	}
}

interface ConfigSnapshot {
	url?: string;
	token?: string;
	accountPolicies?: unknown;
	usageReservePct?: unknown;
}

/** Nested (`auth: { broker: { url } }`) wins over the legacy flat literal-dot key (`"auth.broker.url"`). */
function readDottedValue(record: Record<string, unknown>, dottedKey: string): unknown {
	let current: unknown = record;
	for (const segment of dottedKey.split(".")) {
		if (current === null || typeof current !== "object" || Array.isArray(current)) return record[dottedKey];
		const currentRecord = current as Record<string, unknown>;
		if (!Object.hasOwn(currentRecord, segment)) return record[dottedKey];
		current = currentRecord[segment];
	}
	return current;
}

function readDottedString(record: Record<string, unknown>, dottedKey: string): string | undefined {
	const value = readDottedValue(record, dottedKey);
	return typeof value === "string" ? value : undefined;
}

// Unreadable or malformed config fails closed: account policies must never silently vanish.
async function readConfigYaml(agentDir: string): Promise<ConfigSnapshot> {
	for (const filename of MAIN_CONFIG_FILENAMES) {
		const configPath = path.join(agentDir, filename);
		let raw: string;
		try {
			raw = await fs.readFile(configPath, "utf8");
		} catch (error) {
			if (isEnoent(error)) continue;
			throw new AIError.ConfigurationError(`Unable to read ${configPath}: ${String(error)}`);
		}
		let parsed: unknown;
		try {
			parsed = YAML.parse(raw);
		} catch (error) {
			throw new AIError.ConfigurationError(`${configPath} contains invalid YAML: ${String(error)}`);
		}
		// An empty or comment-only file parses to null: no settings, not a malformed config.
		if (parsed === null || parsed === undefined) return {};
		if (typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new AIError.ConfigurationError(`${configPath} must contain a YAML object`);
		}
		const record = parsed as Record<string, unknown>;
		return {
			url: readDottedString(record, "auth.broker.url"),
			token: readDottedString(record, "auth.broker.token"),
			accountPolicies: readDottedValue(record, "auth.accountPolicies"),
			usageReservePct: readDottedValue(record, "retry.usageReservePct"),
		};
	}
	return {};
}

export interface AuthAccountPolicyConfig {
	accountPolicies: AuthAccountPolicies;
	defaultReservePct: number;
}

export interface LoadAuthAccountPolicyConfigOptions {
	agentDir?: string;
	accountPolicies?: unknown;
	usageReservePct?: unknown;
}

/** Load and strictly validate account-selection policy configuration, with main-config fallback. */
export async function loadAuthAccountPolicyConfig(
	options: LoadAuthAccountPolicyConfigOptions = {},
): Promise<AuthAccountPolicyConfig> {
	const needsMainConfigFallback = options.accountPolicies === undefined || options.usageReservePct === undefined;
	const snapshot = needsMainConfigFallback ? await readConfigYaml(options.agentDir ?? getAgentDir()) : undefined;
	return {
		accountPolicies: parseAuthAccountPolicies(options.accountPolicies ?? snapshot?.accountPolicies),
		defaultReservePct: parseUsageReservePct(options.usageReservePct ?? snapshot?.usageReservePct),
	};
}

export async function loadAuthBrokerAccountPool(): Promise<AuthBrokerAccountPool | undefined> {
	const filePath = process.env.PROTO_AUTH_BROKER_ACCOUNT_POOL_FILE?.trim();
	if (!filePath) return undefined;

	let parsed: unknown;
	try {
		const raw = await fs.readFile(filePath, "utf8");
		// Windows editors commonly save JSON with a UTF-8 BOM.
		parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
	} catch (error) {
		throw new AIError.ConfigurationError(`Unable to read PROTO_AUTH_BROKER_ACCOUNT_POOL_FILE at ${filePath}`, {
			cause: error,
		});
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new AIError.ConfigurationError("PROTO_AUTH_BROKER_ACCOUNT_POOL_FILE must contain a JSON object");
	}

	const accountPool = new Map<string, ReadonlySet<string>>();
	for (const [provider, value] of Object.entries(parsed)) {
		const normalizedProvider = provider.trim();
		if (normalizedProvider.length === 0) {
			throw new AIError.ConfigurationError("PROTO_AUTH_BROKER_ACCOUNT_POOL_FILE contains an empty provider id");
		}
		if (provider !== normalizedProvider) {
			throw new AIError.ConfigurationError(
				"PROTO_AUTH_BROKER_ACCOUNT_POOL_FILE contains a provider id with surrounding whitespace",
			);
		}
		if (!Array.isArray(value)) {
			throw new AIError.ConfigurationError(
				`PROTO_AUTH_BROKER_ACCOUNT_POOL_FILE entry for ${provider} must be an array of identity keys`,
			);
		}
		const identities = new Set<string>();
		for (const identity of value) {
			if (typeof identity !== "string" || identity.length === 0) {
				throw new AIError.ConfigurationError(
					`PROTO_AUTH_BROKER_ACCOUNT_POOL_FILE entry for ${provider} contains an invalid identity key`,
				);
			}
			if (identity !== identity.trim()) {
				throw new AIError.ConfigurationError(
					`PROTO_AUTH_BROKER_ACCOUNT_POOL_FILE entry for ${provider} contains an identity key with surrounding whitespace`,
				);
			}
			identities.add(identity);
		}
		accountPool.set(provider, identities);
	}
	return accountPool;
}

function resolveSnapshotTtlMs(): number {
	const raw = process.env.PROTO_AUTH_BROKER_SNAPSHOT_TTL_MS;
	if (raw === undefined) return DEFAULT_SNAPSHOT_CACHE_TTL_MS;
	const value = raw.trim();
	if (value === "") return DEFAULT_SNAPSHOT_CACHE_TTL_MS;
	const ttlMs = Number(value);
	if (Number.isFinite(ttlMs) && ttlMs >= 0) return ttlMs;
	logger.warn("Invalid PROTO_AUTH_BROKER_SNAPSHOT_TTL_MS; using default", { value: raw });
	return DEFAULT_SNAPSHOT_CACHE_TTL_MS;
}

export async function resolveAuthBrokerConfig(
	options: ResolveAuthBrokerConfigOptions = {},
): Promise<AuthBrokerClientConfig | null> {
	const agentDir = options.agentDir ?? getAgentDir();
	const resolveConfig = options.configValueResolver ?? defaultResolveConfigValue;

	const envUrl = process.env.PROTO_AUTH_BROKER_URL;
	const envToken = process.env.PROTO_AUTH_BROKER_TOKEN;

	let url = envUrl && envUrl.length > 0 ? envUrl : undefined;
	let configToken: string | undefined;
	if (!url || !envToken) {
		const fromConfig = await readConfigYaml(agentDir);
		if (!url && fromConfig.url) {
			const resolved = await resolveConfig(fromConfig.url);
			if (resolved && resolved.length > 0) url = resolved;
		}
		if (fromConfig.token) {
			const resolved = await resolveConfig(fromConfig.token);
			if (resolved && resolved.length > 0) configToken = resolved;
		}
	}
	if (!url) return null;

	const token =
		(envToken && envToken.length > 0 ? envToken : undefined) ?? configToken ?? (await readTokenFile()) ?? undefined;
	if (!token) {
		throw new AIError.MissingApiKeyError(
			undefined,
			`PROTO_AUTH_BROKER_URL is set (${url}) but no bearer token is available. ` +
				`Set PROTO_AUTH_BROKER_TOKEN, the \`auth.broker.token\` config entry, or place one at ${getAuthBrokerTokenFilePath()}.`,
		);
	}
	return { url, token };
}

export async function discoverAuthStorage(options: DiscoverAuthStorageOptions = {}): Promise<AuthStorage> {
	const agentDir = options.agentDir ?? getAgentDir();
	const brokerConfig = await resolveAuthBrokerConfig({
		agentDir,
		configValueResolver: options.configValueResolver,
	});
	const { accountPolicies, defaultReservePct } = await loadAuthAccountPolicyConfig({
		agentDir,
		accountPolicies: options.accountPolicies,
		usageReservePct: options.authStorageOptions?.defaultReservePct,
	});

	if (brokerConfig) {
		const accountPool = options.accountPool ?? (await loadAuthBrokerAccountPool());
		const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
		const cachePath = options.cachePath ?? getAuthBrokerSnapshotCachePath();
		const ttlMs = resolveSnapshotTtlMs();
		const persist =
			ttlMs > 0
				? (snapshot: SnapshotResponse): void => {
						void writeAuthBrokerSnapshotCache({
							path: cachePath,
							token: brokerConfig.token,
							url: brokerConfig.url,
							snapshot,
						}).catch(error => {
							logger.debug("auth-broker snapshot cache write failed", { error: String(error) });
						});
					}
				: undefined;

		let cachedSnapshot: SnapshotResponse | undefined;
		if (ttlMs > 0) {
			cachedSnapshot =
				(await readAuthBrokerSnapshotCache({
					path: cachePath,
					token: brokerConfig.token,
					url: brokerConfig.url,
					ttlMs,
				}).catch(error => {
					logger.debug("auth-broker snapshot cache read failed", { error: String(error) });
					return null;
				})) ?? undefined;
		}

		let initialSnapshot = cachedSnapshot;
		if (!cachedSnapshot) {
			const initialResult = await client.fetchSnapshot();
			if (initialResult.status !== 200)
				throw new AuthBrokerError("Auth broker returned no initial snapshot", {
					status: initialResult.status,
				});
			initialSnapshot = initialResult.snapshot;
			persist?.(initialSnapshot);
		}

		const store = new RemoteAuthCredentialStore({
			client,
			initialSnapshot,
			onSnapshot: persist,
			accountPool,
		});
		const storage = new AuthStorage(store, {
			...options.authStorageOptions,
			configValueResolver: options.configValueResolver,
			sourceLabel: options.sourceLabel ?? `broker ${brokerConfig.url}`,
			accountPolicies,
			defaultReservePct,
		});
		await storage.reload();
		return storage;
	}

	const dbPath = getAgentDbPath(agentDir);
	const storage = await AuthStorage.create(dbPath, {
		...options.authStorageOptions,
		configValueResolver: options.configValueResolver,
		sourceLabel: options.sourceLabel ?? `local ${dbPath}`,
		accountPolicies,
		defaultReservePct,
	});
	await storage.reload();
	return storage;
}
