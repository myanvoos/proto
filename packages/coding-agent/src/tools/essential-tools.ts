import type { ToolLoadMode } from "@oh-my-pi/pi-agent-core";

export const ESSENTIAL_BUILTIN_TOOL_NAMES: Record<string, true> = {
	read: true,
	write: true,
	bash: true,
	edit: true,
	computer: true,
	eval: true,
	orchestrate_spawn: true,
	orchestrate_send: true,
	orchestrate_wait: true,
	orchestrate_kill: true,
	orchestrate_list: true,
	fleet: true,
	learn: true,
	manage_skill: true,
};

export function defaultLoadModeForToolName(name: string, declared?: ToolLoadMode): ToolLoadMode {
	if (declared) return declared;
	return name in ESSENTIAL_BUILTIN_TOOL_NAMES ? "essential" : "discoverable";
}
