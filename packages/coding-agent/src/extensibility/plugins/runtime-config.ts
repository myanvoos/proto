import { atomicWriteJson } from "@oh-my-pi/pi-utils";
import type { PluginRuntimeConfig } from "./types";

export function normalizePluginRuntimeConfig(config: Partial<PluginRuntimeConfig>): PluginRuntimeConfig {
	return {
		plugins: config.plugins ?? {},
		settings: config.settings ?? {},
	};
}

/** Publish credentials in a fresh owner-only inode, never a previously readable lockfile. */
export async function writePluginRuntimeConfig(lockPath: string, config: PluginRuntimeConfig): Promise<void> {
	await atomicWriteJson(lockPath, config, { mode: 0o600 });
}
