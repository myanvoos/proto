import type { ToolSession } from "../../tools";
import {
	type ExecutorBackend,
	type ExecutorBackendExecOptions,
	type ExecutorBackendResult,
	resolveEvalUrlRoots,
} from "../backend";
import {
	readSetting,
	namespaceSessionId as sharedNamespace,
	readInterpreterSetting as sharedReadInterpreterSetting,
	toExecutorBackendResult,
} from "../backend-helpers";
import { fsObservationLedgerFor } from "../fs-observations";
import { kernelTargetCwd, parseKernelTarget } from "../kernel-target";
import { executePython, type PythonExecutorOptions } from "./executor";
import { checkPythonKernelAvailability } from "./kernel";

const PYTHON_SESSION_PREFIX = "python:";

export function namespaceSessionId(sessionId: string): string {
	return sharedNamespace(sessionId, PYTHON_SESSION_PREFIX);
}

function readInterpreterSetting(session: ToolSession): string | undefined {
	return sharedReadInterpreterSetting(session, "python.interpreter");
}
export default {
	id: "python",
	label: "Python",
	highlightLang: "python",

	async isAvailable(session: ToolSession): Promise<boolean> {
		const availability = await checkPythonKernelAvailability(session.cwd, readInterpreterSetting(session));
		return availability.ok;
	},

	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const kernelMode = readSetting<PythonExecutorOptions["kernelMode"]>(opts.session, "python.kernelMode");
		const target = parseKernelTarget(opts.target);
		const remote = target.kind !== "local";
		const executorOptions: PythonExecutorOptions = {
			target,
			cwd: remote ? kernelTargetCwd(target, opts.cwd) : opts.cwd,
			runCwd: remote ? kernelTargetCwd(target, opts.runCwd ?? opts.cwd) : opts.runCwd,
			bridgeCwd: remote ? undefined : (opts.runCwd ?? opts.cwd),
			idleTimeoutMs: opts.idleTimeoutMs,
			signal: opts.signal,
			sessionId: namespaceSessionId(opts.sessionId),
			kernelMode,
			interpreter: opts.interpreter ?? (remote ? target.interpreter : readInterpreterSetting(opts.session)),
			sessionFile: opts.sessionFile,
			artifactsDir: opts.session.getArtifactsDir?.() ?? undefined,
			localRoots: remote ? undefined : resolveEvalUrlRoots(opts.session),
			kernelOwnerId: opts.kernelOwnerId,
			reset: opts.reset,
			onChunk: opts.onChunk,
			onStream: opts.onStream,
			onBytes: opts.onBytes,
			onDisplay: opts.onDisplay,
			shellEnv: remote ? undefined : opts.shellEnv,
			stdin: opts.stdin,
			onStatus: opts.onStatus,
			completionContext: opts.completionContext,
			toolSession: opts.session,
			fsObservations: remote ? undefined : fsObservationLedgerFor(opts.session).drain(),
		};
		const result = await executePython(code, executorOptions);
		return toExecutorBackendResult(result);
	},
} satisfies ExecutorBackend;
