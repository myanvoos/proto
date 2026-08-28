import type { AgentDefinition } from "./types";

export function resolveAgentPrewalkDefault(agent: AgentDefinition, taskPrewalk: boolean): boolean | string | undefined {
	return agent.prewalk ?? (taskPrewalk && agent.source === "bundled" && agent.name === "worker" ? true : undefined);
}
