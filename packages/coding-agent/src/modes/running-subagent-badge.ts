import type { AgentRegistry } from "../registry/agent-registry";

export function countRunningSubagentBadgeAgents(registry: AgentRegistry, agentId: string): number {
	return registry.listInFleet(agentId).filter(ref => ref.kind === "sub" && ref.status === "running").length;
}
