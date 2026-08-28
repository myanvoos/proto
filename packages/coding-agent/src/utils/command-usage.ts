import { logger } from "@oh-my-pi/pi-utils";
import { AgentStorage } from "../session/agent-storage";

let counts: Record<string, number> = {};
let storage: AgentStorage | undefined;
let loadPromise: Promise<void> | undefined;

export function loadSlashCommandUsage(): Promise<void> {
	loadPromise ??= (async () => {
		try {
			const opened = await AgentStorage.open();
			const persisted = opened.listCommandUsage();

			for (const name in counts) persisted[name] = (persisted[name] ?? 0) + counts[name]!;
			counts = persisted;
			storage = opened;
		} catch (err) {
			logger.warn("Failed to load slash command usage", { error: String(err) });
		}
	})();
	return loadPromise;
}

export function getSlashCommandUsage(name: string): number {
	return counts[name] ?? 0;
}

export function recordSlashCommandUsage(name: string): void {
	counts[name] = (counts[name] ?? 0) + 1;
	storage?.recordCommandUsage(name);
}
