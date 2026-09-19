import {
	type CompactionSettings as EngineCompactionSettings,
	shouldUseProviderNativeCompaction,
} from "@oh-my-pi/pi-agent-core/compaction/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import type { CompactionSettings } from "../config/settings-schema";

export * from "./compaction-method-config";

import { type CompactionMethod, resolveCompactionMethodOrder } from "./compaction-method-config";

const STRATEGY_BY_COMPACTION_METHOD: Record<CompactionMethod, "context-full"> = {
	remote: "context-full",
	soft: "context-full",
};

export function resolveMethodSettings(
	settings: CompactionSettings,
	method: CompactionMethod,
): EngineCompactionSettings {
	return {
		...settings,
		strategy: STRATEGY_BY_COMPACTION_METHOD[method],
		remoteEnabled: method === "remote",
	};
}

export function canUseRemoteCompaction(model: Model | null | undefined, settings: EngineCompactionSettings): boolean {
	return (
		(typeof settings.remoteEndpoint === "string" && settings.remoteEndpoint.length > 0) ||
		(model !== null && model !== undefined && shouldUseProviderNativeCompaction(model, settings))
	);
}

export function resolveSpeculationMethod(
	model: Model | null | undefined,
	settings: CompactionSettings,
): CompactionMethod | undefined {
	for (const candidate of resolveCompactionMethodOrder(settings.methodOrder)) {
		const available =
			candidate === "remote" ? canUseRemoteCompaction(model, resolveMethodSettings(settings, candidate)) : true;
		if (!available) continue;
		return candidate;
	}
	return undefined;
}
