import { executeShell } from "@oh-my-pi/pi-natives";
import { $envExact, directoryIsEnterable, getProjectDir, logger, untilAborted } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";

const MAX_COMMAND_CACHE_ENTRIES = 512;
const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_FAILURE_RETRY_MS = 30_000;
const commandResultCache = new LRUCache<string, string>({ max: MAX_COMMAND_CACHE_ENTRIES });
const commandFailureRetryAt = new LRUCache<string, number>({ max: MAX_COMMAND_CACHE_ENTRIES });
const commandInFlight = new Map<string, Promise<string | undefined>>();
// Bumped on invalidation so a command already running cannot repopulate the cache with a pre-invalidation result.
const commandGeneration = new Map<string, number>();

/** Materializes request headers at the request boundary; property access never runs commands. */
export type ConfigHeaderResolver = (signal?: AbortSignal) => Promise<Record<string, string> | undefined>;
/** One raw header layer (values may be `!command`, env names, or literals) or an already composed resolver. */
export type ConfigHeaderSource = Record<string, string> | ConfigHeaderResolver | undefined;

/** Bearer derivation applied after the explicit header layers. */
export interface ConfigHeaderResolutionOptions {
	authHeader?: boolean;
	apiKeyConfig?: string;
}

export function isCommandConfigValue(valueConfig: string | undefined): valueConfig is string {
	return valueConfig?.startsWith("!") === true;
}

function commandKey(valueConfig: string): string {
	return valueConfig.slice(1).trim();
}

function bumpGeneration(command: string): void {
	commandGeneration.set(command, (commandGeneration.get(command) ?? 0) + 1);
}

/** Drops one `!command` value's cached result, failure backoff, and in-flight run so the next resolve re-runs it. */
export function invalidateCommandConfig(valueConfig: string | undefined): void {
	if (!isCommandConfigValue(valueConfig)) return;
	const command = commandKey(valueConfig);
	commandResultCache.delete(command);
	commandFailureRetryAt.delete(command);
	commandInFlight.delete(command);
	bumpGeneration(command);
}

/** Invalidates every `!command` value; processes already running finish but cannot repopulate the cache. */
export function invalidateAllCommandConfigs(): void {
	for (const command of new Set([
		...commandResultCache.keys(),
		...commandFailureRetryAt.keys(),
		...commandInFlight.keys(),
	])) {
		bumpGeneration(command);
	}
	commandResultCache.clear();
	commandFailureRetryAt.clear();
	commandInFlight.clear();
}

async function executeCommand(valueConfig: string): Promise<string | undefined> {
	const command = commandKey(valueConfig);
	const cached = commandResultCache.get(command);
	if (cached !== undefined) return cached;
	const retryAt = commandFailureRetryAt.get(command);
	if (retryAt !== undefined && Date.now() < retryAt) return undefined;
	const existing = commandInFlight.get(command);
	if (existing) return await existing;

	const generation = commandGeneration.get(command) ?? 0;
	const promise = (async () => {
		// Credential helpers run in the project; a project directory that cannot be entered fails closed rather
		// than silently resolving against another directory's config.
		const cwd = getProjectDir();
		if (!(await directoryIsEnterable(cwd))) return undefined;
		return await runShellCommand(command, COMMAND_TIMEOUT_MS, cwd);
	})()
		.then(result => {
			if ((commandGeneration.get(command) ?? 0) !== generation) return result;
			if (result === undefined) {
				commandFailureRetryAt.set(command, Date.now() + COMMAND_FAILURE_RETRY_MS);
			} else {
				commandFailureRetryAt.delete(command);
				commandResultCache.set(command, result);
			}
			return result;
		})
		.finally(() => {
			if (commandInFlight.get(command) === promise) commandInFlight.delete(command);
		});
	commandInFlight.set(command, promise);
	return await promise;
}

async function runShellCommand(command: string, timeoutMs: number, cwd: string): Promise<string | undefined> {
	try {
		let output = "";
		const result = await executeShell({ command, cwd, timeoutMs }, (err, chunk) => {
			if (!err) output += chunk;
		});
		if (result.timedOut || result.exitCode !== 0) return undefined;
		const trimmed = output.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch (error) {
		logger.warn("config: !command value resolution failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * Resolve a config value: `!command` runs asynchronously and caches successful stdout (failures back off for 30s);
 * otherwise an exact env var name wins, else the literal.
 */
export async function resolveConfigValue(valueConfig: string): Promise<string | undefined> {
	if (isCommandConfigValue(valueConfig)) return await executeCommand(valueConfig);
	const envValue = $envExact(valueConfig);
	return envValue || valueConfig;
}

/** Resolve one raw header record in declaration order, omitting empty values. */
export async function resolveConfigHeaders(
	headers: Record<string, string> | undefined,
	signal?: AbortSignal,
): Promise<Record<string, string> | undefined> {
	signal?.throwIfAborted();
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	let hasResolved = false;
	for (const key in headers) {
		const next = await untilAborted(signal, () => resolveConfigValue(headers[key]));
		if (!next) continue;
		resolved[key] = next;
		hasResolved = true;
	}
	return hasResolved ? resolved : undefined;
}

/**
 * Compose raw header layers and already composed resolvers into one request-time resolver; later sources win and the
 * optional `authHeader` bearer is applied last. Undefined when there is nothing to resolve.
 */
export function createConfigHeaderResolver(
	sources: readonly ConfigHeaderSource[],
	options?: ConfigHeaderResolutionOptions,
): ConfigHeaderResolver | undefined {
	const active = sources.filter((source): source is Exclude<ConfigHeaderSource, undefined> => source !== undefined);
	if (active.length === 0 && (!options?.authHeader || !options.apiKeyConfig)) return undefined;
	return async signal => {
		signal?.throwIfAborted();
		const resolved: Record<string, string> = {};
		let hasResolved = false;
		for (const source of active) {
			const next =
				typeof source === "function"
					? await untilAborted(signal, () => source(signal))
					: await resolveConfigHeaders(source, signal);
			signal?.throwIfAborted();
			if (!next) continue;
			for (const key in next) {
				resolved[key] = next[key];
				hasResolved = true;
			}
		}
		if (options?.authHeader && options.apiKeyConfig) {
			const keyConfig = options.apiKeyConfig;
			const apiKey = await untilAborted(signal, () => resolveConfigValue(keyConfig));
			if (apiKey) {
				resolved.Authorization = `Bearer ${apiKey}`;
				hasResolved = true;
			}
		}
		return hasResolved ? resolved : undefined;
	};
}
