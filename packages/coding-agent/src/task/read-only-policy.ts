import type { AgentDefinition } from "./types";

// Built-in tools whose approval tier is "read" (see tool classes' `approval`).
// An agent is read-only iff its declared tools are a non-empty subset of this set.
// Fail-safe: any unknown tool makes the agent not read-only.
export const READ_ONLY_TOOL_NAMES: Record<string, true> = {
	read: true,
	web_search: true,
	yield: true,
	fleet: true,
	ask: true,
	todo: true,
	recall: true,
	reflect: true,
	retain: true,
	memory_edit: true,
	inspect_image: true,
	checkpoint: true,
	rewind: true,
};

export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	return !!agent.tools?.length && agent.tools.every(tool => tool in READ_ONLY_TOOL_NAMES);
}
