import {
	type ExecutionMetadata,
	type ExecutionTimeoutMetadata,
	executionMetadataForResult,
} from "../../session/execution-metadata";
import { DEFAULT_MAX_BYTES, OutputSink, type OutputSummary } from "../../session/streaming-output";
import type { ToolSession } from "../../tools";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../../tools/output-meta";
import { isEvalTimeoutControlEvent } from "../bridge-timeout";
import type { EvalCompletionInvocationContext } from "../completion-bridge";
import { executeInVmContext, type JsDisplayOutput } from "./context-manager";
import type { JsStatusEvent } from "./shared/types";

interface JsExecutorOptions {
	cwd?: string;
	timeoutMs?: number;
	deadlineMs?: number;

	idleTimeoutMs?: number;
	onChunk?: (chunk: string) => Promise<void> | void;
	onStatus?: (event: JsStatusEvent) => void;
	signal?: AbortSignal;
	sessionId: string;

	kernelOwnerId?: string;
	reset?: boolean;
	sessionFile?: string;
	artifactPath?: string;
	artifactId?: string;
	session: ToolSession;

	localRoots?: Record<string, string>;
	completionContext?: EvalCompletionInvocationContext;
}

export interface JsResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	timedOut?: boolean;
	signal?: string | number;
	execution?: ExecutionMetadata;
	truncated: boolean;
	artifactId?: string;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	collector?: { state: "running" | "complete" | "failed" | "unavailable"; error?: string };
	outputDisposition?: "complete" | "truncated" | "summarized" | "unavailable";
	summarized?: boolean;
	actionableDiagnostics?: string[];
	displayOutputs: JsDisplayOutput[];
}

function getExecutionTimeoutMs(options: Pick<JsExecutorOptions, "deadlineMs" | "timeoutMs">): number | undefined {
	if (options.deadlineMs !== undefined) {
		return Math.max(1, options.deadlineMs - Date.now());
	}
	return options.timeoutMs;
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
	);
}

function isTimeoutReason(reason: unknown): boolean {
	return (
		(reason instanceof DOMException && reason.name === "TimeoutError") ||
		(reason instanceof Error && reason.name === "TimeoutError")
	);
}

function formatJsTimeoutAnnotation(timeoutMs: number | undefined): string {
	const reset = "The JS worker was force-killed and its VM state was reset; variables from earlier cells are gone.";
	if (timeoutMs === undefined) return `Command timed out. ${reset}`;
	const secs = Math.max(1, Math.round(timeoutMs / 1000));
	return `Command timed out after ${secs} seconds. ${reset}`;
}

export async function executeJs(code: string, options: JsExecutorOptions): Promise<JsResult> {
	const displayOutputs: JsDisplayOutput[] = [];
	const outputSink = new OutputSink({
		artifactPath: options.artifactPath,
		artifactId: options.artifactId,
		spillThreshold: DEFAULT_MAX_BYTES,
		headBytes: resolveOutputSinkHeadBytes(options.session.settings),
		maxColumns: resolveOutputMaxColumns(options.session.settings),
		onChunk: chunk => options.onChunk?.(chunk),
	});
	const legacyTimeoutMs = getExecutionTimeoutMs(options);
	const timeoutSignal =
		typeof legacyTimeoutMs === "number" && Number.isFinite(legacyTimeoutMs) && legacyTimeoutMs > 0
			? AbortSignal.timeout(legacyTimeoutMs)
			: undefined;
	const signal =
		options.signal && timeoutSignal
			? AbortSignal.any([options.signal, timeoutSignal])
			: (options.signal ?? timeoutSignal);

	const acquireBudgetMs = legacyTimeoutMs ?? options.idleTimeoutMs;
	const executionStartedAt = performance.now();
	const resultWithSummary = (
		summary: OutputSummary,
		base: Pick<JsResult, "exitCode" | "cancelled"> & { timedOut?: boolean },
	): JsResult => {
		const result: JsResult = { ...summary, ...base, displayOutputs };
		const timeout: ExecutionTimeoutMetadata | undefined = result.timedOut
			? {
					cause: options.idleTimeoutMs !== undefined ? "idle" : "deadline",
					scope: "cell",
					requestedMs: legacyTimeoutMs ?? options.idleTimeoutMs,
					effectiveMs: legacyTimeoutMs ?? options.idleTimeoutMs,
				}
			: undefined;
		return {
			...result,
			execution: executionMetadataForResult(result, {
				elapsedMs: performance.now() - executionStartedAt,
				timeout,
				summary: result,
			}),
		};
	};

	try {
		await executeInVmContext({
			sessionKey: options.sessionId,
			sessionId: options.sessionId,
			ownerId: options.kernelOwnerId,
			cwd: options.cwd ?? options.session.cwd,
			session: options.session,
			localRoots: options.localRoots,
			completionContext: options.completionContext,
			reset: options.reset,
			onStatus: options.onStatus,
			code,
			filename: `js-cell-${crypto.randomUUID()}.js`,
			timeoutMs: acquireBudgetMs,
			runState: {
				signal,
				onText: chunk => outputSink.push(chunk),
				onDisplay: output => {
					if (output.type === "status") {
						options.onStatus?.(output.event);
						if (isEvalTimeoutControlEvent(output.event)) return;
					}
					displayOutputs.push(output);
				},
			},
		});
		const summary = await outputSink.dump();
		return resultWithSummary(summary, { exitCode: 0, cancelled: false });
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) {
			const timedOut = Boolean(timeoutSignal?.aborted) || isTimeoutReason(options.signal?.reason);
			if (timedOut) {
				outputSink.push(formatJsTimeoutAnnotation(legacyTimeoutMs ?? options.idleTimeoutMs));
			}
			const summary = await outputSink.dump();
			return resultWithSummary(summary, { exitCode: undefined, cancelled: true, timedOut });
		}
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		outputSink.push(message);
		const summary = await outputSink.dump();
		return resultWithSummary(summary, { exitCode: 1, cancelled: false });
	} finally {
		await outputSink.dispose();
	}
}
