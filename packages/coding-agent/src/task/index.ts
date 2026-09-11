import path from "node:path";
import { type DiscoveryResult, discoverAgents } from "./discovery";
import type { AgentDefinition } from "./types";

export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export * from "./read-only-policy";
export { formatResultOutputFallback, renderSpawnSummary } from "./spawn-summary";
export type {
	AgentDefinition,
	AgentProgress,
	ObservableAgentProgress,
	SingleResult,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "./types";
export {
	projectAgentProgress,
	WORKER_SUBAGENT_EVENT_CHANNEL,
	WORKER_SUBAGENT_LIFECYCLE_CHANNEL,
	WORKER_SUBAGENT_PROGRESS_CHANNEL,
} from "./types";

const discoveryMemo = new Map<string, Promise<DiscoveryResult>>();
const discoverySnapshots = new Map<string, AgentDefinition[]>();
let discoveryMemoFn: typeof discoverAgents | undefined;

function discoverAgentsForCreate(cwd: string): Promise<DiscoveryResult> {
	const fn = discoverAgents;
	if (discoveryMemoFn !== fn) {
		discoveryMemoFn = fn;
		discoveryMemo.clear();
		discoverySnapshots.clear();
	}
	const key = path.resolve(cwd);
	let pending = discoveryMemo.get(key);
	if (!pending) {
		pending = fn(cwd);
		discoveryMemo.set(key, pending);
		pending.catch(() => {
			if (discoveryMemo.get(key) === pending) discoveryMemo.delete(key);
		});
	}
	return pending;
}

export async function refreshAgentDiscovery(cwd: string): Promise<void> {
	const key = path.resolve(cwd);
	discoveryMemo.delete(key);
	const pending = discoverAgentsForCreate(cwd);
	const { agents } = await pending;
	if (discoveryMemo.get(key) === pending) {
		discoverySnapshots.set(key, agents);
	}
}
