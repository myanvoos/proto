import type { ToolSession } from "../../tools";
import type { EvalCompletionInvocationContext } from "../completion-bridge";
import type { KernelToolRequest } from "../kernel-base";
import type { EvalDisplayOutput, EvalStatusEvent } from "../types";

export type PythonHarnessEvent =
	| { type: "detection"; pid: number; argv: string[]; cwd: string; executable: string }
	| { type: "display"; output: EvalDisplayOutput }
	| { type: "status"; event: EvalStatusEvent };

/** Authority comes only from this host-owned registration, never request arguments. */
export interface PythonHarnessContext {
	session: ToolSession;
	runId: string;
	lane: string;
	cwd: string;
	signal: AbortSignal;
	toolCallId: string;
	kernelId?: string;
	completionContext?: EvalCompletionInvocationContext;
	onBytes?: (chunk: Uint8Array, stream: "stdout" | "stderr") => Promise<void>;
	emit?: (event: PythonHarnessEvent) => void;
}

export interface PythonHarnessRunOptions {
	transport?: "http" | "stdio";
	cwd?: string;
	lane?: string;
	toolCallId?: string;
	kernelId?: string;
	completionContext?: EvalCompletionInvocationContext;
	signal?: AbortSignal;
	env?: Record<string, string>;
	/** Native persistent shell prepends assets to its effective lane PYTHONPATH. */
	shell?: boolean;
	emit?: (event: PythonHarnessEvent) => void;
}

export interface PythonHarnessRun {
	env: Record<string, string>;
	readonly events: readonly PythonHarnessEvent[];
	request(request: KernelToolRequest, signal?: AbortSignal): Promise<unknown>;
	dispose(): Promise<void>;
}
