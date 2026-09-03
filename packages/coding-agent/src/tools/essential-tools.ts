import type { ToolLoadMode } from "@oh-my-pi/pi-agent-core";

/**
 * Built-in tool names that load as native LLM tools on every request; their schemas ship in the
 * tool list. Everything else mounts under `xd://` as a discoverable device dispatched from bash
 * (`xd <tool> '<json>'`). Keep this in sync with the `loadMode` field on each tool class — the map
 * only supplies defaults for tools that do not declare one (extensions, MCP bridges, RPC hosts).
 */
export const ESSENTIAL_BUILTIN_TOOL_NAMES: Record<string, true> = {
	bash: true,
	ask: true,
	todo: true,
	web_search: true,
	inspect_media: true,
};

export function defaultLoadModeForToolName(name: string, declared?: ToolLoadMode): ToolLoadMode {
	if (declared) return declared;
	return name in ESSENTIAL_BUILTIN_TOOL_NAMES ? "essential" : "discoverable";
}
