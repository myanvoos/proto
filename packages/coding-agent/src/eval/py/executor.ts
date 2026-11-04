import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ExecutionMetadata } from "../../session/execution-metadata";
import type { ToolSession } from "../../tools";
import type { EvalCompletionInvocationContext } from "../completion-bridge";
import {
	declaredStateLane,
	discardDeclaredStateKernel,
	enterDeclaredStateKernel,
	isDeclaredStateKernelSafeToRelease,
	withDeclaredStateExecution,
} from "../declared-state";
import {
	createCancelledKernelResult,
	executeWithKernelBase,
	getExecutionDeadlineMs,
	getRemainingTimeoutMs,
	isCancellationError,
	isTimedOutCancellation,
	waitForPromiseWithCancellation,
} from "../executor-base";
import type { FsObservation } from "../fs-observations";
import type { JsStatusEvent } from "../js/shared/types";
import { clearKernelLaneConfigurations } from "../kernel-environment";
import { KernelMemoryResidency } from "../kernel-memory";
import {
	createKernelSessionRegistry,
	formatSessionKernelTimeoutAnnotation,
	formatSessionTimeoutAnnotation,
	type KernelCloseCause,
	type KernelSession,
	type KernelSessionInfo,
	type KernelSessionRegistryContext,
	normalizeKernelSessionCwd,
	requireRemainingKernelTimeoutMs,
} from "../kernel-session-registry";
import { type KernelTarget, parseKernelTarget } from "../kernel-target";
import type { KernelInvocation } from "../types";
import { pythonForkserverPids, releaseIdlePythonForkservers, shutdownPythonForkservers } from "./forkserver";
import { registerPythonHarnessRun } from "./harness-bridge";
import {
	checkPythonKernelAvailability,
	type KernelDisplayOutput,
	type KernelExecuteOptions,
	type KernelExecuteResult,
	type KernelShutdownResult,
	PythonKernel,
} from "./kernel";
import { pythonEnvironmentIdentity, resolveExplicitPythonRuntime } from "./runtime";

export interface PythonExecutorOptions {
	cwd?: string;

	runCwd?: string;
	shellEnv?: Record<string, string>;
	stdin?: ReadableStream<Uint8Array>;
	invocation?: KernelInvocation;

	timeoutMs?: number;

	deadlineMs?: number;

	idleTimeoutMs?: number;

	onChunk?: (chunk: string) => Promise<void> | void;
	onStream?: (text: string, stream: "stdout" | "stderr") => Promise<void> | void;
	onBytes?: (bytes: Uint8Array, stream: "stdout" | "stderr") => Promise<void> | void;

	onDisplay?: (output: KernelDisplayOutput) => Promise<void> | void;

	signal?: AbortSignal;

	sessionId?: string;

	kernelOwnerId?: string;

	interpreter?: string;
	target?: KernelTarget;

	reset?: boolean;

	artifactPath?: string;
	artifactId?: string;

	toolSession?: ToolSession;

	emitStatus?: (event: JsStatusEvent) => void;

	onStatus?: (event: JsStatusEvent) => void;

	fsObservations?: FsObservation[];
	completionContext?: EvalCompletionInvocationContext;
}

export interface PythonKernelExecutor {
	execute: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>;
}

export interface PythonResult {
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

	displayOutputs: KernelDisplayOutput[];

	stdinRequested: boolean;
}

interface SessionKernelReplacement {
	generation: number;
	deadlineMs?: number;
	promise: Promise<PythonKernel>;
}

interface PythonSession extends KernelSession<PythonKernel> {
	generation: number;
	replacement?: SessionKernelReplacement;
}

function normalizeExplicitInterpreter(cwd: string, interpreter: string | undefined): string {
	if (interpreter === undefined) return "";
	return pythonEnvironmentIdentity(resolveExplicitPythonRuntime(interpreter, cwd, {}).pythonPath);
}

class PythonExecutionCancelledError extends Error {
	readonly timedOut: boolean;

	constructor(timedOut: boolean) {
		super(timedOut ? "Command timed out" : "Command aborted");
		this.name = "PythonExecutionCancelledError";
		this.timedOut = timedOut;
	}
}

function requireRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	return requireRemainingKernelTimeoutMs(deadlineMs, PythonExecutionCancelledError);
}

const formatTimeoutAnnotation = formatSessionTimeoutAnnotation;

const formatKernelTimeoutAnnotation = formatSessionKernelTimeoutAnnotation;

function createCancelledPythonResult(timedOut: boolean, timeoutMs?: number): PythonResult {
	const output = timedOut ? (formatTimeoutAnnotation(timeoutMs) ?? "Command timed out") : "";
	return createCancelledKernelResult(output);
}

const pythonResidency = new KernelMemoryResidency(
	async () => {
		const settings = await Settings.init();
		return {
			bytes: settings.get("python.kernelMemoryBudgetBytes"),
			maxResidentCount: settings.get("python.kernelMaxResidentCount"),
		};
	},
	isDeclaredStateKernelSafeToRelease,
	{ pids: pythonForkserverPids, releaseIdle: releaseIdlePythonForkservers },
);

async function startKernel(cwd: string, options: PythonExecutorOptions): Promise<PythonKernel> {
	requireRemainingTimeoutMs(options.deadlineMs);
	return await pythonResidency.start(() =>
		PythonKernel.start({
			cwd,
			discoveryCwd: options.toolSession?.cwd ?? cwd,
			signal: options.signal,
			deadlineMs: options.deadlineMs,
			interpreter: options.interpreter,
			target: options.target,
		}),
	);
}

async function replaceSessionKernel(
	session: PythonSession,
	cwd: string,
	options: PythonExecutorOptions,
	context: KernelSessionRegistryContext<PythonKernel, PythonExecutorOptions, PythonSession>,
): Promise<PythonKernel> {
	const kernel = session.kernel;
	const generation = session.generation;
	const inFlight = session.replacement;
	if (inFlight?.generation === generation) {
		if (
			inFlight.deadlineMs !== undefined &&
			(options.deadlineMs === undefined || options.deadlineMs > inFlight.deadlineMs)
		) {
			inFlight.deadlineMs = options.deadlineMs;
		}
		return await waitForPromiseWithCancellation(inFlight.promise, options, PythonExecutionCancelledError);
	}
	if (
		context.sessions.get(session.sessionKey) !== session ||
		session.generation !== generation ||
		session.kernel !== kernel
	) {
		throw new PythonExecutionCancelledError(false);
	}

	const deferred = Promise.withResolvers<PythonKernel>();
	const replacement: SessionKernelReplacement = {
		generation,
		deadlineMs: options.deadlineMs,
		promise: deferred.promise,
	};
	session.replacement = replacement;
	void (async () => {
		try {
			const remaining = getRemainingTimeoutMs(options.deadlineMs);
			const shutdown = await kernel.shutdown(
				remaining !== undefined ? { timeoutMs: Math.max(0, remaining) } : undefined,
			);
			if (shutdown.confirmed === false) throw new Error("Python kernel replacement shutdown not confirmed");
			if (replacement.deadlineMs !== undefined && replacement.deadlineMs <= Date.now()) {
				throw new PythonExecutionCancelledError(true);
			}
			if (
				context.sessions.get(session.sessionKey) !== session ||
				session.generation !== generation ||
				session.kernel !== kernel
			) {
				throw new PythonExecutionCancelledError(false);
			}
			const next = await startKernel(cwd, {
				...options,
				signal: undefined,
				deadlineMs: undefined,
			});
			if (
				context.sessions.get(session.sessionKey) !== session ||
				session.generation !== generation ||
				session.kernel !== kernel
			) {
				await next.shutdown().catch(() => undefined);
				throw new PythonExecutionCancelledError(false);
			}
			session.kernel = next;
			pythonResidency.forget(kernel.id);
			session.generation += 1;
			deferred.resolve(next);
		} catch (err) {
			deferred.reject(err);
		} finally {
			if (session.replacement === replacement) session.replacement = undefined;
		}
	})();
	return await waitForPromiseWithCancellation(deferred.promise, options, PythonExecutionCancelledError);
}

async function shutdownInvalidatedSession(session: PythonSession): Promise<KernelShutdownResult> {
	const replacement = session.replacement;
	if (replacement) await replacement.promise.catch(() => undefined);
	const result = await session.kernel.shutdown();
	if (result.confirmed) {
		pythonResidency.forget(session.kernel.id);
		await releaseIdlePythonForkservers();
	}
	return result;
}

async function acquireLiveSessionKernel(
	session: PythonSession,
	cwd: string,
	options: PythonExecutorOptions,
	context: KernelSessionRegistryContext<PythonKernel, PythonExecutorOptions, PythonSession>,
): Promise<PythonKernel> {
	while (context.sessions.get(session.sessionKey) === session) {
		const kernel = session.kernel;
		if (kernel.isAlive()) return kernel;
		await context.replaceSessionKernel(session, cwd, options);
	}
	throw new PythonExecutionCancelledError(false);
}

async function executeWithKernel(
	kernel: PythonKernelExecutor,
	code: string,
	options: PythonExecutorOptions | undefined,
): Promise<PythonResult> {
	if (kernel instanceof PythonKernel) {
		const ownerId = options?.kernelOwnerId ?? options?.sessionId ?? `session:${options?.cwd}`;
		await enterDeclaredStateKernel(
			ownerId,
			{
				namespace: options?.sessionId ?? `session:${options?.cwd}`,
				generation: kernel.id,
				metadata: {
					language: "python",
					lane: declaredStateLane(options?.sessionId ?? ""),
					cwd: options?.cwd ?? getProjectDir(),
					interpreter: kernel.interpreter,
					target: kernel.target,
				},
				alive: () => kernel.isAlive(),
				request: (action, snapshot) => kernel.declaredState(action, snapshot),
			},
			options?.reset,
		);
	}
	const harness = options?.toolSession
		? await registerPythonHarnessRun(options.toolSession, {
				cwd: options.runCwd ?? options.cwd,
				transport: options.target && options.target.kind !== "local" ? "stdio" : "http",
				completionContext: options.completionContext,
				lane: declaredStateLane(options.sessionId ?? ""),
				kernelId: options.sessionId,
				signal: options.signal,
				emit: event => {
					if (event.type === "status") (options.emitStatus ?? options.onStatus)?.(event.event);
					else if (event.type === "display") void options.onDisplay?.(event.output);
				},
			})
		: undefined;
	try {
		return await executeWithKernelBase<PythonExecutorOptions>({
			kernel,
			code,
			options,
			onToolRequest: harness?.request,
			runIdPrefix: "py",
			errorLogLabel: "Python",
			cancelledErrorClass: PythonExecutionCancelledError,
			buildKernelEnvPatch: () => ({
				PI_PYTHON_HARNESS_URL: harness?.env.PI_PYTHON_HARNESS_URL ?? null,
				PI_PYTHON_HARNESS_TOKEN: harness?.env.PI_PYTHON_HARNESS_TOKEN ?? null,
			}),
			formatKernelTimeoutAnnotation,
			formatTimeoutAnnotation,
		});
	} finally {
		await harness?.dispose();
	}
}

async function ensureKernelAvailable(cwd: string, options: PythonExecutorOptions): Promise<void> {
	if (options.target && options.target.kind !== "local") return;
	const availability = await waitForPromiseWithCancellation(
		checkPythonKernelAvailability(cwd, options.interpreter, { signal: options.signal }),
		options,
		PythonExecutionCancelledError,
	);
	if (!availability.ok) {
		throw new Error(availability.reason ?? "Python kernel unavailable");
	}
}

const sessionRegistry = createKernelSessionRegistry<PythonKernel, PythonExecutorOptions, PythonResult, PythonSession>({
	languageLabel: "Python",
	admission: "residency",
	kernelResidency: kernel => ({
		...pythonResidency.report(kernel.id),
		pid: kernel.pid,
		launchMode: kernel.launchMode,
		launchReason: kernel.launchReason,
		forkserverPid: kernel.forkserverPid,
		startupMs: kernel.startupMs,
	}),
	kernelActivity: (kernel, delta) => pythonResidency.activity(kernel.id, delta),
	cancelledErrorClass: PythonExecutionCancelledError,
	buildSessionKey: (sessionId, cwd, interpreter, options) => {
		if (options.target && options.target.kind !== "local") {
			return `${sessionId}\0${cwd}\0${interpreter ?? ""}\0${JSON.stringify(parseKernelTarget(options.target))}`;
		}
		const normalizedCwd = normalizeKernelSessionCwd(cwd);
		return `${sessionId}\0${normalizedCwd}\0${normalizeExplicitInterpreter(normalizedCwd, interpreter)}`;
	},
	createSession: session => ({ ...session, generation: 0 }),
	startKernel,
	executeWithKernel,
	replaceSessionKernel,
	acquireLiveSessionKernel,
	invalidateSession: session => {
		session.generation += 1;
	},
	shutdownSession: session => shutdownInvalidatedSession(session),
	validateKernel: (session, kernel) => session.kernel === kernel,
	kernelBusy: kernel => kernel.isBusy(),
	kernelSafeToReap: kernel => isDeclaredStateKernelSafeToRelease(kernel.id),
	notifySessionReaped: (options, note) =>
		options.onStatus?.({
			op: "kernel-idle-reap",
			idleMs: note.idleMs,
			reapedAt: note.reapedAt,
		}),
});

export function listPythonKernelSessions(ownerId?: string): KernelSessionInfo[] {
	return sessionRegistry.listSessions(ownerId);
}

export async function startPythonKernelSession(options: PythonExecutorOptions): Promise<KernelSessionInfo> {
	const cwd = resolvePythonSessionCwd(options);
	const startOptions = { ...options, cwd, deadlineMs: getExecutionDeadlineMs(options) };
	startOptions.signal?.throwIfAborted();
	await ensureKernelAvailable(cwd, startOptions);
	const info = await sessionRegistry.startSession(cwd, startOptions);
	if (options.reset)
		discardDeclaredStateKernel(
			options.kernelOwnerId ?? options.sessionId ?? `session:${cwd}`,
			{
				language: "python",
				lane: declaredStateLane(info.sessionId),
				cwd: info.cwd,
				interpreter: info.interpreter,
				target: info.target,
			},
			info.sessionId,
		);
	return info;
}

export async function closePythonKernelSession(
	sessionKey: string,
	force = false,
	ownerId?: string,
	cause: KernelCloseCause = "close",
): Promise<void> {
	const info = sessionRegistry.listSessions(ownerId).find(item => item.sessionKey === sessionKey);
	await sessionRegistry.closeSession(sessionKey, { force, ownerId, cause });
	if (info)
		discardDeclaredStateKernel(
			ownerId ?? info.sessionId,
			{
				language: "python",
				lane: declaredStateLane(info.sessionId),
				cwd: info.cwd,
				interpreter: info.interpreter,
				target: info.target,
			},
			info.sessionId,
		);
}

export function keepalivePythonKernelSession(sessionKey: string, ttlMs: number): KernelSessionInfo {
	return sessionRegistry.keepaliveSession(sessionKey, ttlMs);
}

function resolvePythonSessionCwd(options?: PythonExecutorOptions): string {
	if (options?.target && options.target.kind !== "local") return options.cwd ?? options.target.cwd ?? ".";
	return normalizeKernelSessionCwd(options?.cwd ?? getProjectDir());
}

export async function disposeAllKernelSessions(): Promise<void> {
	clearKernelLaneConfigurations("python");
	await sessionRegistry.disposeAll();
	await shutdownPythonForkservers();
}

export async function disposeKernelSessionsByOwner(ownerId: string): Promise<void> {
	clearKernelLaneConfigurations("python", ownerId);
	await sessionRegistry.disposeByOwner(ownerId);
}

export async function executePythonWithKernel(
	kernel: PythonKernelExecutor,
	code: string,
	options?: PythonExecutorOptions,
): Promise<PythonResult> {
	return await executeWithKernel(kernel, code, options);
}

export async function executePython(code: string, options?: PythonExecutorOptions): Promise<PythonResult> {
	const result = await withDeclaredStateExecution(
		options?.kernelOwnerId ?? options?.sessionId ?? `session:${options?.cwd}`,
		async () => {
			const cwd = resolvePythonSessionCwd(options);
			const deadlineMs = getExecutionDeadlineMs(options);
			const executionOptions: PythonExecutorOptions = {
				...(options ?? {}),
				cwd,
				deadlineMs,
			};

			try {
				requireRemainingTimeoutMs(deadlineMs);
				if (executionOptions.signal?.aborted) {
					throw new PythonExecutionCancelledError(
						isTimedOutCancellation(
							executionOptions.signal.reason,
							PythonExecutionCancelledError,
							executionOptions.signal,
						),
					);
				}
				await ensureKernelAvailable(cwd, executionOptions);

				return await sessionRegistry.executeOnSession(code, cwd, executionOptions);
			} catch (err) {
				if (isCancellationError(err, PythonExecutionCancelledError) || executionOptions.signal?.aborted) {
					return createCancelledPythonResult(
						isTimedOutCancellation(err, PythonExecutionCancelledError, executionOptions.signal),
						executionOptions.idleTimeoutMs,
					);
				}
				throw err;
			}
		},
	);
	await pythonResidency.enforce();
	return result;
}
