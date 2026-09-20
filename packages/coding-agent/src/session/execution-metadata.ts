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
	/** Exit 1 came from a plain shell command, where it is a soft Unix signal
	 * (grep/rg "no match", test false, diff differences), not a failure.
	 * Kernel cells exit 1 on any raised exception, so they never set this. */
	softExit?: boolean;
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

/**
 * Classify an exit code as an unambiguous failure.
 *
 * Exit 1 is a soft signal for plain shell commands — grep/rg "no match",
 * test "[ ]" false, diff "differences found" — so it does not mark the
 * command as failed when `softExit` is set. Without that marker (kernel
 * cells exit 1 on any raised exception, and unknown origins) exit 1 is
 * hard. Everything else fails: 2-125 tool errors, 126/127 exec failures,
 * >=128 signal deaths, negative codes.
 */
export function isHardFailureExit(exitCode: number | undefined, softExit?: boolean): boolean {
	if (exitCode === undefined || exitCode === 0) return false;
	if (exitCode === 1 && softExit === true) return false;
	return true;
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
		softExit?: boolean;
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
		softExit: options.softExit === true || undefined,
		signal: result.signal,
		elapsedMs: options.elapsedMs,
		timeout: options.timeout,
		collector: summary?.collector ?? { state: "unavailable", error: "Output summary unavailable" },
		renderer: { state: "not-run" },
		output,
		stages: options.stages,
	};
}
