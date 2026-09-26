import { getNativeAddonPath } from "@oh-my-pi/pi-natives/loader";
import { isCompiledBinary, logger, Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import { currentExecutionOrigin, type ExecutionOrigin } from "../../jobs/origin";
import {
	createWorkerHandle,
	createWorkerSubprocess,
	resolveWorkerSpawnCmd,
	workerEnvFromParent,
} from "../../subprocess/worker-client";
import type { ToolSession } from "../../tools";
import { ToolAbortError, ToolError } from "../../tools/tool-errors";
import { safeSend as safeSendIpc } from "../../utils/ipc";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../bridge-timeout";
import type { EvalCompletionInvocationContext } from "../completion-bridge";
import { attachSessionOwner, resolveOwnerScopedSessionKey, type SessionOwners } from "../executor-base";
import { DEFAULT_KERNEL_IDLE_REAP_MS, type KernelReapNote } from "../idle-timeout";
import { kernelAdmission } from "../kernel-admission";
import { clearKernelLaneConfigurations, type JsKernelRuntime, validateKernelKeepalive } from "../kernel-environment";
import {
	type KernelCloseCause,
	type KernelSessionInfo,
	kernelCloseTermination,
	recordKernelCellTermination,
} from "../kernel-session-registry";
import { KernelInputReader } from "../kernel-streams";
import type { KernelTarget } from "../kernel-target";
import { kernelTargetCwd, parseKernelTarget } from "../kernel-target";
import type { KernelInvocation } from "../types";
import { withNativeInput } from "./native-input";
import { withNativeOutput } from "./native-output";
import { decodeNodeKernelMessage, encodeNodeKernelMessage } from "./node-protocol";
import {
	NODE_INTERPRETER_NOT_FOUND,
	NODE_REMOTE_TARGET_UNSUPPORTED,
	resolveNodeInterpreter,
	stageJsKernel,
} from "./node-runtime";
import { spawnTargetJsWorker } from "./target-worker";
import { callSessionTool, type JsStatusEvent } from "./tool-bridge";
import type {
	JsDisplayOutput,
	RunErrorPayload,
	SessionSnapshot,
	WorkerInbound,
	WorkerOutbound,
} from "./worker-protocol";

export type { JsDisplayOutput } from "./worker-protocol";

interface VmRunState {
	signal?: AbortSignal;
	onText?: (chunk: string, stream?: "stdout" | "stderr") => Promise<void> | void;
	onBytes?: (bytes: Uint8Array, stream: "stdout" | "stderr") => Promise<void> | void;
	retainedBytes?: () => number;
	release?: () => void;
	onDisplay?: (output: JsDisplayOutput) => void;
}

/** A settled cell; `exitCode` is the status its `process.exit()` asked for, else 0. */
interface VmRunResult {
	value: unknown;
	exitCode: number;
}

interface WorkerHandle {
	mode: "process" | "target" | "node";
	send(msg: WorkerInbound): void;
	onMessage(handler: (msg: WorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	close(): Promise<boolean>;
	terminate(): Promise<void>;
}

interface PendingRun {
	executionOrigin?: ExecutionOrigin;
	input: KernelInputReader;
	decoders: Record<"stdout" | "stderr", TextDecoder>;
	runId: string;
	runState: VmRunState;
	toolSession: ToolSession;
	/** Host-side cwd for this run's tool-bridge calls; absent for remote targets. */
	bridgeCwd?: string;
	resolve(value: VmRunResult): void;
	reject(error: Error): void;
	toolCalls: Map<string, AbortController>;
	completionContext?: EvalCompletionInvocationContext;

	deferDepth: number;

	deferDrained?: PromiseWithResolvers<void>;

	aborted: boolean;

	heldResult?: Extract<WorkerOutbound, { type: "result" }>;
	outputError?: Error;
	settled: boolean;
}

interface CompletedRunSink {
	decoders: Record<"stdout" | "stderr", TextDecoder>;
	runState: VmRunState;
	timer: NodeJS.Timeout;
}

interface JsSession {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	info: KernelSessionInfo;
	worker: WorkerHandle;
	state: "alive" | "stopping" | "dead";
	pending: Map<string, PendingRun>;
	completedRuns: Map<string, CompletedRunSink>;
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
	reapTimer?: NodeJS.Timeout;
	reapShutdownRetries: number;
	shutdown?: Promise<boolean>;
	releaseAdmission(): void;
}

interface StartingJsSession extends SessionOwners {
	promise: Promise<JsSession>;
	info: KernelSessionInfo;
	abort: AbortController;
}

const sessions = new Map<string, JsSession>();
const startingSessions = new Map<string, StartingJsSession>();
const resettingSessions = new Map<string, Promise<void>>();

const WORKER_INIT_TIMEOUT_MS = 15_000;
const WORKER_CLOSE_TIMEOUT_MS = 1_000;
const JS_EVAL_PROCESS_ARG = "__proto_worker_js_eval_process";

/** A lifecycle operation (close/reset) ended the kernel under a running cell: the cell is cancelled, not failed. */
export class JsKernelTerminatedError extends ToolAbortError {}

/** Errors cells raised themselves, as their kernels reported them — not failures of the harness running them. */
const cellErrors = new WeakSet<Error>();

/** Whether `error` is a cell's own uncaught error, whose stack locates the user's code. */
export function isJsCellError(error: unknown): error is Error {
	return error instanceof Error && cellErrors.has(error);
}

const workerCloseTimeoutMs: number = WORKER_CLOSE_TIMEOUT_MS;
const MAX_REAP_NOTES = 32;
const MAX_REAP_SHUTDOWN_RETRIES = 3;
const MAX_COMPLETED_RUN_SINKS = 256;
const MAX_COMPLETED_RUN_BYTES = 512 * 1024;
const COMPLETED_RUN_TTL_MS = 30_000;
const reapNotes = new Map<string, KernelReapNote>();

function armSessionReap(session: JsSession, delayMs = DEFAULT_KERNEL_IDLE_REAP_MS): void {
	if (session.reapTimer) clearTimeout(session.reapTimer);
	const delay = Math.max(delayMs, (session.info.keepAliveUntil ?? 0) - Date.now());
	const timer = setTimeout(() => void reapSessionFire(session), delay);
	timer.unref?.();
	session.reapTimer = timer;
}

function clearSessionReap(session: JsSession): void {
	if (session.reapTimer) clearTimeout(session.reapTimer);
	session.reapTimer = undefined;
}

async function reapSessionFire(session: JsSession): Promise<void> {
	session.reapTimer = undefined;
	if (sessions.get(session.sessionKey) !== session || session.state === "dead") return;
	if ((session.info.keepAliveUntil ?? 0) > Date.now()) {
		armSessionReap(session, 0);
		return;
	}
	// Busy covers anything the worker is still coordinating: backgrounded cells,
	// awaited tool/agent bridges, completion calls. Reset cycles also block reaping.
	if (
		session.pending.size > 0 ||
		startingSessions.has(session.sessionKey) ||
		resettingSessions.has(session.sessionKey)
	) {
		armSessionReap(session);
		return;
	}
	const confirmed = await killSession(session, new ToolError("JS eval context released after idle timeout"), {
		force: false,
	});
	if (!confirmed) {
		session.reapShutdownRetries += 1;
		logger.warn("JS eval context idle-reap shutdown not confirmed", {
			sessionKey: session.sessionKey,
			sessionId: session.sessionId,
			retries: session.reapShutdownRetries,
		});
		if (sessions.get(session.sessionKey) === session && session.reapShutdownRetries <= MAX_REAP_SHUTDOWN_RETRIES) {
			const backoff = DEFAULT_KERNEL_IDLE_REAP_MS * Math.min(2 ** session.reapShutdownRetries, 8);
			const timer = setTimeout(() => void reapSessionFire(session), backoff);
			timer.unref?.();
			session.reapTimer = timer;
		}
		return;
	}
	if (sessions.get(session.sessionKey) !== session) return;
	sessions.delete(session.sessionKey);
	logger.info("JS eval context released after idle timeout", {
		sessionKey: session.sessionKey,
		sessionId: session.sessionId,
		idleMs: DEFAULT_KERNEL_IDLE_REAP_MS,
	});
	reapNotes.set(session.sessionKey, { idleMs: DEFAULT_KERNEL_IDLE_REAP_MS, reapedAt: Date.now() });
	if (reapNotes.size > MAX_REAP_NOTES) {
		const oldestSessionKey = reapNotes.keys().next().value;
		if (oldestSessionKey !== undefined) reapNotes.delete(oldestSessionKey);
	}
}

export interface VmSessionOptions {
	signal?: AbortSignal;
	runtime: JsKernelRuntime;
	sessionKey: string;
	sessionId: string;
	ownerId?: string;
	cwd: string;
	discoveryCwd?: string;
	interpreter?: string;
	target?: KernelTarget;
	shellEnv?: Record<string, string>;
	reset?: boolean;
	onStatus?: (event: JsStatusEvent) => void;
	timeoutMs?: number;
}

export async function executeInVmContext(options: {
	runtime: JsKernelRuntime;
	sessionKey: string;
	sessionId: string;

	ownerId?: string;
	cwd: string;
	discoveryCwd?: string;
	interpreter?: string;
	target?: KernelTarget;
	session: ToolSession;
	shellEnv?: Record<string, string>;
	stdin?: ReadableStream<Uint8Array>;
	reset?: boolean;
	onStatus?: (event: JsStatusEvent) => void;
	completionContext?: EvalCompletionInvocationContext;
	invocation?: KernelInvocation;
	code: string;
	filename: string;
	timeoutMs?: number;
	runState: VmRunState;
}): Promise<VmRunResult> {
	if (options.runState.signal?.aborted) {
		throw reasonToError(options.runState.signal.reason, "Execution aborted");
	}
	const session = await prepareVmSession({ ...options, signal: options.runState.signal });
	const sessionKey = session.sessionKey;
	session.info.lastActivityAt = Date.now();
	armSessionReap(session);
	try {
		return await runOnce(session, options);
	} finally {
		if (sessions.get(sessionKey) === session && session.state === "alive") {
			session.info.lastActivityAt = Date.now();
			armSessionReap(session);
		}
	}
}

async function prepareVmSession(options: VmSessionOptions): Promise<JsSession> {
	options.signal?.throwIfAborted();
	const sessionKey = resolveOwnerScopedSessionKey({
		baseKey: options.sessionKey,
		ownerId: options.ownerId,
		reset: options.reset === true,
		hasSession: key => sessions.has(key) || startingSessions.has(key),
		getOwners: key => sessions.get(key) ?? startingSessions.get(key),
	});
	if (options.reset) {
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
		else {
			const resetPromise = resetVmContext(sessionKey);
			resettingSessions.set(
				sessionKey,
				resetPromise.then(() => undefined),
			);
			try {
				await resetPromise;
			} finally {
				resettingSessions.delete(sessionKey);
			}
		}
	} else {
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
	}
	const reapNote = reapNotes.get(sessionKey);
	if (reapNote) {
		reapNotes.delete(sessionKey);
		options.onStatus?.({ op: "kernel-idle-reap", idleMs: reapNote.idleMs, reapedAt: reapNote.reapedAt });
	}
	const session = await acquireSession(
		sessionKey,
		options.runtime,
		{
			cwd: options.cwd,
			discoveryCwd: options.discoveryCwd,
			interpreter: options.interpreter,
			target: options.target,
			sessionId: options.sessionId,
			shellEnv: options.shellEnv,
		},
		options.timeoutMs,
		options.ownerId,
		options.signal,
	);
	armSessionReap(session);
	return session;
}

function vmSessionInfo(session: JsSession): KernelSessionInfo {
	return {
		...session.info,
		cwd: session.cwd,
		state:
			session.state === "stopping" || resettingSessions.has(session.sessionKey)
				? "closing"
				: session.state === "dead"
					? "dead"
					: session.pending.size > 0
						? "busy"
						: "idle",
	};
}

export function listVmKernelSessions(ownerId?: string): KernelSessionInfo[] {
	const result: KernelSessionInfo[] = [];
	for (const session of sessions.values()) {
		if (ownerId === undefined || session.ownerIds.has(ownerId)) result.push(vmSessionInfo(session));
	}
	for (const [key, starting] of startingSessions) {
		if (!sessions.has(key) && (ownerId === undefined || starting.ownerIds.has(ownerId)))
			result.push({ ...starting.info });
	}
	return result;
}

export async function startVmKernelSession(options: VmSessionOptions): Promise<KernelSessionInfo> {
	return vmSessionInfo(await prepareVmSession(options));
}

export async function closeVmKernelSession(
	sessionKey: string,
	force = false,
	ownerId?: string,
	cause: KernelCloseCause = "close",
): Promise<void> {
	if (resettingSessions.has(sessionKey)) throw new ToolError("Kernel lifecycle operation already in progress");
	const existing = sessions.get(sessionKey);
	const starting = startingSessions.get(sessionKey);
	if (!existing && !starting) throw new ToolError("Unknown JavaScript kernel lane");
	if (!force && (starting || existing?.state === "stopping" || (existing?.pending.size ?? 0) > 0)) {
		throw new ToolError("Kernel is busy; close requires force:true");
	}
	const owned = existing ?? starting!;
	if (ownerId !== undefined && !owned.ownerIds.has(ownerId))
		throw new ToolError("Kernel is not owned by this session");
	if (ownerId !== undefined && owned.ownerIds.size > 1) {
		owned.ownerIds.delete(ownerId);
		starting?.ownerIds.delete(ownerId);
		return;
	}
	if (force) starting?.abort.abort(new ToolAbortError("JS context closed during startup"));
	// Only a forced close reaches a running cell; the shell bridge names it as the cell's end.
	if (existing && existing.pending.size > 0)
		recordKernelCellTermination(existing.sessionId, kernelCloseTermination(cause, force));
	const operation = (async () => {
		const session = existing ?? (await starting!.promise.catch(() => undefined));
		if (!session) return;
		if (!(await killSessionFor(session, new JsKernelTerminatedError("JS context explicitly closed"), { force }))) {
			throw new ToolError("JS context close shutdown not confirmed");
		}
	})();
	resettingSessions.set(sessionKey, operation);
	try {
		await operation;
	} finally {
		if (resettingSessions.get(sessionKey) === operation) resettingSessions.delete(sessionKey);
	}
}

export function keepaliveVmKernelSession(sessionKey: string, ttlMs: number): KernelSessionInfo {
	validateKernelKeepalive(ttlMs);
	const session = sessions.get(sessionKey);
	if (!session) throw new ToolError("Unknown JavaScript kernel lane");
	if (session.state !== "alive" || resettingSessions.has(sessionKey)) throw new ToolError("Kernel is closing");
	session.info.keepAliveUntil = Math.max(session.info.keepAliveUntil ?? 0, Date.now() + ttlMs);
	armSessionReap(session, Math.max(0, session.info.lastActivityAt + DEFAULT_KERNEL_IDLE_REAP_MS - Date.now()));
	return vmSessionInfo(session);
}

async function resetVmContext(sessionKey: string): Promise<void> {
	const session = sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.promise.catch(() => undefined));
	if (!session) return;
	if (session.pending.size > 0) recordKernelCellTermination(session.sessionId, "was reset");
	if (!(await killSession(session, new JsKernelTerminatedError("JS context reset"), { force: false }))) {
		throw new ToolError("JS context reset shutdown not confirmed");
	}
	if (sessions.get(sessionKey) === session) sessions.delete(sessionKey);
}

export async function disposeAllVmContexts(): Promise<void> {
	clearKernelLaneConfigurations("node");
	clearKernelLaneConfigurations("bun");
	const pending = [...startingSessions.values()].map(starting => {
		starting.abort.abort(new ToolAbortError("JS context disposed during startup"));
		return starting.promise;
	});
	startingSessions.clear();
	const started = await Promise.allSettled(pending);
	const all = [...sessions.values()];
	for (const result of started) {
		if (result.status !== "fulfilled") continue;
		if (!all.includes(result.value)) all.push(result.value);
	}
	const stopped = await Promise.all(
		all.map(session => killSessionFor(session, new ToolError("JS context disposed"), { force: false })),
	);
	if (stopped.some(confirmed => !confirmed)) throw new ToolError("JS context disposal shutdown not confirmed");
}

export async function disposeVmContextsByOwner(ownerId: string): Promise<void> {
	clearKernelLaneConfigurations("node", ownerId);
	clearKernelLaneConfigurations("bun", ownerId);
	const toKill: JsSession[] = [];
	for (const session of [...sessions.values()]) {
		if (!session.ownerIds.has(ownerId)) continue;
		if (session.ownerIds.size === 1) {
			toKill.push(session);
			continue;
		}
		session.ownerIds.delete(ownerId);
	}
	const startingToKill: StartingJsSession[] = [];
	for (const [sessionKey, starting] of [...startingSessions.entries()]) {
		if (sessions.has(sessionKey) || !starting.ownerIds.has(ownerId)) continue;
		if (starting.ownerIds.size === 1) {
			startingSessions.delete(sessionKey);
			starting.abort.abort(new ToolAbortError("JS context disposed during startup"));
			startingToKill.push(starting);
			continue;
		}
		starting.ownerIds.delete(ownerId);
	}
	const started = await Promise.allSettled(startingToKill.map(starting => starting.promise));
	for (const result of started) {
		if (result.status !== "fulfilled") continue;
		const session = result.value;
		toKill.push(session);
	}
	const stopped = await Promise.all(
		toKill.map(session => killSessionFor(session, new ToolError("JS context disposed"), { force: false })),
	);
	if (stopped.some(confirmed => !confirmed)) throw new ToolError("JS context disposal shutdown not confirmed");
}

async function runOnce(
	session: JsSession,
	options: {
		sessionId: string;
		cwd: string;
		session: ToolSession;
		shellEnv?: Record<string, string>;
		stdin?: ReadableStream<Uint8Array>;
		completionContext?: EvalCompletionInvocationContext;
		invocation?: KernelInvocation;
		code: string;
		filename: string;
		runState: VmRunState;
	},
): Promise<VmRunResult> {
	// Acquisition can finish after cancellation. Do not dispatch the cell or
	// kill a shared worker that the cancelled request never started using.
	if (options.runState.signal?.aborted) {
		throw reasonToError(options.runState.signal.reason, "Execution aborted");
	}
	const runId = `r-${Snowflake.next()}`;
	const { promise, resolve, reject } = Promise.withResolvers<VmRunResult>();
	const pending: PendingRun = {
		input: new KernelInputReader(options.stdin),
		decoders: { stdout: new TextDecoder(), stderr: new TextDecoder() },
		runId,
		runState: options.runState,
		toolSession: options.session,
		bridgeCwd: session.info.target.kind === "local" ? options.cwd : undefined,
		resolve,
		reject,
		toolCalls: new Map(),
		executionOrigin: currentExecutionOrigin(),
		completionContext: options.completionContext,
		deferDepth: 0,
		aborted: false,
		settled: false,
	};
	session.pending.set(runId, pending);

	const onAbort = (): void => {
		const reason = options.runState.signal?.reason;
		const abortError = reasonToError(reason, "Execution aborted");

		pending.aborted = true;
		pending.input.cancel();
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(abortError);

		const drained = pending.deferDepth > 0 ? pending.deferDrained?.promise : undefined;
		if (drained) {
			void drained.then(() => killSessionFor(session, abortError, { force: true }));
			return;
		}
		void killSessionFor(session, abortError, { force: true });
	};

	options.runState.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		session.worker.send({
			type: "run",
			runId,
			code: options.code,
			filename: options.filename,
			invocation: options.invocation,
			snapshot: {
				cwd: kernelTargetCwd(session.info.target, options.cwd),
				target: session.info.target,
				sessionId: options.sessionId,
				shellEnv: session.info.target.kind === "local" ? options.shellEnv : undefined,
				stdin: Boolean(options.stdin),
			},
			completionContext: options.completionContext,
		});
		return await promise;
	} finally {
		options.runState.signal?.removeEventListener("abort", onAbort);
		pending.input.cancel();
		session.pending.delete(runId);
		if (!pending.aborted && !pending.outputError && session.state === "alive") {
			evictCompletedRun(session, runId);
			const timer = setTimeout(() => evictCompletedRun(session, runId), COMPLETED_RUN_TTL_MS);
			timer.unref?.();
			session.completedRuns.set(runId, { runState: options.runState, decoders: pending.decoders, timer });
			trimCompletedRuns(session);
		}
	}
}

async function acquireSession(
	sessionKey: string,
	runtime: JsKernelRuntime,
	snapshot: SessionSnapshot,
	timeoutMs?: number,
	ownerId?: string,
	signal?: AbortSignal,
): Promise<JsSession> {
	snapshot.target = parseKernelTarget(snapshot.target);
	const existing = sessions.get(sessionKey);
	if (existing?.state === "stopping") {
		if (!(await killSession(existing, new ToolError("JS context shutdown in progress"), { force: true }))) {
			throw new ToolError("JS context shutdown not confirmed; cannot start another interpreter on this lane");
		}
		if (sessions.get(sessionKey) === existing) sessions.delete(sessionKey);
	}
	if (existing && existing.state === "alive") {
		if (JSON.stringify(existing.info.target) !== JSON.stringify(snapshot.target)) {
			throw new ToolError(
				"Kernel target changed on a live JavaScript lane; reset the lane explicitly before changing targets",
			);
		}
		existing.sessionId = snapshot.sessionId;
		existing.cwd = snapshot.cwd;
		attachSessionOwner(existing, snapshot.sessionId, ownerId);
		return existing;
	}
	const starting = startingSessions.get(sessionKey);
	if (starting) {
		attachSessionOwner(starting, snapshot.sessionId, ownerId);
		return signal ? await untilAborted(signal, () => starting.promise) : await starting.promise;
	}
	if (runtime === "node") {
		if (snapshot.target.kind !== "local") throw new ToolError(NODE_REMOTE_TARGET_UNSUPPORTED);
		snapshot.interpreter ??= resolveNodeInterpreter(snapshot.shellEnv, snapshot.cwd);
		if (!snapshot.interpreter) throw new ToolError(NODE_INTERPRETER_NOT_FOUND);
	}
	const releaseAdmission = kernelAdmission.reserve(ownerId ?? snapshot.sessionId);
	const abort = new AbortController();
	const startupSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
	const now = Date.now();
	const info: KernelSessionInfo = {
		sessionKey,
		sessionId: snapshot.sessionId,
		cwd: snapshot.cwd,
		interpreter:
			snapshot.interpreter ??
			(snapshot.target && snapshot.target.kind !== "local"
				? (snapshot.target.interpreter ?? "bun")
				: process.execPath),
		target: snapshot.target ?? { kind: "local" },
		generation: crypto.randomUUID(),
		state: "starting",
		startedAt: now,
		lastActivityAt: now,
	};
	let startingSession!: StartingJsSession;
	let startupSession: JsSession | undefined;
	let startupWorkerStopped = true;

	const startup = (async (): Promise<JsSession> => {
		snapshot.generation = info.generation ?? undefined;
		const worker = await spawnJsWorker(runtime, snapshot);
		startupWorkerStopped = false;
		const session: JsSession = {
			sessionKey,
			sessionId: snapshot.sessionId,
			cwd: snapshot.cwd,
			info,
			worker,
			state: "alive",
			reapShutdownRetries: 0,
			releaseAdmission,
			pending: new Map(),
			completedRuns: new Map(),
			ownerIds: new Set(),
			hasFallbackOwner: false,
		};

		startupSession = session;
		const readyTimeoutMs = Math.max(WORKER_INIT_TIMEOUT_MS, timeoutMs ?? 0);
		try {
			await initWorker(session, snapshot, readyTimeoutMs, startupSignal);
		} catch (error) {
			await session.worker.terminate();
			startupWorkerStopped = true;
			throw error;
		}
		session.ownerIds = new Set(startingSession.ownerIds);
		session.hasFallbackOwner = startingSession.hasFallbackOwner;

		if (startingSessions.get(sessionKey) === startingSession) {
			sessions.set(sessionKey, session);
		}
		return session;
	})();
	startingSession = {
		ownerIds: new Set(),
		hasFallbackOwner: false,
		promise: startup,
		info,
		abort,
	};
	attachSessionOwner(startingSession, snapshot.sessionId, ownerId);
	startingSessions.set(sessionKey, startingSession);
	try {
		return await startup;
	} catch (error) {
		if (startupWorkerStopped) releaseAdmission();
		else if (startupSession) {
			// Failed termination still owns capacity and a retryable process handle.
			startupSession.state = "stopping";
			startupSession.ownerIds = new Set(startingSession.ownerIds);
			startupSession.hasFallbackOwner = startingSession.hasFallbackOwner;
			sessions.set(sessionKey, startupSession);
		}
		throw error;
	} finally {
		if (startingSessions.get(sessionKey) === startingSession) startingSessions.delete(sessionKey);
	}
}

async function initWorker(
	session: JsSession,
	snapshot: SessionSnapshot,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	const worker = session.worker;
	const { promise: readyPromise, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
	let resolved = false;
	const unsubscribeMessage = worker.onMessage(msg => {
		if (!resolved && msg.type === "ready") {
			if (msg.interpreter) session.info.interpreter = msg.interpreter;
			resolved = true;
			resolveReady();
			return;
		}
		if (!resolved && msg.type === "init-failed") {
			resolved = true;
			rejectReady(errorFromPayload(msg.error));
			return;
		}
		handleSessionMessage(session, msg);
	});
	const unsubscribeError = worker.onError(error => {
		if (!resolved) {
			resolved = true;
			rejectReady(error);
			return;
		}

		const executionError =
			session.pending.size > 0
				? new Error(
						"JS eval worker died during execution; completion is uncertain and the cell was not replayed. Check for partial side effects before retrying. The next call will start a fresh worker.",
						{ cause: error },
					)
				: error;
		void killSessionFor(session, executionError, { force: true });
	});
	try {
		signal?.throwIfAborted();
		worker.send({ type: "init", snapshot });
		await raceWithTimeout(readyPromise, timeoutMs, "Timed out initializing JS eval worker", signal);
	} catch (error) {
		unsubscribeMessage();
		unsubscribeError();
		throw error;
	}
}

function trimCompletedRuns(session: JsSession): void {
	let retainedBytes = [...session.completedRuns.values()].reduce(
		(total, entry) => total + Math.max(0, entry.runState.retainedBytes?.() ?? 0),
		0,
	);
	while (session.completedRuns.size > MAX_COMPLETED_RUN_SINKS || retainedBytes > MAX_COMPLETED_RUN_BYTES) {
		const oldest = session.completedRuns.keys().next().value;
		if (oldest === undefined) break;
		const removed = session.completedRuns.get(oldest);
		retainedBytes -= Math.max(0, removed?.runState.retainedBytes?.() ?? 0);
		evictCompletedRun(session, oldest);
	}
}

function evictCompletedRun(session: JsSession, runId: string): void {
	const entry = session.completedRuns.get(runId);
	if (!entry) return;
	session.completedRuns.delete(runId);
	clearTimeout(entry.timer);
	entry.runState.release?.();
	logger.debug("JS late output attribution expired", { runId });
}

function handleSessionMessage(session: JsSession, msg: WorkerOutbound): void {
	switch (msg.type) {
		case "stdin-request": {
			const pending = session.pending.get(msg.runId);
			if (pending) void supplyInput(session, pending);
			return;
		}
		case "text":
		case "bytes":
			void forwardOutput(session, msg);
			return;
		case "display": {
			const pending = session.pending.get(msg.runId);
			if (pending?.outputError) return;
			const completed = pending ? undefined : session.completedRuns.get(msg.runId);
			const runState = pending?.runState ?? completed?.runState;
			if (!runState) {
				logger.debug("JS late output has no retained consumer", { runId: msg.runId });
				return;
			}
			try {
				runState.onDisplay?.(msg.output);
				if (completed) trimCompletedRuns(session);
			} catch (error) {
				// Finish draining this cell before rejecting it; output failures must
				// not escape the IPC listener or destroy persistent user state.
				if (pending) {
					pending.outputError = error instanceof Error ? error : new Error(String(error));
				} else {
					evictCompletedRun(session, msg.runId);
					logger.warn("JS background output consumer failed", { error: String(error) });
				}
			}
			return;
		}
		case "tool-call":
			void handleToolCall(session, msg);
			return;
		case "result":
			settlePending(session, msg);
			return;
		case "log":
			logWorkerMessage(msg);
			return;
		case "ready":
		case "init-failed":
		case "closed":
			return;
	}
}

async function supplyInput(session: JsSession, pending: PendingRun): Promise<void> {
	try {
		const bytes = await pending.input.read();
		if (pending.settled || pending.aborted) return;
		safeSend(session, {
			type: "stdin",
			runId: pending.runId,
			data: bytes ? Buffer.from(bytes).toString("base64") : "",
			eof: !bytes,
		});
	} catch (error) {
		pending.outputError = error instanceof Error ? error : new Error(String(error));
		void killSessionFor(session, pending.outputError, { force: true });
	}
}

async function forwardOutput(
	session: JsSession,
	msg: Extract<WorkerOutbound, { type: "text" | "bytes" }>,
): Promise<void> {
	const pending = session.pending.get(msg.runId);
	const sink = pending ?? session.completedRuns.get(msg.runId);
	try {
		if (!sink || pending?.outputError) return;
		const stream = msg.stream ?? "stdout";
		const bytes = msg.type === "bytes" ? Buffer.from(msg.data, "base64") : Buffer.from(msg.chunk);
		const text =
			msg.type === "bytes"
				? sink.decoders[stream].decode(bytes, { stream: true })
				: sink.decoders[stream].decode() + msg.chunk;
		await sink.runState.onBytes?.(bytes, stream);
		if (text) await sink.runState.onText?.(text, stream);
		if (!pending) trimCompletedRuns(session);
	} catch (error) {
		if (pending) pending.outputError = error instanceof Error ? error : new Error(String(error));
		else evictCompletedRun(session, msg.runId);
	} finally {
		if (msg.id) safeSend(session, { type: "output-ack", id: msg.id });
	}
}

function trackDeferPhase(pending: PendingRun, event: JsStatusEvent): void {
	if (event.deferExternalAbort !== true) return;
	if (event.op === EVAL_TIMEOUT_PAUSE_OP) {
		pending.deferDepth++;
		pending.deferDrained ??= Promise.withResolvers<void>();
		return;
	}
	if (event.op !== EVAL_TIMEOUT_RESUME_OP || pending.deferDepth === 0) return;
	pending.deferDepth--;
	if (pending.deferDepth > 0) return;
	pending.deferDrained?.resolve();
	pending.deferDrained = undefined;
}

async function handleToolCall(session: JsSession, msg: Extract<WorkerOutbound, { type: "tool-call" }>): Promise<void> {
	const pending = session.pending.get(msg.runId);
	if (!pending) {
		safeSend(session, {
			type: "tool-reply",
			id: msg.id,
			reply: { ok: false, error: { message: "Run no longer active" } },
		});
		return;
	}
	if (pending.aborted) {
		safeSend(session, {
			type: "tool-reply",
			id: msg.id,
			reply: { ok: false, error: { message: "Run was interrupted" } },
		});
		return;
	}
	const ctrl = new AbortController();
	pending.toolCalls.set(msg.id, ctrl);
	try {
		const value = await callSessionTool(msg.name, msg.args, {
			session: pending.toolSession,
			executionOrigin: pending.executionOrigin,
			cwd: pending.bridgeCwd,
			signal: ctrl.signal,
			completionContext: pending.completionContext,
			completionInvocationId: msg.completionInvocationId,
			emitStatus: (event: JsStatusEvent) => {
				trackDeferPhase(pending, event);
				pending.runState.onDisplay?.({ type: "status", event });
			},
		});
		safeSend(session, { type: "tool-reply", id: msg.id, reply: { ok: true, value } });
	} catch (error) {
		safeSend(session, { type: "tool-reply", id: msg.id, reply: { ok: false, error: toErrorPayload(error) } });
	} finally {
		pending.toolCalls.delete(msg.id);

		const held = pending.heldResult;
		if (held && !pending.settled && !pending.aborted && pending.toolCalls.size === 0) {
			void finishPending(pending, held);
		}
	}
}

async function finishPending(pending: PendingRun, msg: Extract<WorkerOutbound, { type: "result" }>): Promise<void> {
	pending.settled = true;
	pending.heldResult = undefined;
	try {
		for (const stream of ["stdout", "stderr"] as const) {
			const text = pending.decoders[stream].decode();
			if (text) await pending.runState.onText?.(text, stream);
		}
	} catch (error) {
		pending.outputError = error instanceof Error ? error : new Error(String(error));
	}
	if (pending.outputError) {
		pending.reject(pending.outputError);
		return;
	}
	if (msg.ok) {
		pending.resolve({ value: undefined, exitCode: msg.exitCode ?? 0 });
		return;
	}
	const error = errorFromPayload(msg.error);
	cellErrors.add(error);
	pending.reject(error);
}

function settlePending(session: JsSession, msg: Extract<WorkerOutbound, { type: "result" }>): void {
	const pending = session.pending.get(msg.runId);
	if (!pending || pending.settled) return;

	if (pending.aborted) return;

	if (pending.toolCalls.size > 0) {
		pending.heldResult = msg;
		return;
	}
	void finishPending(pending, msg);
}

async function killSessionFor(session: JsSession, error: Error, options: { force: boolean }): Promise<boolean> {
	const confirmed = await killSession(session, error, options);
	if (confirmed && sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
	return confirmed;
}

async function killSession(session: JsSession, error: Error, options: { force: boolean }): Promise<boolean> {
	if (session.state === "dead") return true;
	if (session.shutdown) return await session.shutdown;
	session.shutdown = (async () => {
		session.state = "stopping";
		clearSessionReap(session);
		for (const pending of session.pending.values()) {
			if (pending.settled) continue;
			pending.settled = true;
			for (const ctrl of pending.toolCalls.values()) ctrl.abort(error);
			pending.reject(error);
		}
		session.pending.clear();
		for (const runId of session.completedRuns.keys()) evictCompletedRun(session, runId);
		const confirmed = await shutdownWorker(session.worker, options.force);
		if (!confirmed) {
			if (!sessions.has(session.sessionKey)) sessions.set(session.sessionKey, session);
			return false;
		}
		session.releaseAdmission();
		session.state = "dead";
		reapNotes.delete(session.sessionKey);
		return true;
	})();
	try {
		return await session.shutdown;
	} finally {
		session.shutdown = undefined;
	}
}

export async function shutdownWorker(worker: WorkerHandle, force: boolean): Promise<boolean> {
	if (force) {
		try {
			await worker.terminate();
			return true;
		} catch {
			return false;
		}
	}
	try {
		if (await worker.close()) return true;
	} catch {
		// Fall through to forced termination.
	}
	try {
		await worker.terminate();
		return true;
	} catch {
		return false;
	}
}

function safeSend(session: JsSession, msg: WorkerInbound): void {
	if (session.state !== "alive") return;
	try {
		session.worker.send(msg);
	} catch (err) {
		logger.debug("js worker send failed", { error: err instanceof Error ? err.message : String(err) });
	}
}

function reasonToError(reason: unknown, fallback: string): Error {
	if (reason instanceof Error) return reason;
	if (typeof reason === "string") return new ToolAbortError(reason);
	return new ToolAbortError(fallback);
}

function errorFromPayload(payload: RunErrorPayload): Error {
	if (payload.isAbort) {
		const err = new ToolAbortError(payload.message || "Execution aborted");
		if (payload.stack) err.stack = payload.stack;
		return err;
	}
	const ctor = payload.isToolError ? ToolError : Error;
	const error = new ctor(payload.message);
	if (payload.name) error.name = payload.name;
	// A thrown non-Error carries no stack; one captured here would name host frames, not the cell's.
	error.stack = payload.stack ?? `${error.name}: ${error.message}`;
	return error;
}

function toErrorPayload(error: unknown): RunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { message: String(error) };
}

function logWorkerMessage(msg: Extract<WorkerOutbound, { type: "log" }>): void {
	if (msg.level === "debug") logger.debug(msg.msg, msg.meta);
	else if (msg.level === "warn") logger.warn(msg.msg, msg.meta);
	else logger.error(msg.msg, msg.meta);
}

async function raceWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	reason: string,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
	const onAbort = (): void =>
		reject(signal?.aborted ? reasonToError(signal.reason, "Execution aborted") : new ToolError(reason));
	combined.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		combined.removeEventListener("abort", onAbort);
	}
}

async function spawnJsWorker(runtime: JsKernelRuntime, snapshot: SessionSnapshot): Promise<WorkerHandle> {
	if (runtime === "node") return spawnStandaloneJsProcess(runtime, snapshot.interpreter!, await stageJsKernel());
	const target = parseKernelTarget(snapshot.target);
	if (target.kind !== "local") {
		snapshot.discoveryCwd ??= snapshot.cwd;
		snapshot.cwd = kernelTargetCwd(target, snapshot.cwd);
		snapshot.shellEnv = undefined;
		return await spawnTargetJsWorker(target, snapshot);
	}
	try {
		// A restored lane may carry the observed launcher path as its interpreter. A compiled
		// host is not an external Bun CLI: keep using its internal worker entry in that case.
		if (!snapshot.interpreter || (isCompiledBinary() && snapshot.interpreter === process.execPath))
			return await spawnJsProcess();
		return await spawnStandaloneJsProcess(runtime, snapshot.interpreter, await stageJsKernel());
	} catch (error) {
		throw new ToolError(
			"Unable to create an isolated JS eval subprocess; refusing an interpreter with weaker native semantics",
			{
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}
}

async function spawnJsProcess(): Promise<WorkerHandle> {
	const spawnCommand = resolveWorkerSpawnCmd(JS_EVAL_PROCESS_ARG);
	const spawned = createWorkerSubprocess<WorkerOutbound>({
		spawnCommand,
		env: workerEnvFromParent({ PI_JS_NATIVE_STDIO: "1" }),
		captureNativeStdio: true,
		exitLabel: "JS eval worker",
		detached: true,
		reportCleanExit: true,
		unref: false,
	});
	const base = createWorkerHandle<WorkerInbound, WorkerOutbound>(spawned, message =>
		safeSendIpc(spawned.proc, message, "js-eval"),
	);
	return processWorkerHandle(
		"process",
		await withNativeInput(withNativeOutput(base, spawned.proc.stdout!)),
		spawned.snapshotDescendants,
	);
}

/** Run the staged module in the requested interpreter, never pass an internal CLI selector to it. */
async function spawnStandaloneJsProcess(
	runtime: JsKernelRuntime,
	interpreter: string,
	entry: string,
): Promise<WorkerHandle> {
	const spawned = createWorkerSubprocess<unknown>({
		// Only Node needs this flag for the local-module loader's vm.SourceTextModule.
		spawnCommand: {
			cmd: runtime === "node" ? [interpreter, "--experimental-vm-modules", entry] : [interpreter, entry],
		},
		env: workerEnvFromParent({ PI_JS_NATIVE_STDIO: "1", PI_JS_NATIVE_ADDON: getNativeAddonPath() }),
		captureNativeStdio: true,
		exitLabel: `${runtime} JS kernel`,
		serialization: "json",
		detached: true,
		reportCleanExit: true,
		unref: false,
	});
	const base = createWorkerHandle<WorkerInbound, unknown>(spawned, message =>
		safeSendIpc(spawned.proc, encodeNodeKernelMessage(message), `${runtime}-js-kernel`),
	);
	const decoded: WorkerProcessHandle = {
		send: message => base.send(message),
		onMessage: handler => base.onMessage(raw => handler(decodeNodeKernelMessage(raw) as WorkerOutbound)),
		onError: handler => base.onError(handler),
		terminate: () => base.terminate(),
	};
	return processWorkerHandle(
		runtime === "node" ? "node" : "process",
		await withNativeInput(withNativeOutput(decoded, spawned.proc.stdout!)),
		spawned.snapshotDescendants,
	);
}

interface WorkerProcessHandle {
	send(message: WorkerInbound): void;
	onMessage(handler: (message: WorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
}

function processWorkerHandle(
	mode: "process" | "node",
	base: WorkerProcessHandle,
	snapshotDescendants: () => void,
): WorkerHandle {
	return {
		mode,
		send: message => base.send(message),
		onMessage: handler =>
			base.onMessage(message => {
				// Remember owned live children before a later cell crashes the worker.
				if (message.type === "result") snapshotDescendants();
				handler(message);
			}),
		onError: handler => base.onError(handler),
		async close() {
			const { promise, resolve } = Promise.withResolvers<boolean>();
			let settled = false;
			let timeout: NodeJS.Timeout | undefined;
			let unsubscribe = (): void => {};
			const finish = (value: boolean): void => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				unsubscribe();
				resolve(value);
			};
			unsubscribe = base.onMessage(message => {
				if (message.type !== "closed") return;
				void base.terminate().then(
					() => finish(true),
					() => finish(false),
				);
			});
			timeout = setTimeout(() => finish(false), workerCloseTimeoutMs);
			base.send({ type: "close" });
			return await promise;
		},
		terminate: () => base.terminate(),
	};
}
