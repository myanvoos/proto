import { logger } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import {
	type ExecutionMetadata,
	type ExecutionTimeoutMetadata,
	executionMetadataForResult,
} from "../session/execution-metadata";
import { OutputSink, type OutputSummary } from "../session/streaming-output";
import type { ToolSession } from "../tools";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP, isEvalTimeoutControlEvent } from "./bridge-timeout";
import type { EvalCompletionInvocationContext } from "./completion-bridge";
import type { FsObservation } from "./fs-observations";
import type { JsStatusEvent } from "./js/shared/types";
import type { KernelDisplayOutput } from "./py/display";
import { registerPyToolBridge } from "./py/tool-bridge";

export type CancelledErrorClass = new (timedOut: boolean) => Error & { timedOut: boolean };

type KernelEnvPatch = Record<string, string | null | undefined>;

interface KernelExecutorBaseOptions {
	cwd?: string;
	runCwd?: string;
	timeoutMs?: number;
	deadlineMs?: number;
	idleTimeoutMs?: number;
	onChunk?: (chunk: string) => Promise<void> | void;
	signal?: AbortSignal;
	onStatus?: (event: JsStatusEvent) => void;
	emitStatus?: (event: JsStatusEvent) => void;
	toolSession?: ToolSession;
	bridgeSessionId?: string;
	artifactId?: string;
	artifactPath?: string;
	fsObservations?: FsObservation[];
	completionContext?: EvalCompletionInvocationContext;
}

interface KernelExecutionResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	timedOut?: boolean;
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
	displayOutputs: KernelDisplayOutput[];
	stdinRequested: boolean;
}

export interface GenericKernel<TEnv> {
	execute(
		code: string,
		options: {
			cwd?: string;
			env?: TEnv;
			fsObservations?: FsObservation[];
			id: string;
			signal?: AbortSignal;
			timeoutMs?: number;
			onChunk: (text: string) => Promise<void> | void;
			onDisplay: (output: KernelDisplayOutput) => Promise<void> | void;
		},
	): Promise<{
		status: "ok" | "error";
		cancelled: boolean;
		timedOut: boolean;
		kernelKilled?: boolean;
		stdinRequested?: boolean;
	}>;
}

export function getExecutionDeadlineMs(options?: { deadlineMs?: number; timeoutMs?: number }): number | undefined {
	if (options?.deadlineMs !== undefined) return options.deadlineMs;
	if (options?.timeoutMs === undefined) return undefined;
	return Date.now() + options.timeoutMs;
}

export function getRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	if (deadlineMs === undefined) return undefined;
	return deadlineMs - Date.now();
}

export function isCancellationError(error: unknown, cancelledErrorClass: CancelledErrorClass): boolean {
	return (
		error instanceof cancelledErrorClass ||
		(typeof DOMException !== "undefined" &&
			error instanceof DOMException &&
			(error.name === "AbortError" || error.name === "TimeoutError")) ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
	);
}

export function isTimedOutCancellation(
	error: unknown,
	cancelledErrorClass: CancelledErrorClass,
	signal?: AbortSignal,
): boolean {
	if (error instanceof cancelledErrorClass) return error.timedOut;
	if (typeof DOMException !== "undefined" && error instanceof DOMException) return error.name === "TimeoutError";
	if (error instanceof Error && error.name === "TimeoutError") return true;
	const reason = signal?.reason;
	if (typeof DOMException !== "undefined" && reason instanceof DOMException) return reason.name === "TimeoutError";
	return reason instanceof Error ? reason.name === "TimeoutError" : false;
}

export async function waitForPromiseWithCancellation<T>(
	promise: Promise<T>,
	options: { signal?: AbortSignal; deadlineMs?: number },
	cancelledErrorClass: CancelledErrorClass,
	timedOutResolver?: (error: unknown, signal?: AbortSignal) => boolean,
): Promise<T> {
	if (options.signal?.aborted) {
		throw new cancelledErrorClass(
			timedOutResolver?.(options.signal.reason, options.signal) ??
				isTimedOutCancellation(options.signal.reason, cancelledErrorClass, options.signal),
		);
	}
	const remainingMs = getRemainingTimeoutMs(options.deadlineMs);
	if (remainingMs !== undefined && remainingMs <= 0) {
		throw new cancelledErrorClass(true);
	}
	if (!options.signal && remainingMs === undefined) {
		return await promise;
	}

	const { promise: resultPromise, resolve, reject } = Promise.withResolvers<T>();
	const cleanups: Array<() => void> = [];
	const finish = (cb: () => void): void => {
		while (cleanups.length > 0) cleanups.pop()?.();
		cb();
	};
	if (options.signal) {
		const onAbort = (): void =>
			finish(() =>
				reject(
					new cancelledErrorClass(
						timedOutResolver?.(options.signal?.reason, options.signal) ??
							isTimedOutCancellation(options.signal?.reason, cancelledErrorClass, options.signal),
					),
				),
			);
		options.signal.addEventListener("abort", onAbort, { once: true });
		cleanups.push(() => options.signal?.removeEventListener("abort", onAbort));
	}
	if (remainingMs !== undefined) {
		const timer = setTimeout(() => finish(() => reject(new cancelledErrorClass(true))), remainingMs);
		timer.unref();
		cleanups.push(() => clearTimeout(timer));
	}
	promise.then(
		value => finish(() => resolve(value)),
		err => finish(() => reject(err)),
	);
	return await resultPromise;
}

interface BridgeAbortShield {
	signal: AbortSignal | undefined;
	abortRequested: boolean;
	timedOut: boolean;
	handleStatus?: (event: JsStatusEvent) => void;
	dispose?: () => void;
}

function createBridgeAbortShield(source: AbortSignal | undefined): BridgeAbortShield {
	const shield: BridgeAbortShield = {
		signal: undefined,
		abortRequested: false,
		timedOut: false,
	};
	if (!source) return shield;

	const controller = new AbortController();
	let pauseDepth = 0;
	let abortReason: unknown;
	let removeAbortListener: (() => void) | undefined;

	const requestAbort = (reason: unknown): void => {
		shield.abortRequested = true;
		shield.timedOut =
			shield.timedOut ||
			(typeof DOMException !== "undefined" && reason instanceof DOMException
				? reason.name === "TimeoutError"
				: reason instanceof Error && reason.name === "TimeoutError");
		abortReason = reason;
		if (pauseDepth > 0 || controller.signal.aborted) return;
		controller.abort(reason);
	};

	const onAbort = (): void => {
		const reason = source.reason;
		requestAbort(reason);
	};

	shield.signal = controller.signal;
	shield.handleStatus = (event: JsStatusEvent): void => {
		if (event.deferExternalAbort !== true) return;
		if (event.op === EVAL_TIMEOUT_PAUSE_OP) {
			pauseDepth++;
			return;
		}
		if (event.op !== EVAL_TIMEOUT_RESUME_OP || pauseDepth === 0) return;
		pauseDepth--;
		if (shield.abortRequested && !controller.signal.aborted) controller.abort(abortReason);
	};
	shield.dispose = (): void => {
		removeAbortListener?.();
		removeAbortListener = undefined;
	};

	if (source.aborted) {
		requestAbort(source.reason);
	} else {
		source.addEventListener("abort", onAbort, { once: true });
		removeAbortListener = () => {
			source.removeEventListener("abort", onAbort);
		};
		if (source.aborted) {
			source.removeEventListener("abort", onAbort);
			removeAbortListener = undefined;
			requestAbort(source.reason);
		}
	}

	return shield;
}

export function createCancelledKernelResult(output: string): KernelExecutionResult {
	const outputBytes = Buffer.byteLength(output, "utf-8");
	const outputLines = output.length > 0 ? 1 : 0;
	return {
		output,
		exitCode: undefined,
		cancelled: true,
		truncated: false,
		artifactId: undefined,
		totalLines: outputLines,
		totalBytes: outputBytes,
		outputLines,
		outputBytes,
		displayOutputs: [],
		stdinRequested: false,
	};
}

const MANAGED_KERNEL_ENV_KEYS = [
	"PI_SESSION_FILE",
	"PI_ARTIFACTS_DIR",
	"PI_TOOL_BRIDGE_URL",
	"PI_TOOL_BRIDGE_TOKEN",
	"PI_TOOL_BRIDGE_SESSION",
	"PI_EVAL_LOCAL_ROOTS",
] as const;

interface ManagedKernelEnvOptions {
	sessionFile?: string;
	artifactsDir?: string;
	bridgeSessionId?: string;
	bridge?: { url: string; token: string };
	localRoots?: Record<string, string>;
}
interface ManagedKernelEnvPolicy {
	sparse?: boolean;
}

export function buildManagedKernelEnvPatch(options: ManagedKernelEnvOptions): Record<string, string | null>;
export function buildManagedKernelEnvPatch(
	options: ManagedKernelEnvOptions,
	policy: { sparse: true },
): Record<string, string | undefined>;
export function buildManagedKernelEnvPatch(
	options: ManagedKernelEnvOptions,
	policy?: ManagedKernelEnvPolicy,
): KernelEnvPatch {
	const localRoots = options.localRoots;
	if (policy?.sparse) {
		const patch: Record<string, string | undefined> = {};
		if (options.sessionFile) patch.PI_SESSION_FILE = options.sessionFile;
		if (options.artifactsDir) patch.PI_ARTIFACTS_DIR = options.artifactsDir;
		if (options.bridge) {
			patch.PI_TOOL_BRIDGE_URL = options.bridge.url;
			patch.PI_TOOL_BRIDGE_TOKEN = options.bridge.token;
			patch.PI_TOOL_BRIDGE_SESSION = options.bridgeSessionId ?? "";
		}
		if (localRoots) patch.PI_EVAL_LOCAL_ROOTS = JSON.stringify(localRoots);
		return patch;
	}
	return {
		PI_SESSION_FILE: options.sessionFile ?? null,
		PI_ARTIFACTS_DIR: options.artifactsDir ?? null,
		PI_TOOL_BRIDGE_URL: options.bridge?.url ?? null,
		PI_TOOL_BRIDGE_TOKEN: options.bridge?.token ?? null,
		PI_TOOL_BRIDGE_SESSION: options.bridge && options.bridgeSessionId ? options.bridgeSessionId : null,
		PI_EVAL_LOCAL_ROOTS: localRoots && Object.keys(localRoots).length > 0 ? JSON.stringify(localRoots) : null,
	};
}

export function buildManagedKernelEnv(
	options: ManagedKernelEnvOptions,
	policy?: ManagedKernelEnvPolicy,
): Record<string, string> | undefined {
	const patch = policy?.sparse
		? buildManagedKernelEnvPatch(options, { sparse: true })
		: buildManagedKernelEnvPatch(options);
	const env: Record<string, string> = {};
	let hasKeys = false;
	for (const key of MANAGED_KERNEL_ENV_KEYS) {
		const value = patch[key];
		if (typeof value === "string") {
			env[key] = value;
			hasKeys = true;
		}
	}
	return hasKeys ? env : undefined;
}

export function attachSessionOwner(
	session: { ownerIds: Set<string>; hasFallbackOwner: boolean },
	sessionId: string,
	ownerId: string | undefined,
): void {
	if (ownerId !== undefined) {
		if (session.hasFallbackOwner) {
			session.ownerIds.delete(sessionId);
			session.hasFallbackOwner = false;
		}
		session.ownerIds.add(ownerId);
		return;
	}
	if (session.hasFallbackOwner || session.ownerIds.size === 0) {
		session.ownerIds.add(sessionId);
		session.hasFallbackOwner = true;
	}
}

export interface SessionOwners {
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
}

export function resolveOwnerScopedSessionKey(options: {
	baseKey: string;
	ownerId: string | undefined;
	reset: boolean;

	hasSession: (key: string) => boolean;

	getOwners: (key: string) => SessionOwners | undefined;
}): string {
	const { baseKey, ownerId } = options;
	if (ownerId === undefined) return baseKey;
	const forkKey = `${baseKey}\0fork\0${ownerId}`;
	if (options.hasSession(forkKey)) return forkKey;
	if (!options.reset) return baseKey;
	const base = options.getOwners(baseKey);
	if (!base) return baseKey;
	const exclusive = !base.hasFallbackOwner && base.ownerIds.size === 1 && base.ownerIds.has(ownerId);
	return exclusive ? baseKey : forkKey;
}

interface ExecuteWithKernelBaseParams<
	TOptions extends KernelExecutorBaseOptions,
	TEnv extends KernelEnvPatch = Record<string, string | null>,
> {
	kernel: GenericKernel<TEnv>;
	code: string;
	options: TOptions | undefined;

	runIdPrefix: string;

	errorLogLabel: string;

	cancelledErrorClass: CancelledErrorClass;
	buildKernelEnvPatch: (options: TOptions) => TEnv;
	formatKernelTimeoutAnnotation: (executionTimeoutMs: number | undefined, kernelKilled: boolean) => string;
	formatTimeoutAnnotation: (executionTimeoutMs: number | undefined) => string | undefined;

	resolveDeadlineMs?: (options: TOptions | undefined) => number | undefined;
}

export async function executeWithKernelBase<
	TOptions extends KernelExecutorBaseOptions,
	TEnv extends KernelEnvPatch = Record<string, string | null>,
>(params: ExecuteWithKernelBaseParams<TOptions, TEnv>): Promise<KernelExecutionResult> {
	const {
		kernel,
		code,
		options,
		runIdPrefix,
		errorLogLabel,
		cancelledErrorClass,
		buildKernelEnvPatch,
		formatKernelTimeoutAnnotation,
		formatTimeoutAnnotation,
		resolveDeadlineMs,
	} = params;

	const executionStartedAt = performance.now();
	const withExecutionMetadata = (result: KernelExecutionResult): KernelExecutionResult => {
		const timeout: ExecutionTimeoutMetadata | undefined = result.timedOut
			? {
					cause: options?.idleTimeoutMs !== undefined ? "idle" : "deadline",
					scope: "cell",
					requestedMs: options?.idleTimeoutMs ?? options?.timeoutMs,
					effectiveMs: executionTimeoutMs ?? options?.idleTimeoutMs,
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
	const resultWithDumpedOutput = (
		base: Pick<KernelExecutionResult, "exitCode" | "cancelled" | "stdinRequested"> & { timedOut?: boolean },
		dumped: OutputSummary,
	): KernelExecutionResult =>
		withExecutionMetadata({
			...dumped,
			...base,
			artifactId: dumped.artifactId,
			displayOutputs,
			stdinRequested: base.stdinRequested,
		});

	const settings = await Settings.init();
	const sink = new OutputSink({
		onChunk: options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
	});

	const displayOutputs: KernelDisplayOutput[] = [];
	const deadlineMs = (resolveDeadlineMs ?? getExecutionDeadlineMs)(options);
	let executionTimeoutMs: number | undefined;
	const abortShield = createBridgeAbortShield(options?.signal);

	const collectDisplay = (output: KernelDisplayOutput): void => {
		if (output.type === "status") {
			abortShield.handleStatus?.(output.event);
			options?.onStatus?.(output.event);
			if (isEvalTimeoutControlEvent(output.event)) return;
		}
		displayOutputs.push(output);
	};

	const emitStatus: (event: JsStatusEvent) => void =
		options?.emitStatus ?? (event => collectDisplay({ type: "status", event }));
	const runId = `${runIdPrefix}-${crypto.randomUUID()}`;

	const unregisterBridge =
		options?.toolSession && options?.bridgeSessionId
			? registerPyToolBridge(options.bridgeSessionId, runId, {
					toolSession: options.toolSession,
					signal: options.signal,
					shieldedSignal: abortShield.signal,
					emitStatus,
					completionContext: options?.completionContext,
					abortRequested: () => {
						return abortShield.abortRequested;
					},
				})
			: null;

	try {
		const remainingMs = getRemainingTimeoutMs(deadlineMs);
		if (remainingMs !== undefined) {
			if (remainingMs <= 0) {
				throw new cancelledErrorClass(true);
			}
			executionTimeoutMs = remainingMs;
		}

		const result = await kernel.execute(code, {
			cwd: options?.runCwd ?? options?.cwd,
			env: buildKernelEnvPatch(options ?? ({} as TOptions)),
			fsObservations: options?.fsObservations,
			id: runId,
			signal: abortShield.signal,
			timeoutMs: executionTimeoutMs,
			onChunk: text => sink.push(text),
			onDisplay: output => collectDisplay(output),
		});

		if (result.cancelled || abortShield.abortRequested) {
			const timedOut = result.timedOut || abortShield.timedOut;
			const annotation = timedOut
				? formatKernelTimeoutAnnotation(executionTimeoutMs ?? options?.idleTimeoutMs, result.kernelKilled ?? false)
				: result.kernelKilled && !abortShield.abortRequested
					? "Kernel died during execution; completion is uncertain. The cell was not replayed; check for partial side effects before retrying."
					: undefined;
			const dumped = await sink.dump(annotation);
			return resultWithDumpedOutput(
				{
					exitCode: undefined,
					cancelled: true,
					timedOut,
					stdinRequested: !!result.stdinRequested,
				},
				dumped,
			);
		}

		if (result.stdinRequested) {
			const dumped = await sink.dump("Kernel requested stdin; interactive input is not supported.");
			return resultWithDumpedOutput({ exitCode: 1, cancelled: false, stdinRequested: true }, dumped);
		}

		const exitCode = result.status === "ok" ? 0 : 1;
		const dumped = await sink.dump();
		return resultWithDumpedOutput({ exitCode, cancelled: false, stdinRequested: false }, dumped);
	} catch (err) {
		if (isCancellationError(err, cancelledErrorClass) || abortShield.abortRequested || abortShield.signal?.aborted) {
			const timedOut = abortShield.timedOut || isTimedOutCancellation(err, cancelledErrorClass, abortShield.signal);
			const dumped = await sink.dump(
				timedOut ? formatTimeoutAnnotation(executionTimeoutMs ?? options?.idleTimeoutMs) : undefined,
			);
			return resultWithDumpedOutput(
				{ exitCode: undefined, cancelled: true, timedOut, stdinRequested: false },
				dumped,
			);
		}
		const error = err instanceof Error ? err : new Error(String(err));
		logger.error(`${errorLogLabel} execution failed`, { error: error.message });
		throw error;
	} finally {
		await sink.dispose();
		unregisterBridge?.();
		abortShield.dispose?.();
	}
}
