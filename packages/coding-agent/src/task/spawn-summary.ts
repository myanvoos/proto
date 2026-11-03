import { prompt } from "@oh-my-pi/pi-utils";
import taskSummaryTemplate from "../prompts/tools/worker-summary.md" with { type: "text" };
import { AgentRegistry } from "../registry/agent-registry";
import { ASYNC_INLINE_RESULT_MAX_CHARS } from "../session/async-job-delivery";
import { escapeHarnessTags } from "../session/harness-tags";
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
	const inlineThreshold = ASYNC_INLINE_RESULT_MAX_CHARS - 1_000;
	const previewHead = (): string => {
		const slice = output.slice(0, 3_000);
		const lastNewline = slice.lastIndexOf("\n");
		return lastNewline >= 1_500 ? slice.slice(0, lastNewline) : slice;
	};

	const refStatus = AgentRegistry.global().get(result.id)?.status;
	const resumable = result.aborted && (refStatus === "idle" || refStatus === "parked");
	const render = (truncated: boolean): string =>
		prompt.render(taskSummaryTemplate, {
			agentName: args.agentName,
			id: result.id,
			status,
			model: result.resolvedModel,
			duration: formatDuration(totalDurationMs),
			abortReason: result.aborted ? escapeHarnessTags(result.abortReason ?? "") || undefined : undefined,
			resumable,
			preview: escapeHarnessTags(truncated ? previewHead() : output),
			truncated,
			meta: result.outputMeta
				? {
						lineCount: result.outputMeta.lineCount,
						charSize: formatBytes(result.outputMeta.charCount),
					}
				: undefined,
			mergeSummary: mergeSummary === undefined ? undefined : escapeHarnessTags(mergeSummary),
		});
	const truncated = outputCharCount > inlineThreshold && result.outputPath !== undefined;
	const summary = render(truncated);
	return !truncated && result.outputPath !== undefined && summary.length > ASYNC_INLINE_RESULT_MAX_CHARS
		? render(true)
		: summary;
}
