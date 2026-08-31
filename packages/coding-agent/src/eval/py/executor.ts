import * as fs from "node:fs";

import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../../tools";
import {
	buildManagedKernelEnv,
	buildManagedKernelEnvPatch,
	createCancelledKernelResult,
	executeWithKernelBase,
	getExecutionDeadlineMs,
	getRemainingTimeoutMs,
	isCancellationError,
	isTimedOutCancellation,
	waitForPromiseWithCancellation,
} from "../executor-base";
import type { JsStatusEvent } from "../js/shared/types";
import {
	createKernelSessionRegistry,
	formatSessionKernelTimeoutAnnotation,
	formatSessionTimeoutAnnotation,
	type KernelSession,
	type KernelSessionRegistryContext,
	normalizeKernelSessionCwd,
	requireRemainingKernelTimeoutMs,
} from "../kernel-session-registry";
import {
	checkPythonKernelAvailability,
	type KernelDisplayOutput,
	type KernelExecuteOptions,
	type KernelExecuteResult,
	type KernelShutdownResult,
	PythonKernel,
} from "./kernel";
import { resolveExplicitPythonRuntime } from "./runtime";
import { ensurePyToolBridge } from "./tool-bridge";

export type PythonKernelMode = "session" | "per-call";

export interface PythonExecutorOptions {
	cwd?: string;

	timeoutMs?: number;

	deadlineMs?: number;

	idleTimeoutMs?: number;

	onChunk?: (chunk: string) => Promise<void> | void;

	signal?: AbortSignal;

	sessionId?: string;

	kernelOwnerId?: string;

	kernelMode?: PythonKernelMode;

	interpreter?: string;

	reset?: boolean;

	sessionFile?: string;

	artifactsDir?: string;

	artifactPath?: string;
	artifactId?: string;

	localRoots?: Record<string, string>;

	toolSession?: ToolSession;

	emitStatus?: (event: JsStatusEvent) => void;

	onStatus?: (event: JsStatusEvent) => void;

	bridgeSessionId?: string;

	bridge?: { url: string; token: string };
}

export interface PythonKernelExecutor {
	execute: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>;
}

export interface PythonResult {
	output: string;

	exitCode: number | undefined;

	cancelled: boolean;

	truncated: boolean;

	artifactId?: string;

	totalLines: number;

	totalBytes: number;

	outputLines: number;

	outputBytes: number;

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
	const resolved = resolveExplicitPythonRuntime(interpreter, cwd, {}).pythonPath;
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
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

async function startKernel(cwd: string, options: PythonExecutorOptions): Promise<PythonKernel> {
	requireRemainingTimeoutMs(options.deadlineMs);
	return await PythonKernel.start({
		cwd,
		env: buildManagedKernelEnv(options),
		signal: options.signal,
		deadlineMs: options.deadlineMs,
		interpreter: options.interpreter,
	});
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
			await kernel
				.shutdown(remaining !== undefined ? { timeoutMs: Math.max(0, remaining) } : undefined)
				.catch(() => undefined);
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
	return await session.kernel.shutdown();
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
	return executeWithKernelBase<PythonExecutorOptions>({
		kernel,
		code,
		options,
		runIdPrefix: "py",
		errorLogLabel: "Python",
		cancelledErrorClass: PythonExecutionCancelledError,
		buildKernelEnvPatch: buildManagedKernelEnvPatch,
		formatKernelTimeoutAnnotation,
		formatTimeoutAnnotation,
	});
}

async function ensureKernelAvailable(cwd: string, options: PythonExecutorOptions): Promise<void> {
	const availability = await waitForPromiseWithCancellation(
		checkPythonKernelAvailability(cwd, options.interpreter),
		options,
		PythonExecutionCancelledError,
	);
	if (!availability.ok) {
		throw new Error(availability.reason ?? "Python kernel unavailable");
	}
}

async function ensureToolBridge(options: PythonExecutorOptions): Promise<void> {
	if (!options.toolSession || options.bridge) return;
	try {
		options.bridge = await ensurePyToolBridge();
	} catch (err) {
		logger.warn("Failed to start Python tool bridge", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function executePerCall(code: string, cwd: string, options: PythonExecutorOptions): Promise<PythonResult> {
	if (options.bridge && !options.bridgeSessionId) {
		options.bridgeSessionId = `py-bridge:${crypto.randomUUID()}`;
	}
	const kernel = await startKernel(cwd, options);
	try {
		return await executeWithKernel(kernel, code, { ...options, cwd });
	} finally {
		await kernel.shutdown().catch(() => undefined);
	}
}

const sessionRegistry = createKernelSessionRegistry<PythonKernel, PythonExecutorOptions, PythonResult, PythonSession>({
	languageLabel: "Python",
	cancelledErrorClass: PythonExecutionCancelledError,
	buildSessionKey: (sessionId, cwd, interpreter) => {
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
});

export async function disposeAllKernelSessions(): Promise<void> {
	await sessionRegistry.disposeAll();
}

export async function disposeKernelSessionsByOwner(ownerId: string): Promise<void> {
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
	const cwd = normalizeKernelSessionCwd(options?.cwd ?? getProjectDir());
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
		await ensureToolBridge(executionOptions);

		const kernelMode = executionOptions.kernelMode ?? "session";
		if (kernelMode === "per-call") {
			return await executePerCall(code, cwd, executionOptions);
		}
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
}
