import * as fs from "node:fs";
import inspector from "node:inspector";
import { isMainThread } from "node:worker_threads";
import * as logger from "./logger";
import { restoreTerminalStderr } from "./stderr-guard";

export enum Reason {
	PRE_EXIT = "pre_exit",
	EXIT = "exit",
	SIGINT = "sigint",
	SIGTERM = "sigterm",
	SIGHUP = "sighup",
	UNCAUGHT_EXCEPTION = "uncaught_exception",
	UNHANDLED_REJECTION = "unhandled_rejection",
	MANUAL = "manual",
}

interface CleanupRegistration {
	id: string;
	callback: (reason: Reason) => Promise<void> | void;
	cancelled: boolean;
	lastPass: number;
}

// Registration order; registrations survive keep-alive passes and `lastPass` keeps each to one call per pass.
const callbackList: CleanupRegistration[] = [];

let cleanupStage: "idle" | "running" | "complete" = "idle";
let cleanupPass = 0;
let activeCleanupReason: Reason | undefined;
let activeCleanupKeepAlive = false;
// Callbacks invoked late (registered while a pass runs), joined by that pass before it settles so `cleanup()` and
// signal exits await them.
let activeLatePromises: Promise<void>[] | undefined;
const CLEANUP_DEADLINE_MS = 10_000;

export const NATIVE_PROCESS_EXIT = Symbol.for("proto.postmortem.nativeProcessExit");

type HardExitFn = (code?: number) => never;

// Nested guard windows stack throwing stubs, so one unwrap can land on another stub: follow the stamps until native.
function nativeHardExit(fn: HardExitFn | undefined): HardExitFn | undefined {
	let current = fn;
	const seen = new Set<HardExitFn>();
	while (typeof current === "function" && !seen.has(current)) {
		seen.add(current);
		const behind = Reflect.get(current, NATIVE_PROCESS_EXIT);
		if (typeof behind !== "function") return current;
		current = behind as HardExitFn;
	}
	return typeof current === "function" ? current : undefined;
}

/**
 * Hard-exit through the native primitive, even inside an extension-load guard window. Both globals are reinstalled
 * first: Bun's `process.exit` re-reads `process.reallyExit` at call time, so exiting through one while its sibling
 * still holds a throwing stub re-enters the guard. `SIGKILL` is the last resort so a poisoned chain never survives.
 */
export function exitProcess(code: number): never {
	const reallyExit = nativeHardExit(typeof process.reallyExit === "function" ? process.reallyExit : undefined);
	const exit = nativeHardExit(process.exit as HardExitFn);
	if (reallyExit) process.reallyExit = reallyExit as typeof process.reallyExit;
	if (exit) process.exit = exit as typeof process.exit;
	try {
		reallyExit?.call(process, code);
	} catch {}
	try {
		exit?.call(process, code);
	} catch {}
	try {
		process.kill(process.pid, "SIGKILL");
	} catch {}
	throw new Error(`exitProcess(${code}) failed to terminate the process`);
}
let cleanupPromise: Promise<void> | undefined;
let stdioDisconnectRegistrations = 0;

export interface FatalRecoveryHint {
	label: string;

	command: string;
}

type FatalRecoveryHintProvider = () => FatalRecoveryHint | undefined;
const fatalRecoveryHintProviders = new Set<FatalRecoveryHintProvider>();

function invokeCleanup(registration: CleanupRegistration, reason: Reason, pass: number): Promise<void> | void {
	if (registration.cancelled || registration.lastPass === pass) return;
	registration.lastPass = pass;
	return registration.callback(reason);
}

/**
 * Run every registration once for this pass. A keep-alive pass ({@link cleanup}) returns to `idle` with registrations
 * still armed for the eventual real exit; an exit pass settles to `complete`.
 */
function runCleanup(reason: Reason, keepAlive = false): Promise<void> {
	switch (cleanupStage) {
		case "idle":
			cleanupStage = "running";
			break;
		case "running":
			return cleanupPromise ?? Promise.resolve();
		case "complete":
			return Promise.resolve();
	}

	const pass = ++cleanupPass;
	activeCleanupReason = reason;
	activeCleanupKeepAlive = keepAlive;
	const late: Promise<void>[] = [];
	activeLatePromises = late;
	const settle = (): void => {
		if (activeLatePromises === late) activeLatePromises = undefined;
		if (cleanupPass !== pass) return;
		cleanupStage = keepAlive ? "idle" : "complete";
		if (keepAlive) {
			activeCleanupReason = undefined;
			activeCleanupKeepAlive = false;
		}
	};

	const promises = callbackList.toReversed().map(registration => {
		return Promise.try(() => invokeCleanup(registration, reason, pass));
	});

	const cleanupSettled = Promise.allSettled(promises).then(async results => {
		for (const result of results) {
			if (result.status === "rejected") {
				const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
				logger.error("Cleanup callback failed", { err, stack: err.stack });
			}
		}
		// Join callbacks registered while this pass ran (already error-caught); each batch may register more. The
		// deadline race still bounds the pass.
		while (late.length > 0) await Promise.allSettled(late.splice(0));
		settle();
	});
	const deadline = Promise.withResolvers<void>();
	const deadlineTimer = setTimeout(() => {
		logger.error("Cleanup deadline exceeded; proceeding with exit", { reason });
		settle();
		deadline.resolve();
	}, CLEANUP_DEADLINE_MS);
	const passPromise = Promise.race([cleanupSettled, deadline.promise]).finally(() => {
		clearTimeout(deadlineTimer);
		// Drop only this pass's promise: an older deadline-limited pass may finish after a newer one started.
		if (keepAlive && cleanupPass === pass && cleanupPromise === passPromise) cleanupPromise = undefined;
	});
	cleanupPromise = passPromise;
	return cleanupPromise;
}

let inspectorOpened = false;

export type BrokenPipeSource = "ipc-send" | "stdio-write";

export function classifyBrokenPipe(err: Error): BrokenPipeSource | undefined {
	if (!("code" in err) || err.code !== "EPIPE" || !("syscall" in err)) return undefined;
	if (err.syscall === "send") return "ipc-send";
	if (err.syscall === "write") return "stdio-write";
	return undefined;
}

export function isIpcSendEpipe(err: Error): boolean {
	return classifyBrokenPipe(err) === "ipc-send";
}

/**
 * Bun can fire the close callback of an already-closed `node:net` socket on a fresh stack, surfacing
 * `ERR_SOCKET_CLOSED` as an uncaught exception past every callsite try/catch. The socket owner's own `error`/`close`
 * handlers still recover, so only frameless `node:` stacks with a `node:net` frame qualify; an application frame keeps
 * the fatal path.
 */
export function isInternalSocketClosedError(err: unknown): boolean {
	if (!(err instanceof Error) || !("code" in err) || err.code !== "ERR_SOCKET_CLOSED") return false;
	const frames = (err.stack ?? "").split("\n").slice(1);
	if (frames.length === 0) return false;
	let hasNetFrame = false;
	const internal = frames.every(frame => {
		const trimmed = frame.trim();
		if (trimmed === "" || trimmed === "at unknown" || trimmed === "at native") return true;
		if (!/\(node:[^)]*\)$/.test(trimmed) && !trimmed.startsWith("at node:")) return false;
		hasNetFrame ||= trimmed.includes("node:net:");
		return true;
	});
	return internal && hasNetFrame;
}

export function isWorkerIpcDeserializeError(err: unknown): boolean {
	return (
		err instanceof TypeError &&
		err.message === "Unable to deserialize data." &&
		!err.stack &&
		!("code" in err) &&
		!("syscall" in err)
	);
}

const workerIpcFaultHandlers = new Set<(err: Error) => void>();

export function registerWorkerIpcFaultHandler(handler: (err: Error) => void): () => void {
	workerIpcFaultHandlers.add(handler);
	return () => workerIpcFaultHandlers.delete(handler);
}

function faultWorkerIpcChannels(err: Error): void {
	for (const handler of workerIpcFaultHandlers) {
		try {
			handler(err);
		} catch (handlerErr) {
			logger.warn("Worker IPC fault handler threw", { err: handlerErr });
		}
	}
}

// Driven by stdout's own `error` event, so the broken pipe is attributable to stdout by construction; a process-wide
// `syscall: "write"` match would also swallow a closed subprocess stdin or socket. Only EPIPE is claimed: a revoked
// PTY's `EIO` is left to the TUI's stdout listener (SIGHUP/exit-129), which this listener would otherwise preempt.
function onStdoutDisconnect(err: Error): void {
	if (classifyBrokenPipe(err) !== "stdio-write") return;
	logger.warn("Stdout peer disconnected; shutting down gracefully", { err });
	void runQuit(0, "native", { drainStdout: false });
}

/**
 * Treat a closed stdout consumer (`proto --help | head`, an ACP client dropping the pipe) as a graceful exit 0 for
 * the caller's lifetime. Ref-counted: the shared listener detaches when the last registrant unregisters.
 */
export function registerStdioDisconnectHandling(): () => void {
	let registered = true;
	if (isMainThread && stdioDisconnectRegistrations === 0) process.stdout.on("error", onStdoutDisconnect);
	stdioDisconnectRegistrations++;
	return () => {
		if (!registered) return;
		registered = false;
		stdioDisconnectRegistrations--;
		if (isMainThread && stdioDisconnectRegistrations === 0)
			process.stdout.removeListener("error", onStdoutDisconnect);
	};
}

const EXPECTED_CLEANUP = Symbol.for("proto.expectedCleanupError");

export function markExpectedCleanupError<T extends object>(reason: T): T {
	(reason as Record<PropertyKey, unknown>)[EXPECTED_CLEANUP] = true;
	return reason;
}

export function isExpectedCleanupError(reason: unknown): boolean {
	let current: unknown = reason;
	for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
		if ((current as Record<PropertyKey, unknown>)[EXPECTED_CLEANUP] === true) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

const rejectionInterceptors = new Set<(reason: unknown) => boolean>();

export function interceptUnhandledRejections(interceptor: (reason: unknown) => boolean): () => void {
	rejectionInterceptors.add(interceptor);
	return () => rejectionInterceptors.delete(interceptor);
}

export function registerFatalRecoveryHint(provider: FatalRecoveryHintProvider): () => void {
	fatalRecoveryHintProviders.add(provider);
	return () => fatalRecoveryHintProviders.delete(provider);
}

function escapeFatalHintText(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, char => {
		const code = char.codePointAt(0) ?? 0;
		return `\\u${code.toString(16).padStart(4, "0")}`;
	});
}

function formatFatalRecoveryHints(): string {
	const lines: string[] = [];
	const seenCommands = new Set<string>();
	for (const provider of fatalRecoveryHintProviders) {
		try {
			const hint = provider();
			if (!hint?.command || seenCommands.has(hint.command)) continue;
			seenCommands.add(hint.command);
			lines.push(`  ${escapeFatalHintText(hint.label)}: ${escapeFatalHintText(hint.command)}`);
		} catch (err) {
			logger.warn("Fatal recovery hint provider failed", { err });
		}
	}
	return lines.length > 0 ? `\n[Recovery]\n${lines.join("\n")}\n` : "";
}

function formatFatalError(label: string, err: Error): string {
	const name = err.name || "Error";
	const message = err.message || "(no message)";
	const stack = err.stack || "";
	const stackLines = stack.split("\n").slice(1);
	const formattedStack = stackLines.length > 0 ? `\n${stackLines.join("\n")}` : "";
	return `\n[${label}] ${name}: ${message}${formattedStack}\n`;
}

async function exitAfterFatal(output: string, logMessage: string, err: Error, reason: Reason): Promise<never> {
	const forcedExit = setTimeout(() => exitProcess(1), CLEANUP_DEADLINE_MS);
	try {
		// runCleanup invokes callbacks synchronously, so terminal owners hand the display back before the report is
		// written; slower resource cleanup finishes afterwards.
		const cleanup = runCleanup(reason);
		restoreTerminalStderr();
		// A revoked terminal can make stream writes raise another fatal error; the raw descriptor keeps failure contained.
		try {
			fs.writeSync(2, output);
		} catch {}
		logger.error(logMessage, { err });
		await cleanup;
	} finally {
		clearTimeout(forcedExit);
		exitProcess(1);
	}
}

function handleWorkerSendEpipe(err: Error): boolean {
	if (!isIpcSendEpipe(err)) return false;
	logger.warn("Ignoring EPIPE from worker IPC send; optional subsystem will self-recover", { err });
	return true;
}

/**
 * Report a caught top-level failure after terminal owners restore their display, then exit 1. `report` defaults to
 * the inspected error.
 */
export async function fatal(error: unknown, report?: string): Promise<never> {
	const err = error instanceof Error ? error : new Error(String(error));
	const output = `${report ?? `${Bun.inspect(error, { colors: process.stderr.isTTY === true })}\n`}${formatFatalRecoveryHints()}`;
	if (!isMainThread) {
		process.stderr.write(output);
		process.exit(1);
	}
	return exitAfterFatal(output, "Fatal error", err, Reason.UNHANDLED_REJECTION);
}

if (isMainThread) {
	process
		.on("SIGINT", async () => {
			await runCleanup(Reason.SIGINT);
			exitProcess(130);
		})
		.on("SIGUSR1", () => {
			if (inspectorOpened) return;
			inspectorOpened = true;
			inspector.open(undefined, undefined, false);
			const url = inspector.url();
			process.stderr.write(`Inspector opened: ${url}\n`);
		})
		.on("uncaughtException", async thrown => {
			if (isExpectedCleanupError(thrown)) {
				logger.warn("Ignoring expected cleanup exception", { err: thrown });
				return;
			}
			const err = thrown instanceof Error ? thrown : new Error(String(thrown));
			// A worker IPC `send()` race surfaces through either global error event. Stdout write disconnects are
			// attributed by registerStdioDisconnectHandling's stdout `error` listener, never classified here.
			if (handleWorkerSendEpipe(err)) return;
			if (isWorkerIpcDeserializeError(err)) {
				logger.warn("Malformed worker IPC frame; faulting active worker subsystems", { err });
				faultWorkerIpcChannels(err);
				return;
			}
			if (isInternalSocketClosedError(err)) {
				logger.warn("Ignoring async ERR_SOCKET_CLOSED from node:net internals; socket owner recovers itself", {
					err,
				});
				return;
			}
			await exitAfterFatal(
				`${formatFatalError("Uncaught Exception", err)}${formatFatalRecoveryHints()}`,
				"Uncaught exception",
				err,
				Reason.UNCAUGHT_EXCEPTION,
			);
		})
		.on("unhandledRejection", async reason => {
			const err = reason instanceof Error ? reason : new Error(String(reason));
			if (handleWorkerSendEpipe(err)) return;
			if (isExpectedCleanupError(reason)) {
				logger.warn("Ignoring expected cleanup rejection", { err });
				return;
			}
			for (const interceptor of rejectionInterceptors) {
				try {
					if (interceptor(reason)) return;
				} catch (interceptorErr) {
					logger.warn("Unhandled-rejection interceptor threw; continuing with fatal path", {
						err: interceptorErr,
					});
				}
			}
			await exitAfterFatal(
				`${formatFatalError("Unhandled Rejection", err)}${formatFatalRecoveryHints()}`,
				"Unhandled rejection",
				err,
				Reason.UNHANDLED_REJECTION,
			);
		})
		.on("exit", async () => {
			void runCleanup(Reason.EXIT);
		})
		.on("SIGTERM", async () => {
			await runCleanup(Reason.SIGTERM);
			exitProcess(143);
		})
		.on("SIGHUP", async () => {
			await runCleanup(Reason.SIGHUP);
			exitProcess(129);
		});
} else {
	process.on("exit", () => {
		void runCleanup(Reason.EXIT);
	});
}

/**
 * Register a cleanup callback, run once per cleanup pass. Registered while a keep-alive pass runs, it joins that pass
 * and stays armed; registered during or after a real exit, it runs immediately and the exit awaits it.
 */
export function register(id: string, callback: (reason: Reason) => void | Promise<void>): () => void {
	const registration: CleanupRegistration = { id, callback, cancelled: false, lastPass: 0 };
	const cancel = (): void => {
		registration.cancelled = true;
		const index = callbackList.indexOf(registration);
		if (index >= 0) callbackList.splice(index, 1);
	};
	const logFailure = (error: unknown): void => {
		const err = error instanceof Error ? error : new Error(String(error));
		logger.error("Cleanup callback failed", { err, id, stack: err.stack });
	};

	if (cleanupStage === "idle") {
		callbackList.push(registration);
		return cancel;
	}

	// A keep-alive pass stays armed for later passes; a real exit has no later pass to arm for.
	if (cleanupStage === "running" && activeCleanupKeepAlive) callbackList.push(registration);
	else logger.debug("Cleanup already started; running late callback once", { id });
	try {
		const pending = invokeCleanup(registration, activeCleanupReason ?? Reason.MANUAL, cleanupPass);
		// Join the active pass so cleanup() and signal exits await it; after a completed exit nothing is left to join.
		if (pending) activeLatePromises?.push(pending.catch(logFailure));
	} catch (error) {
		logFailure(error);
	}
	return cancel;
}

export function cleanup(): Promise<void> {
	return runCleanup(Reason.MANUAL, true);
}

export interface QuitOptions {
	drainStdout?: boolean;
}

async function runQuit(code: number, exitMode: "guarded" | "native", options: QuitOptions = {}): Promise<void> {
	await runCleanup(Reason.MANUAL);

	if (!isMainThread) {
		return;
	}

	if (options.drainStdout !== false && !process.stdout.destroyed && !process.stdout.writableFinished) {
		const { promise, resolve } = Promise.withResolvers<void>();
		const onError = () => resolve();
		process.stdout.once("error", onError);
		try {
			// Bun may report writableLength === 0 while native pipe writes remain pending.
			// Closing after cleanup waits for those writes; an empty write callback does not.
			process.stdout.end(resolve);
			await Promise.race([promise, Bun.sleep(5000)]);
		} finally {
			process.stdout.off("error", onError);
		}
	}

	switch (exitMode) {
		case "guarded":
			return process.exit(code);
		case "native":
			return exitProcess(code);
	}
}

export function quit(code: number = 0, options: QuitOptions = {}): Promise<void> {
	return runQuit(code, "guarded", options);
}
