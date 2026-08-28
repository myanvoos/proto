import * as fs from "node:fs";

import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../../tools";
import {
	buildManagedKernelEnv,
	buildManagedKernelEnvPatch,
	createCancelledKernelResult,
	executeWithKernelBase,
	getExecutionDeadlineMs,
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
	normalizeKernelSessionCwd,
	requireRemainingKernelTimeoutMs,
} from "../kernel-session-registry";
import { ensurePyToolBridge } from "../py/tool-bridge";
import {
	checkRubyKernelAvailability,
	type KernelDisplayOutput,
	type KernelExecuteOptions,
	type KernelExecuteResult,
	RubyKernel,
} from "./kernel";
import { resolveExplicitRubyRuntime } from "./runtime";

interface RubyExecutorOptions {
	cwd?: string;

	timeoutMs?: number;

	deadlineMs?: number;

	idleTimeoutMs?: number;

	onChunk?: (chunk: string) => Promise<void> | void;

	signal?: AbortSignal;

	sessionId?: string;

	kernelOwnerId?: string;

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

interface RubyKernelExecutor {
	execute: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>;
}

interface RubyResult {
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

function normalizeExplicitInterpreter(cwd: string, interpreter: string | undefined): string {
	if (interpreter === undefined) return "";
	const resolved = resolveExplicitRubyRuntime(interpreter, cwd, {}).rubyPath;
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

class RubyExecutionCancelledError extends Error {
	readonly timedOut: boolean;

	constructor(timedOut: boolean) {
		super(timedOut ? "Command timed out" : "Command aborted");
		this.name = timedOut ? "TimeoutError" : "AbortError";
		this.timedOut = timedOut;
	}
}

function requireRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	return requireRemainingKernelTimeoutMs(deadlineMs, RubyExecutionCancelledError);
}

const formatTimeoutAnnotation = formatSessionTimeoutAnnotation;

const formatKernelTimeoutAnnotation = formatSessionKernelTimeoutAnnotation;

function createCancelledRubyResult(timedOut: boolean, timeoutMs?: number): RubyResult {
	const output = timedOut ? (formatTimeoutAnnotation(timeoutMs) ?? "Command timed out") : "";
	return createCancelledKernelResult(output);
}

async function startKernel(cwd: string, options: RubyExecutorOptions): Promise<RubyKernel> {
	requireRemainingTimeoutMs(options.deadlineMs);
	return await RubyKernel.start({
		cwd,
		env: buildManagedKernelEnv(options),
		signal: options.signal,
		deadlineMs: options.deadlineMs,
		interpreter: options.interpreter,
	});
}

async function executeWithKernel(
	kernel: RubyKernelExecutor,
	code: string,
	options: RubyExecutorOptions | undefined,
): Promise<RubyResult> {
	return executeWithKernelBase<RubyExecutorOptions>({
		kernel,
		code,
		options,
		runIdPrefix: "rb",
		errorLogLabel: "Ruby",
		cancelledErrorClass: RubyExecutionCancelledError,
		buildKernelEnvPatch: buildManagedKernelEnvPatch,
		formatKernelTimeoutAnnotation,
		formatTimeoutAnnotation,
	});
}

async function ensureKernelAvailable(cwd: string, options: RubyExecutorOptions): Promise<void> {
	const availability = await waitForPromiseWithCancellation(
		checkRubyKernelAvailability(cwd, options.interpreter),
		options,
		RubyExecutionCancelledError,
	);
	if (!availability.ok) {
		throw new Error(availability.reason ?? "Ruby kernel unavailable");
	}
}

async function ensureToolBridge(options: RubyExecutorOptions): Promise<void> {
	if (!options.toolSession || options.bridge) return;
	try {
		options.bridge = await ensurePyToolBridge();
	} catch (err) {
		logger.warn("Failed to start Ruby tool bridge", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

const sessionRegistry = createKernelSessionRegistry<
	RubyKernel,
	RubyExecutorOptions,
	RubyResult,
	KernelSession<RubyKernel>
>({
	languageLabel: "Ruby",
	cancelledErrorClass: RubyExecutionCancelledError,
	buildSessionKey: (sessionId, cwd, interpreter) => {
		const normalizedCwd = normalizeKernelSessionCwd(cwd);
		return `${sessionId}\0${normalizedCwd}\0${normalizeExplicitInterpreter(normalizedCwd, interpreter)}`;
	},
	createSession: session => session,
	startKernel,
	executeWithKernel,
});

export async function disposeAllRubyKernelSessions(): Promise<void> {
	await sessionRegistry.disposeAll();
}

export async function disposeRubyKernelSessionsByOwner(ownerId: string): Promise<void> {
	await sessionRegistry.disposeByOwner(ownerId);
}

export async function executeRubyWithKernel(
	kernel: RubyKernelExecutor,
	code: string,
	options?: RubyExecutorOptions,
): Promise<RubyResult> {
	return await executeWithKernel(kernel, code, options);
}

export async function executeRuby(code: string, options?: RubyExecutorOptions): Promise<RubyResult> {
	const cwd = normalizeKernelSessionCwd(options?.cwd ?? getProjectDir());
	const deadlineMs = getExecutionDeadlineMs(options);
	const executionOptions: RubyExecutorOptions = {
		...(options ?? {}),
		cwd,
		deadlineMs,
	};

	try {
		requireRemainingTimeoutMs(deadlineMs);
		if (executionOptions.signal?.aborted) {
			throw new RubyExecutionCancelledError(
				isTimedOutCancellation(
					executionOptions.signal.reason,
					RubyExecutionCancelledError,
					executionOptions.signal,
				),
			);
		}
		await ensureKernelAvailable(cwd, executionOptions);
		await ensureToolBridge(executionOptions);
		return await sessionRegistry.executeOnSession(code, cwd, executionOptions);
	} catch (err) {
		if (isCancellationError(err, RubyExecutionCancelledError) || executionOptions.signal?.aborted) {
			return createCancelledRubyResult(
				isTimedOutCancellation(err, RubyExecutionCancelledError, executionOptions.signal),
			);
		}
		throw err;
	}
}
