import { type AgentDefinition, canSpawnAtDepth } from "./types";

const DEFAULT_SPAWN_AGENT = "worker";

interface ResolvedSpawnPolicy {
	enabled: boolean;

	defaultAgent: string;

	allowedAgents: readonly string[] | null;

	allowedErrorText: string;

	allowedPromptText?: string;
}

export function resolveSpawnPolicy(parentSpawns: string | boolean | null | undefined): ResolvedSpawnPolicy {
	let normalized: string;
	if (parentSpawns === false) {
		normalized = "";
	} else if (parentSpawns === true || parentSpawns === null || parentSpawns === undefined) {
		normalized = "*";
	} else {
		normalized = parentSpawns.trim();
	}

	if (normalized === "*") {
		return {
			enabled: true,
			defaultAgent: DEFAULT_SPAWN_AGENT,
			allowedAgents: null,
			allowedErrorText: "*",
		};
	}

	const allowedAgents = normalized
		.split(",")
		.map(spawn => spawn.trim())
		.filter(Boolean);
	if (allowedAgents.length === 0) {
		return {
			enabled: false,
			defaultAgent: DEFAULT_SPAWN_AGENT,
			allowedAgents,
			allowedErrorText: "none (spawns disabled for this agent)",
		};
	}

	return {
		enabled: true,
		defaultAgent: allowedAgents[0] ?? DEFAULT_SPAWN_AGENT,
		allowedAgents,
		allowedErrorText: allowedAgents.join(","),
		allowedPromptText: allowedAgents.map(agent => `\`${agent}\``).join(", "),
	};
}

export function isScoutSpawnable(
	disabledAgents: readonly string[] | undefined,
	spawns: string | boolean | null | undefined,
): boolean {
	if (disabledAgents?.includes("scout")) return false;
	const policy = resolveSpawnPolicy(spawns);
	if (!policy.enabled) return false;
	return policy.allowedAgents === null || policy.allowedAgents.includes("scout");
}

interface SpawnPreflightArgs {
	requestedAgent: string | undefined;
	parentSpawns: string | boolean | null | undefined;
	taskDepth: number;
	maxRecursionDepth: number;
	blockedAgent?: string;
}

interface SpawnPreflight {
	agentName: string;
	error?: string;
}

export function resolveSpawnPreflight(args: SpawnPreflightArgs): SpawnPreflight {
	const policy = resolveSpawnPolicy(args.parentSpawns);
	const agentName = args.requestedAgent?.trim() || policy.defaultAgent;
	if (!canSpawnAtDepth(args.maxRecursionDepth, args.taskDepth)) {
		return {
			agentName,
			error: `Cannot spawn another agent at task depth ${args.taskDepth}; maximum depth is ${args.maxRecursionDepth}.`,
		};
	}
	if (args.blockedAgent && args.blockedAgent === agentName) {
		return {
			agentName,
			error: `Cannot spawn ${agentName} agent from within itself (recursion prevention). Use a different agent type.`,
		};
	}
	if (!policy.enabled || (policy.allowedAgents !== null && !policy.allowedAgents.includes(agentName))) {
		return { agentName, error: `Cannot spawn '${agentName}'. Allowed: ${policy.allowedErrorText}` };
	}
	return { agentName };
}

export function describeUnknownAgent(agentName: string, agents: readonly AgentDefinition[]): string {
	const available = agents.map(agent => agent.name).join(", ") || "none";
	return `Unknown agent "${agentName}". Available: ${available}`;
}

export function describeDisabledAgent(
	agentName: string,
	agents: readonly AgentDefinition[],
	disabledAgents: readonly string[],
): string {
	const enabled = agents.filter(agent => !disabledAgents.includes(agent.name)).map(agent => agent.name);
	return `Agent "${agentName}" is disabled in settings. Enable it via /agents, or use a different agent type.${enabled.length > 0 ? ` Available: ${enabled.join(", ")}` : ""}`;
}
