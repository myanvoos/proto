import * as path from "node:path";
import { AuthBrokerError } from "@oh-my-pi/pi-ai/auth-broker";
import {
	type AuthAccountPolicyConfig,
	type AuthBrokerClientConfig,
	type DiscoverAuthStorageOptions,
	discoverAuthStorage as discoverAuthStorageShared,
	getAuthBrokerTokenFilePath,
	loadAuthAccountPolicyConfig,
	resolveAuthBrokerConfig as resolveAuthBrokerConfigShared,
} from "@oh-my-pi/pi-ai/auth-broker/discover";
import { MissingApiKeyError } from "@oh-my-pi/pi-ai/error";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { resolveConfigValue } from "../config/resolve-config-value";
import { Settings } from "../config/settings";
import type { AuthStorage } from "./auth-storage";

export { type AuthBrokerClientConfig, getAuthBrokerTokenFilePath };

let cachedConfigKey: string | null = null;
let cachedConfigPromise: Promise<AuthBrokerClientConfig | null> | null = null;

export function resolveAuthBrokerConfig(): Promise<AuthBrokerClientConfig | null> {
	const key = `${process.env.PROTO_AUTH_BROKER_URL ?? ""}\u0000${process.env.PROTO_AUTH_BROKER_TOKEN ?? ""}\u0000${getAgentDir()}`;
	if (cachedConfigPromise && cachedConfigKey === key) return cachedConfigPromise;
	const promise = resolveAuthBrokerConfigShared({
		agentDir: getAgentDir(),
		configValueResolver: resolveConfigValue,
	});
	cachedConfigKey = key;
	cachedConfigPromise = promise;
	promise.catch(() => {
		if (cachedConfigPromise === promise) {
			cachedConfigPromise = null;
			cachedConfigKey = null;
		}
	});
	return promise;
}

/** Where auth discovery reads effective settings from; see {@link loadEffectiveAuthAccountPolicyConfig}. */
export interface EffectiveSettingsScope {
	/** Already-resolved settings; wins over every other source. */
	settings?: Settings;
	cwd?: string;
	agentDir?: string;
}

/**
 * The settings auth discovery must honor: the explicit instance, else the global instance when it targets the
 * same agent dir (and cwd, when given), else a read-only load so `--config`/`PI_CONFIG_FILES`/project overlays
 * still apply.
 */
async function resolveEffectiveSettings({ settings, cwd, agentDir = getAgentDir() }: EffectiveSettingsScope) {
	if (settings) return settings;
	const current = await Settings.current;
	if (
		current &&
		current.getAgentDir() === path.normalize(agentDir) &&
		(cwd === undefined || current.getCwd() === path.normalize(cwd))
	) {
		return current;
	}
	return Settings.loadReadOnly({ cwd, agentDir });
}

/** Resolve `auth.accountPolicies` + `retry.usageReservePct` from effective settings (discovery, auth-gateway). */
export async function loadEffectiveAuthAccountPolicyConfig(
	scope: EffectiveSettingsScope = {},
): Promise<AuthAccountPolicyConfig> {
	const settings = await resolveEffectiveSettings(scope);
	return loadAuthAccountPolicyConfig({
		accountPolicies: settings.get("auth.accountPolicies"),
		usageReservePct: settings.get("retry.usageReservePct"),
	});
}

/**
 * Broker-backed or local auth storage. Account routing (`auth.accountPolicies`, `retry.usageReservePct`) comes
 * from effective settings; explicit option values win.
 */
export async function discoverAuthStorage(
	agentDir: string = getAgentDir(),
	options: Omit<DiscoverAuthStorageOptions, "agentDir" | "configValueResolver"> &
		Omit<EffectiveSettingsScope, "agentDir"> = {},
): Promise<AuthStorage> {
	const { settings, cwd, ...discoveryOptions } = options;
	const policy = await loadEffectiveAuthAccountPolicyConfig({ settings, cwd, agentDir });
	return discoverAuthStorageShared({
		...discoveryOptions,
		agentDir,
		configValueResolver: resolveConfigValue,
		accountPolicies: discoveryOptions.accountPolicies ?? policy.accountPolicies,
		authStorageOptions: {
			...discoveryOptions.authStorageOptions,
			defaultReservePct: discoveryOptions.authStorageOptions?.defaultReservePct ?? policy.defaultReservePct,
		},
	});
}

export async function describeAuthBrokerStartupError(error: unknown): Promise<string | null> {
	if (error instanceof MissingApiKeyError) {
		return error.message;
	}
	if (!(error instanceof AuthBrokerError)) return null;
	let url: string | undefined;
	try {
		url = (await resolveAuthBrokerConfig())?.url;
	} catch {}
	const target = url ? ` at ${url}` : "";
	return (
		`Auth broker${target} is unreachable (${error.message}). ` +
		"proto is configured to use this broker for credentials and will not fall back to local credentials automatically.\n" +
		"Start the broker with `proto auth-broker serve`, or disable it with " +
		"`proto config reset auth.broker.url` and `proto config reset auth.broker.token` " +
		"(or unset PROTO_AUTH_BROKER_URL / PROTO_AUTH_BROKER_TOKEN)."
	);
}
