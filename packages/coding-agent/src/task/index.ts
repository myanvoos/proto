/**
 * Shared subagent delegation surface.
 *
 * Public delegation is owned by `orchestrate_spawn` and its companion tools;
 * this module keeps
 * the shared helpers: agent discovery publishing, result formatting, and the
 * type re-exports used by RPC/observer consumers.
 */
import path from "node:path";
import { prompt } from "@oh-my-pi/pi-utils";
import taskSummaryTemplate from "../prompts/tools/worker-summary.md" with { type: "text" };
import { AgentRegistry } from "../registry/agent-registry";
import { formatBytes, formatDuration } from "../tools/render-utils";
import { type DiscoveryResult, discoverAgents } from "./discovery";
import type { AgentDefinition, SingleResult } from "./types";

// Re-export types and utilities
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export * from "./read-only-policy";
export type {
	AgentDefinition,
	AgentProgress,
	SingleResult,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "./types";
export {
	WORKER_SUBAGENT_EVENT_CHANNEL,
	WORKER_SUBAGENT_LIFECYCLE_CHANNEL,
	WORKER_SUBAGENT_PROGRESS_CHANNEL,
} from "./types";

/**
 * Preview text for a child result. Falls back to "(no output)" — annotated
 * with the request count when the child actually did work, so the parent can
 * tell a no-op child from one that burned requests before being cancelled.
 */
export function formatResultOutputFallback(result: Pick<SingleResult, "output" | "stderr" | "requests">): string {
	const base = result.output.trim() || result.stderr.trim();
	if (base) return base;
	return result.requests > 0 ? `(no output) after ${result.requests} req` : "(no output)";
}

/** Build the settled-spawn summary text (status line + preview + metadata). */
export function renderSpawnSummary(args: {
	result: SingleResult;
	agentName: string;
	id: string;
	totalDurationMs: number;
	mergeSummary?: string;
}): string {
	const { result, totalDurationMs, mergeSummary } = args;
	const status = result.aborted
		? "cancelled"
		: result.exitCode === 0 && result.error
			? "merge failed"
			: result.exitCode === 0
				? "completed"
				: `failed (exit ${result.exitCode})`;
	const output = formatResultOutputFallback(result);
	const outputCharCount = result.outputMeta?.charCount ?? output.length;
	const fullOutputThreshold = 5000;
	let preview = output;
	let truncated = false;
	if (outputCharCount > fullOutputThreshold) {
		const slice = output.slice(0, fullOutputThreshold);
		const lastNewline = slice.lastIndexOf("\n");
		preview = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
		truncated = true;
	}
	// A stopped-but-adopted agent (soft-budget stop) stays messageable; tell
	// the parent so it can resume via fleet instead of redoing the work.
	const refStatus = AgentRegistry.global().get(result.id)?.status;
	const resumable = result.aborted && (refStatus === "idle" || refStatus === "parked");
	return prompt.render(taskSummaryTemplate, {
		agentName: args.agentName,
		id: result.id,
		status,
		duration: formatDuration(totalDurationMs),
		abortReason: result.aborted ? result.abortReason : undefined,
		resumable,
		preview,
		truncated,
		meta: result.outputMeta
			? {
					lineCount: result.outputMeta.lineCount,
					charSize: formatBytes(result.outputMeta.charCount),
				}
			: undefined,
		mergeSummary,
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// Discovery publishing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Process-level create-time discovery memo and published reload snapshots,
 * keyed by resolved cwd. Explicit plugin reloads replace the matching snapshot
 * so already-created tools advertise the latest definitions.
 */
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

/** Rescan one cwd and publish its definitions to existing and future spawn surfaces. */
export async function refreshAgentDiscovery(cwd: string): Promise<void> {
	const key = path.resolve(cwd);
	discoveryMemo.delete(key);
	const pending = discoverAgentsForCreate(cwd);
	const { agents } = await pending;
	if (discoveryMemo.get(key) === pending) {
		discoverySnapshots.set(key, agents);
	}
}

/** Latest published discovered-agent snapshot for a cwd (create-time memo). */
export function getDiscoveredAgentSnapshot(cwd: string): AgentDefinition[] {
	return discoverySnapshots.get(path.resolve(cwd)) ?? [];
}
