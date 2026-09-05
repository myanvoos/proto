import type { ExecutionMetadata } from "../session/execution-metadata";
import type { ToolSession } from "../tools";
import type { ExecutorBackendResult } from "./backend";
import type { EvalDisplayOutput } from "./types";

export function namespaceSessionId(sessionId: string, prefix: string): string {
	return sessionId.startsWith(prefix) ? sessionId : `${prefix}${sessionId}`;
}

export function readSetting<T>(session: ToolSession, key: string): T | undefined {
	const settings = session.settings as { get?: (key: string) => T | undefined } | undefined;
	return settings?.get?.(key);
}

export function readInterpreterSetting(session: ToolSession, key: string): string | undefined {
	const value = readSetting<unknown>(session, key);
	return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function toExecutorBackendResult(result: {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	timedOut?: boolean;
	signal?: string | number;
	execution?: ExecutionMetadata;
	truncated: boolean;
	artifactId?: string | undefined;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	collector?: { state: "running" | "complete" | "failed" | "unavailable"; error?: string };
	outputDisposition?: "complete" | "truncated" | "summarized" | "unavailable";
	summarized?: boolean;
	actionableDiagnostics?: string[];
	displayOutputs: EvalDisplayOutput[];
}): ExecutorBackendResult {
	return {
		output: result.output,
		exitCode: result.exitCode,
		cancelled: result.cancelled,
		timedOut: result.timedOut,
		signal: result.signal,
		execution: result.execution,
		truncated: result.truncated,
		artifactId: result.artifactId,
		totalLines: result.totalLines,
		totalBytes: result.totalBytes,
		outputLines: result.outputLines,
		outputBytes: result.outputBytes,
		collector: result.collector,
		outputDisposition: result.outputDisposition,
		summarized: result.summarized,
		actionableDiagnostics: result.actionableDiagnostics,
		displayOutputs: result.displayOutputs,
	};
}
