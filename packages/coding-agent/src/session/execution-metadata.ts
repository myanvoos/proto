export type ExecutionState = "running" | "exited" | "unknown";

export type ExecutionTimeoutCause = "deadline" | "idle" | "signal" | "unknown";

export type ExecutionTimeoutScope = "command" | "stage" | "pipeline" | "cell" | "unknown";

export interface ExecutionTimeoutMetadata {
	cause: ExecutionTimeoutCause;
	scope: ExecutionTimeoutScope;
	requestedMs?: number;
	effectiveMs?: number;
}

export type ExecutionCollectorState = "running" | "complete" | "failed" | "unavailable";

export interface ExecutionCollectorMetadata {
	state: ExecutionCollectorState;
	error?: string;
}

export type ExecutionRendererState = "not-run" | "complete" | "failed" | "unavailable";

export interface ExecutionRendererMetadata {
	state: ExecutionRendererState;
	error?: string;
}

export type ExecutionOutputDisposition = "complete" | "truncated" | "summarized" | "unavailable";

export interface ExecutionOutputMetadata {
	disposition: ExecutionOutputDisposition;
	truncated?: boolean;
	summarized?: boolean;
	truncatedBy?: "lines" | "bytes" | "middle";
	truncatedLines?: number;
	truncatedBytes?: number;
	truncatedOutputLines?: number;
	truncatedOutputBytes?: number;
	truncatedTotalLines?: number;
	truncatedTotalBytes?: number;
	rawArtifactId?: string;
	actionableDiagnostics?: string[];
}

export interface ExecutionStageMetadata {
	index: number;
	state: ExecutionState;
	exitCode?: number;
	signal?: string | number;
	elapsedMs?: number;
	timeout?: ExecutionTimeoutMetadata;
}

export interface ExecutionMetadata {
	state: ExecutionState;
	exitCode?: number;
	signal?: string | number;
	elapsedMs?: number;
	timeout?: ExecutionTimeoutMetadata;
	collector: ExecutionCollectorMetadata;
	renderer?: ExecutionRendererMetadata;
	output?: ExecutionOutputMetadata;
	stages?: ExecutionStageMetadata[];
}

export function executionStateForResult(result: {
	exitCode: number | undefined;
	cancelled: boolean;
	timedOut?: boolean;
}): ExecutionState {
	if (result.exitCode !== undefined) return "exited";
	if (result.cancelled || result.timedOut === true) return "unknown";
	return "unknown";
}

export function executionOutputDisposition(options: {
	truncated?: boolean;
	summarized?: boolean;
	available?: boolean;
}): ExecutionOutputDisposition {
	if (options.available === false) return "unavailable";
	if (options.truncated === true) return "truncated";
	if (options.summarized === true) return "summarized";
	return "complete";
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface ExecutionSummaryInput {
	truncated: boolean;
	truncatedBy?: "lines" | "bytes" | "middle";
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	collector?: ExecutionCollectorMetadata;
	outputDisposition?: ExecutionOutputDisposition;
	summarized?: boolean;
	actionableDiagnostics?: string[];
	artifactId?: string;
}

export function executionMetadataForResult(
	result: { exitCode: number | undefined; cancelled: boolean; timedOut?: boolean; signal?: string | number },
	options: {
		elapsedMs?: number;
		timeout?: ExecutionTimeoutMetadata;
		summary?: ExecutionSummaryInput;
		stages?: ExecutionStageMetadata[];
		state?: ExecutionState;
	},
): ExecutionMetadata {
	const summary = options.summary;
	const output: ExecutionOutputMetadata = summary
		? {
				disposition:
					summary.outputDisposition ??
					executionOutputDisposition({ truncated: summary.truncated, summarized: summary.summarized }),
				truncated: summary.truncated || undefined,
				summarized: summary.summarized || undefined,
				truncatedBy: summary.truncatedBy,
				truncatedLines:
					summary.totalLines > summary.outputLines ? summary.totalLines - summary.outputLines : undefined,
				truncatedBytes:
					summary.totalBytes > summary.outputBytes ? summary.totalBytes - summary.outputBytes : undefined,
				truncatedOutputLines: summary.outputLines,
				truncatedOutputBytes: summary.outputBytes,
				truncatedTotalLines: summary.totalLines,
				truncatedTotalBytes: summary.totalBytes,
				rawArtifactId: summary.artifactId,
				actionableDiagnostics: summary.actionableDiagnostics,
			}
		: { disposition: "unavailable" };

	return {
		state: options.state ?? executionStateForResult(result),
		exitCode: result.exitCode,
		signal: result.signal,
		elapsedMs: options.elapsedMs,
		timeout: options.timeout,
		collector: summary?.collector ?? { state: "unavailable", error: "Output summary unavailable" },
		renderer: { state: "not-run" },
		output,
		stages: options.stages,
	};
}
