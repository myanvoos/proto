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

const callbackList: ((reason: Reason) => Promise<void> | void)[] = [];

let cleanupStage: "idle" | "running" | "complete" = "idle";
const CLEANUP_DEADLINE_MS = 10_000;

export const NATIVE_PROCESS_EXIT = Symbol.for("proto.postmortem.nativeProcessExit");

type HardExitFn = (code?: number) => never;

function exitProcess(code: number): never {
	const current: HardExitFn = typeof process.reallyExit === "function" ? process.reallyExit : process.exit;
	const behind = Reflect.get(current, NATIVE_PROCESS_EXIT);
	const nativeExit = typeof behind === "function" ? (behind as HardExitFn) : current;
	return nativeExit.call(process, code) as never;
}
let cleanupPromise: Promise<void> | undefined;
let stdioDisconnectRegistrations = 0;

export interface FatalRecoveryHint {
	label: string;

	command: string;
}

type FatalRecoveryHintProvider = () => FatalRecoveryHint | undefined;
const fatalRecoveryHintProviders = new Set<FatalRecoveryHintProvider>();

function runCleanup(reason: Reason): Promise<void> {
	switch (cleanupStage) {
		case "idle":
			cleanupStage = "running";
			break;
		case "running":
			return cleanupPromise ?? Promise.resolve();
		case "complete":
			return Promise.resolve();
	}

	const promises = callbackList.toReversed().map(callback => {
		return Promise.try(() => callback(reason));
	});

	const cleanupSettled = Promise.allSettled(promises).then(results => {
		for (const result of results) {
			if (result.status === "rejected") {
				const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
				logger.error("Cleanup callback failed", { err, stack: err.stack });
			}
		}
		cleanupStage = "complete";
	});
	const deadline = Promise.withResolvers<void>();
	const deadlineTimer = setTimeout(() => {
		logger.error("Cleanup deadline exceeded; proceeding with exit", { reason });
		cleanupStage = "complete";
		deadline.resolve();
	}, CLEANUP_DEADLINE_MS);
	cleanupPromise = Promise.race([cleanupSettled, deadline.promise]).finally(() => {
		clearTimeout(deadlineTimer);
	});
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

export function registerStdioDisconnectHandling(): () => void {
	let registered = true;
	stdioDisconnectRegistrations++;
	return () => {
		if (!registered) return;
		registered = false;
		stdioDisconnectRegistrations--;
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

async function exitAfterFatal(label: string, logMessage: string, err: Error, reason: Reason): Promise<void> {
	const forcedExit = setTimeout(() => exitProcess(1), CLEANUP_DEADLINE_MS);
	try {
		restoreTerminalStderr();

		try {
			fs.writeSync(2, `${formatFatalError(label, err)}${formatFatalRecoveryHints()}`);
		} catch {}
		logger.error(logMessage, { err });
		await runCleanup(reason);
	} finally {
		clearTimeout(forcedExit);
		exitProcess(1);
	}
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
		.on("uncaughtException", async err => {
			if (isExpectedCleanupError(err)) {
				logger.warn("Ignoring expected cleanup exception", { err });
				return;
			}

			if (isWorkerIpcDeserializeError(err)) {
				logger.warn("Malformed worker IPC frame; faulting active worker subsystems", { err });
				faultWorkerIpcChannels(err);
				return;
			}
			await exitAfterFatal("Uncaught Exception", "Uncaught exception", err, Reason.UNCAUGHT_EXCEPTION);
		})
		.on("unhandledRejection", async reason => {
			const err = reason instanceof Error ? reason : new Error(String(reason));
			const brokenPipeSource = classifyBrokenPipe(err);

			if (brokenPipeSource === "ipc-send") {
				logger.warn("Ignoring EPIPE from worker IPC send; optional subsystem will self-recover", { err });
				return;
			}
			if (brokenPipeSource === "stdio-write" && stdioDisconnectRegistrations > 0) {
				logger.warn("Stdio peer disconnected; shutting down gracefully", { err });
				await runQuit(0, "native");
				return;
			}
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
			await exitAfterFatal("Unhandled Rejection", "Unhandled rejection", err, Reason.UNHANDLED_REJECTION);
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

export function register(id: string, callback: (reason: Reason) => void | Promise<void>): () => void {
	let done = false;
	const exec = (reason: Reason) => {
		if (done) return;
		done = true;
		try {
			return callback(reason);
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			logger.error("Cleanup callback failed", { err, id, stack: err.stack });
		}
	};

	const cancel = () => {
		const index = callbackList.indexOf(exec);
		if (index >= 0) {
			callbackList.splice(index, 1);
		}
		done = true;
	};

	if (cleanupStage !== "idle") {
		logger.debug("Cleanup already started; running late callback once", { id });
		try {
			callback(Reason.MANUAL);
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			logger.error("Cleanup callback failed", { err, id, stack: err.stack });
		}
		return () => {};
	}

	callbackList.push(exec);
	return cancel;
}

export function cleanup(): Promise<void> {
	return runCleanup(Reason.MANUAL);
}

export interface QuitOptions {
	drainStdout?: boolean;
}

async function runQuit(code: number, exitMode: "guarded" | "native", options: QuitOptions = {}): Promise<void> {
	await runCleanup(Reason.MANUAL);

	if (!isMainThread) {
		return;
	}

	if (options.drainStdout !== false && process.stdout.writableLength > 0) {
		const { promise, resolve } = Promise.withResolvers<void>();
		process.stdout.once("drain", resolve);
		await Promise.race([promise, Bun.sleep(5000)]);
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
