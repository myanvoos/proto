import { AuthBrokerError } from "@oh-my-pi/pi-ai/auth-broker";
import {
	type AuthBrokerClientConfig,
	type DiscoverAuthStorageOptions,
	discoverAuthStorage as discoverAuthStorageShared,
	getAuthBrokerTokenFilePath,
	resolveAuthBrokerConfig as resolveAuthBrokerConfigShared,
} from "@oh-my-pi/pi-ai/auth-broker/discover";
import { MissingApiKeyError } from "@oh-my-pi/pi-ai/error";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { resolveConfigValue } from "../config/resolve-config-value";
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

export function discoverAuthStorage(
	agentDir: string = getAgentDir(),
	options?: Omit<DiscoverAuthStorageOptions, "agentDir" | "configValueResolver">,
): Promise<AuthStorage> {
	return discoverAuthStorageShared({
		...options,
		agentDir,
		configValueResolver: resolveConfigValue,
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
