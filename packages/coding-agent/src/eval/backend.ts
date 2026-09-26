import * as fs from "node:fs";
import { buildEvalUrlRoots, type LocalProtocolOptions } from "../internal-urls";
import type { ExecutionMetadata } from "../session/execution-metadata";
import type { ToolSession } from "../tools";
import type { EvalCompletionInvocationContext } from "./completion-bridge";
import type { KernelTarget } from "./kernel-target";
import type { EvalDisplayOutput, EvalLanguage, EvalStatusEvent } from "./types";

export interface ExecutorBackendExecOptions {
	cwd: string;
	target?: KernelTarget;
	interpreter?: string;
	runCwd?: string;
	shellEnv?: Record<string, string>;
	stdin?: ReadableStream<Uint8Array>;
	sessionId: string;
	sessionFile: string | undefined;
	kernelOwnerId: string | undefined;
	signal?: AbortSignal;
	session: ToolSession;

	idleTimeoutMs?: number;
	reset: boolean;
	onChunk: (chunk: string) => void;
	onStream?: (text: string, stream: "stdout" | "stderr") => Promise<void> | void;
	onBytes?: (bytes: Uint8Array, stream: "stdout" | "stderr") => Promise<void> | void;
	/** Each admitted display as it happens, in stream order with onBytes. */
	onDisplay?: (output: EvalDisplayOutput) => Promise<void> | void;

	onStatus?: (event: EvalStatusEvent) => void;
	completionContext?: EvalCompletionInvocationContext;
}

export interface ExecutorBackendResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	timedOut?: boolean;
	signal?: string | number;
	execution?: ExecutionMetadata;
	truncated: boolean;
	artifactId: string | undefined;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	collector?: { state: "running" | "complete" | "failed" | "unavailable"; error?: string };
	outputDisposition?: "complete" | "truncated" | "summarized" | "unavailable";
	summarized?: boolean;
	actionableDiagnostics?: string[];
	displayOutputs: EvalDisplayOutput[];
}

export interface ExecutorBackend {
	readonly id: EvalLanguage;
	readonly label: string;

	readonly highlightLang: string;

	isAvailable(session: ToolSession): Promise<boolean>;

	execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult>;
}

export function resolveEvalUrlRoots(session: ToolSession): Record<string, string> {
	const options: LocalProtocolOptions = session.localProtocolOptions ?? {
		getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
		getSessionId: () => session.getSessionId?.() ?? null,
	};
	const roots = buildEvalUrlRoots(options);
	// Kernels write `local://`/`fleet://` files through raw file APIs, which never create parents.
	fs.mkdirSync(roots.local, { recursive: true });
	fs.mkdirSync(roots.fleet, { recursive: true });
	for (const skill of session.skills ?? []) roots[`skill:${skill.name}`] = skill.baseDir;
	return roots;
}
