import { prompt } from "@oh-my-pi/pi-utils";
import taskSummaryTemplate from "../prompts/tools/worker-summary.md" with { type: "text" };
import { AgentRegistry } from "../registry/agent-registry";
import { formatBytes, formatDuration } from "../tools/render-utils";
import type { SingleResult } from "./types";

export function formatResultOutputFallback(result: Pick<SingleResult, "output" | "stderr" | "requests">): string {
	const base = result.output.trim() || result.stderr.trim();
	if (base) return base;
	return result.requests > 0 ? `(no output) after ${result.requests} req` : "(no output)";
}

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
