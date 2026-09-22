import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobType } from "../async";
import asyncResultTemplate from "../prompts/tools/async-result.md" with { type: "text" };
import type { CustomMessage } from "./messages";

export const ASYNC_RESULT_MESSAGE_TYPE = "async-result";

export const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
export const ASYNC_PREVIEW_MAX_CHARS = 4_000;

export type AsyncArtifactAllocator = (toolType: string) => Promise<{ id?: string; path?: string }>;

/**
 * Shared cap for background-job text that reaches the model: inline while small, otherwise a
 * leading preview plus an `artifact://` pointer to the full text. Used by both async delivery
 * and `fleet` job snapshots so a single job never enters context twice at different sizes.
 */
export async function formatAsyncJobTextForContext(
	text: string,
	allocateArtifact?: AsyncArtifactAllocator,
): Promise<string> {
	if (text.length <= ASYNC_INLINE_RESULT_MAX_CHARS) {
		return text;
	}
	const preview = `${text.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
	try {
		const { path: artifactPath, id: artifactId } = (await allocateArtifact?.("async")) ?? {};
		if (artifactPath && artifactId) {
			await Bun.write(artifactPath, text);
			return `${preview}\nFull output: artifact://${artifactId}`;
		}
	} catch (error) {
		logger.warn("Failed to persist async job artifact", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return preview;
}

export interface AsyncResultEntry {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;

	epoch: number;
}

type AsyncResultJobDetails = {
	jobId: string;
	type?: AsyncJobType;
	label?: string;
	durationMs?: number;
	status?: AsyncJob["status"];
};

type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
};

export function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => ({
		jobId: entry.jobId,
		result: entry.result,
		type: entry.job?.type,
		label: entry.job?.label,
		durationMs: entry.durationMs,
		status: entry.job?.status,
		// The failure signal usually lives at the end of the output, which is exactly what the
		// context cap drops, so status has to be stated in the header instead.
		failed: entry.job?.status === "failed",
	}));
	const details: AsyncResultDetails = {
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			label: job.label,
			durationMs: job.durationMs,
			...(job.status ? { status: job.status } : {}),
		})),
	};
	return {
		role: "custom",
		customType: ASYNC_RESULT_MESSAGE_TYPE,
		content: prompt.render(asyncResultTemplate, {
			multiple: jobs.length > 1,
			anyFailed: jobs.some(job => job.failed),
			jobs,
		}),
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}
