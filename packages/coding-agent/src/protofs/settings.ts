import { $which } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

/**
 * The protofs command agents and isolated subagents use (`protofs.path`, else
 * `protofs`), or `undefined` when `protofs.enabled` is off or that binary is not
 * found. Read by the system prompt (checkout guidance) and the task runner
 * (protofs-backed isolation when `orchestrator.isolation.mode` is `auto`).
 */
export function protofsCommand(settings: Settings): string | undefined {
	if (!settings.get("protofs.enabled")) return undefined;
	const command = settings.get("protofs.path")?.trim() || "protofs";
	return $which(command) ? command : undefined;
}
