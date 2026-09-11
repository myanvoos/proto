import path from "node:path";
import { type DiscoveryResult, discoverAgents } from "./discovery";

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

const MAX_DISCOVERY_MEMO_ENTRIES = 16;
const discoveryMemo = new Map<string, Promise<DiscoveryResult>>();
let discoveryMemoFn: typeof discoverAgents | undefined;

function discoverAgentsForCreate(cwd: string): Promise<DiscoveryResult> {
	const fn = discoverAgents;
	if (discoveryMemoFn !== fn) {
		discoveryMemoFn = fn;
		discoveryMemo.clear();
	}
	const key = path.resolve(cwd);
	let pending = discoveryMemo.get(key);
	if (pending) {
		discoveryMemo.delete(key);
		discoveryMemo.set(key, pending);
		return pending;
	}
	pending = fn(cwd);
	discoveryMemo.set(key, pending);
	while (discoveryMemo.size > MAX_DISCOVERY_MEMO_ENTRIES) {
		const oldestKey = discoveryMemo.keys().next().value;
		if (oldestKey === undefined) break;
		discoveryMemo.delete(oldestKey);
	}
	pending.catch(() => {
		if (discoveryMemo.get(key) === pending) discoveryMemo.delete(key);
	});
	return pending;
}

export async function refreshAgentDiscovery(cwd: string): Promise<void> {
	const key = path.resolve(cwd);
	discoveryMemo.delete(key);
	await discoverAgentsForCreate(cwd);
}
