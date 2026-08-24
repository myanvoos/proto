import type { AgentRegistry } from "../registry/agent-registry";

export function countRunningSubagentBadgeAgents(registry: AgentRegistry): number {
	return registry.list().filter(ref => ref.kind === "sub" && ref.status === "running").length;
}
