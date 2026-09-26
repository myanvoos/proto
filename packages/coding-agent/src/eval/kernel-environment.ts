import type { KernelTarget } from "./kernel-target";

/** JavaScript kernels are per runtime: `node` cells run in Node.js, `bun` cells in Bun; heaps never mix. */
export type JsKernelRuntime = "node" | "bun";
export type KernelLanguage = "python" | JsKernelRuntime;
export const KERNEL_LANGUAGES: readonly KernelLanguage[] = ["python", "node", "bun"];

export interface KernelLaneConfiguration {
	cwd: string;
	interpreter?: string;
	target: KernelTarget;
}

export const MAX_KERNEL_KEEPALIVE_MS = 60 * 60 * 1000;

export function validateKernelKeepalive(ttlMs: number): void {
	if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_KERNEL_KEEPALIVE_MS) {
		throw new Error(`ttlMs must be an integer from 1 to ${MAX_KERNEL_KEEPALIVE_MS}`);
	}
}

// Configuration outlives idle process reaping, but never explicit close or owner disposal.
const configurations = new Map<string, Map<string, KernelLaneConfiguration>>();

function configurationKey(language: KernelLanguage, sessionId: string): string {
	return JSON.stringify([language, sessionId]);
}

export function getKernelLaneConfiguration(
	ownerId: string,
	language: KernelLanguage,
	sessionId: string,
): KernelLaneConfiguration | undefined {
	return configurations.get(ownerId)?.get(configurationKey(language, sessionId));
}

export function setKernelLaneConfiguration(
	ownerId: string,
	language: KernelLanguage,
	sessionId: string,
	configuration: KernelLaneConfiguration | undefined,
): void {
	let owned = configurations.get(ownerId);
	const key = configurationKey(language, sessionId);
	if (configuration) {
		if (!owned) {
			owned = new Map();
			configurations.set(ownerId, owned);
		}
		owned.set(key, configuration);
	} else {
		owned?.delete(key);
		if (owned?.size === 0) configurations.delete(ownerId);
	}
}

/** Every retained configuration of one owner, keyed by language and kernel session id. */
export function listKernelLaneConfigurations(
	ownerId: string,
): { language: KernelLanguage; sessionId: string; configuration: KernelLaneConfiguration }[] {
	return [...(configurations.get(ownerId) ?? [])].map(([key, configuration]) => {
		const [language, sessionId] = JSON.parse(key) as [KernelLanguage, string];
		return { language, sessionId, configuration };
	});
}

export function clearKernelLaneConfigurations(language: KernelLanguage, ownerId?: string): void {
	for (const [owner, owned] of configurations) {
		if (ownerId !== undefined && ownerId !== owner) continue;
		for (const key of owned.keys()) {
			if (key.startsWith(`[${JSON.stringify(language)},`)) owned.delete(key);
		}
		if (owned.size === 0) configurations.delete(owner);
	}
}
