import type { ToolSession } from "../../tools";
import {
	type ExecutorBackend,
	type ExecutorBackendExecOptions,
	type ExecutorBackendResult,
	resolveEvalUrlRoots,
} from "../backend";
import { namespaceSessionId as sharedNamespace, toExecutorBackendResult } from "../backend-helpers";
import type { JsKernelRuntime } from "../kernel-environment";
import { kernelTargetCwd, parseKernelTarget } from "../kernel-target";
import { executeJs } from "./executor";

/** Kernel session id of a JavaScript lane; `node` and `bun` kernels of one lane are separate sessions. */
export function namespaceSessionId(sessionId: string, runtime: JsKernelRuntime): string {
	return sharedNamespace(sessionId, `${runtime}:`);
}

function createJsBackend(runtime: JsKernelRuntime, label: string): ExecutorBackend {
	return {
		id: "js",
		label,
		highlightLang: "javascript",

		async isAvailable(_session: ToolSession): Promise<boolean> {
			return true;
		},

		async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
			const target = parseKernelTarget(opts.target);
			const remote = target.kind !== "local";
			const result = await executeJs(code, {
				runtime,
				target,
				interpreter: opts.interpreter,
				cwd: remote ? kernelTargetCwd(target, opts.runCwd ?? opts.cwd) : (opts.runCwd ?? opts.cwd),
				idleTimeoutMs: opts.idleTimeoutMs,
				signal: opts.signal,
				sessionId: namespaceSessionId(opts.sessionId, runtime),
				kernelOwnerId: opts.kernelOwnerId,
				sessionFile: opts.sessionFile,
				reset: opts.reset,
				onChunk: opts.onChunk,
				onStream: opts.onStream,
				onBytes: opts.onBytes,
				shellEnv: remote ? undefined : opts.shellEnv,
				stdin: opts.stdin,
				onStatus: opts.onStatus,
				onDisplay: opts.onDisplay,
				completionContext: opts.completionContext,
				session: opts.session,
				localRoots: remote ? undefined : resolveEvalUrlRoots(opts.session),
			});
			return toExecutorBackendResult(result);
		},
	};
}

/** `node` cells: the kernel runs in the real Node.js the command resolves to. */
export const nodeBackend = createJsBackend("node", "Node.js");
/** `bun` cells: the kernel runs in Bun (this host's, or the target's). */
export const bunBackend = createJsBackend("bun", "Bun");
