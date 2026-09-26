import type { EvalCompletionInvocationContext } from "../completion-bridge";
import type { KernelTarget } from "../kernel-target";
import type { JsDisplayOutput } from "./shared/types";

export type { JsDisplayOutput } from "./shared/types";

export interface SessionSnapshot {
	cwd: string;
	generation?: string;
	discoveryCwd?: string;
	target?: KernelTarget;
	interpreter?: string;
	shellEnv?: Record<string, string>;
	stdin?: boolean;
	sessionId: string;

	localRoots?: Record<string, string>;
}

export interface RunErrorPayload {
	name?: string;
	message: string;
	stack?: string;
	isAbort?: boolean;
	isToolError?: boolean;
}

export type ToolReply = { ok: true; value: unknown } | { ok: false; error: RunErrorPayload };

export type WorkerInbound =
	| { type: "init"; snapshot: SessionSnapshot }
	| {
			type: "run";
			runId: string;
			code: string;
			filename: string;
			snapshot: SessionSnapshot;
			completionContext?: EvalCompletionInvocationContext;
	  }
	| { type: "stdin"; runId: string; data: string; eof: boolean }
	| { type: "output-ack"; id: string }
	| { type: "tool-reply"; id: string; reply: ToolReply }
	| { type: "close" };

export type WorkerOutbound =
	| { type: "ready"; interpreter?: string }
	| { type: "init-failed"; error: RunErrorPayload }
	| { type: "text"; runId: string; id?: string; chunk: string; stream?: "stdout" | "stderr" }
	| { type: "bytes"; runId: string; id: string; data: string; stream: "stdout" | "stderr" }
	| { type: "stdin-request"; runId: string }
	| { type: "display"; runId: string; output: JsDisplayOutput }
	| { type: "tool-call"; id: string; runId: string; name: string; args: unknown; completionInvocationId?: string }
	// `exitCode`: the cell called `process.exit()`, which ends the cell — not the kernel — with that status.
	| { type: "result"; runId: string; ok: true; exitCode?: number }
	| { type: "result"; runId: string; ok: false; error: RunErrorPayload }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> }
	| { type: "closed" };

export interface Transport {
	send(msg: WorkerOutbound): void;
	onMessage(handler: (msg: WorkerInbound) => void): () => void;
	close(): void;
}
