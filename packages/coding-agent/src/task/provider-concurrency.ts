import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Settings } from "../config/settings";
import type { SettingPath } from "../config/settings-schema";
import { Semaphore } from "./parallel";

const PROVIDER_MAX_CONCURRENCY_SETTINGS: Record<string, SettingPath> = {
	"ollama-cloud": "providers.ollama-cloud.maxConcurrency",
};

interface ProviderSemaphoreEntry {
	limit: number;
	semaphore: Semaphore;
}

const providerSemaphores = new Map<string, ProviderSemaphoreEntry>();

function getProviderConcurrencyLimit(settings: Settings, provider: string): number | undefined {
	const settingPath = PROVIDER_MAX_CONCURRENCY_SETTINGS[provider];
	if (!settingPath) return undefined;
	const raw = settings.get(settingPath);
	const limit = Number.isFinite(raw) ? Math.trunc(raw) : 0;
	return limit > 0 ? limit : Number.POSITIVE_INFINITY;
}

function getProviderSemaphore(settings: Settings, provider: string): Semaphore | undefined {
	const limit = getProviderConcurrencyLimit(settings, provider);
	if (limit === undefined) return undefined;
	const existing = providerSemaphores.get(provider);
	if (existing) {
		if (existing.limit !== limit) {
			existing.limit = limit;
			existing.semaphore.resize(limit);
		}
		return existing.semaphore;
	}
	const semaphore = new Semaphore(limit);
	providerSemaphores.set(provider, { limit, semaphore });
	return semaphore;
}

export function wrapStreamFnWithProviderConcurrency(settings: Settings, base: StreamFn): StreamFn {
	return async (model, context, options) => {
		const semaphore = getProviderSemaphore(settings, model.provider);
		if (!semaphore) return base(model, context, options);
		await semaphore.acquire(options?.signal);
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			semaphore.release();
		};
		try {
			const stream = await base(model, context, options);

			stream.result().then(release, release);
			return stream;
		} catch (err) {
			release();
			throw err;
		}
	};
}
