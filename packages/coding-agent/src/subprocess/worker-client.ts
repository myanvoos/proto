import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env, isBunTestRuntime, isCompiledBinary, logger, postmortem, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

type WorkerLogMessage = {
	type: "log";
	level: "debug" | "warn" | "error";
	msg: string;
	meta?: Record<string, unknown>;
};

type WorkerOutboundBase =
	| { type: "pong"; id: string }
	| { type: "error"; id: string; error: string }
	| WorkerLogMessage;

export interface WorkerHandle<Inbound, Outbound> {
	send(message: Inbound): void;
	onMessage(handler: (message: Outbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
}

export interface RefCountedWorkerHandle<Inbound, Outbound> extends WorkerHandle<Inbound, Outbound> {
	ref(): void;

	unref(): void;
}

export interface SpawnedSubprocess<Outbound> {
	proc: Subprocess<"ignore", "ignore", number | "ignore">;
	inbound: Set<(message: Outbound) => void>;
	errors: Set<(error: Error) => void>;

	intentionalExit: { value: boolean };

	stderrDrained: Promise<void>;
}

const STDERR_TAIL_LIMIT_BYTES = 16 * 1024;

interface WorkerSpawnCommand {
	cmd: string[];
	cwd?: string;
}

export function resolveWorkerSpawnCmd(workerArg: string): WorkerSpawnCommand {
	const executable = process.execPath;
	if (isCompiledBinary()) return { cmd: [executable, workerArg] };
	const hostEntry = workerHostEntry();
	if (hostEntry) {
		return { cmd: [executable, hostEntry, workerArg] };
	}
	const packageRoot = path.resolve(import.meta.dir, "..", "..");
	return { cmd: [executable, "src/cli.ts", workerArg], cwd: packageRoot };
}

export function workerEnvFromParent(overlay?: Record<string, string>): Record<string, string> {
	const base = $env as Record<string, string | undefined>;
	const merged: Record<string, string> = {};
	for (const key in base) {
		const value = base[key];
		if (typeof value === "string") merged[key] = value;
	}
	if (overlay) {
		for (const key in overlay) merged[key] = overlay[key];
	}
	return merged;
}

export function nativeLibraryPathOverlay(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform,
): Record<string, string> {
	if (platform !== "linux") return {};
	const native = env.PROTO_NATIVE_LIBRARY_PATH;
	if (typeof native !== "string" || native.length === 0) return {};
	const inherited = env.LD_LIBRARY_PATH;
	return { LD_LIBRARY_PATH: inherited ? `${inherited}:${native}` : native };
}

export function inferenceWorkerEnv(overlay?: Record<string, string>): Record<string, string> {
	return workerEnvFromParent({ ...nativeLibraryPathOverlay($env, process.platform), ...overlay });
}

export function createWorkerSubprocess<Outbound>(options: {
	spawnCommand: WorkerSpawnCommand;
	env: Record<string, string>;
	exitLabel: string;

	detached?: boolean;

	reportCleanExit?: boolean;

	unref?: boolean;
}): SpawnedSubprocess<Outbound> {
	const inbound = new Set<(message: Outbound) => void>();
	const errors = new Set<(error: Error) => void>();
	const intentionalExit = { value: false };
	const stderrTail = new StderrTail(STDERR_TAIL_LIMIT_BYTES);
	const stderrDrained = Promise.withResolvers<void>();
	const stderrCapture = createStderrCapture(options.exitLabel);
	let stderrDrainStarted = false;

	let unregisterFault: () => void = () => {};
	const startStderrDrain = (): void => {
		if (stderrDrainStarted) return;
		stderrDrainStarted = true;
		void drainStderrCapture(stderrCapture, options.exitLabel, stderrTail).finally(() => stderrDrained.resolve());
	};
	const proc = Bun.spawn({
		cmd: options.spawnCommand.cmd,
		cwd: options.spawnCommand.cwd,
		detached: options.detached,
		env: options.env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: stderrCapture.target,
		serialization: "advanced",
		ipc(message) {
			for (const handler of inbound) handler(message as Outbound);
		},
		onExit(_proc, exitCode, signalCode) {
			unregisterFault();
			startStderrDrain();
			if (exitCode === 0 && !options.reportCleanExit) return;

			if (exitCode === null && intentionalExit.value) return;
			const reason = exitCode !== null ? `code ${exitCode}` : `signal ${signalCode ?? "unknown"}`;

			void stderrDrained.promise.finally(() => {
				const suffix = stderrTail.suffix();
				const err = new Error(`${options.exitLabel} exited with ${reason}${suffix}`);
				for (const handler of errors) handler(err);
			});
		},
	});

	let faulted = false;
	unregisterFault = postmortem.registerWorkerIpcFaultHandler(cause => {
		if (faulted) return;
		faulted = true;
		const err = new Error(`${options.exitLabel}: worker sent a malformed IPC frame; recycling worker`, { cause });
		for (const handler of errors) handler(err);

		intentionalExit.value = true;
		try {
			proc.kill("SIGKILL");
		} catch {}
	});

	if (!isBunTestRuntime() && options.unref !== false) proc.unref();
	return { proc, inbound, errors, intentionalExit, stderrDrained: stderrDrained.promise };
}

class StderrTail {
	#chunks: Uint8Array[] = [];
	#bytes = 0;
	constructor(readonly limit: number) {}

	append(chunk: Uint8Array): void {
		if (chunk.length === 0) return;
		this.#chunks.push(chunk);
		this.#bytes += chunk.length;
		while (this.#bytes > this.limit && this.#chunks.length > 1) {
			const head = this.#chunks.shift();
			if (head) this.#bytes -= head.length;
		}
		if (this.#bytes > this.limit && this.#chunks.length === 1) {
			const only = this.#chunks[0];
			const start = only.length - this.limit;
			this.#chunks[0] = only.subarray(start);
			this.#bytes = this.limit;
		}
	}

	suffix(): string {
		if (this.#bytes === 0) return "";
		const merged = new Uint8Array(this.#bytes);
		let offset = 0;
		for (const chunk of this.#chunks) {
			merged.set(chunk, offset);
			offset += chunk.length;
		}
		const text = new TextDecoder().decode(merged).replace(/\s+$/u, "");
		if (text.length === 0) return "";
		return `: ${text}`;
	}
}

interface StderrCapture {
	target: number | "ignore";
	fd: number | null;
	dir: string | null;
	cleanupOnExit: (() => void) | null;
}

function createStderrCapture(exitLabel: string): StderrCapture {
	try {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-worker-stderr-"));
		const fd = fs.openSync(path.join(dir, "stderr.log"), "w+");
		const cleanupOnExit = (): void => cleanupStderrCapture({ target: fd, fd, dir, cleanupOnExit: null });
		process.once("exit", cleanupOnExit);
		return { target: fd, fd, dir, cleanupOnExit };
	} catch (error) {
		logger.debug(`${exitLabel} stderr capture unavailable`, {
			error: error instanceof Error ? error.message : String(error),
		});
		return { target: "ignore", fd: null, dir: null, cleanupOnExit: null };
	}
}

function cleanupStderrCapture(capture: StderrCapture): void {
	if (capture.cleanupOnExit) process.off("exit", capture.cleanupOnExit);
	if (capture.fd !== null) {
		try {
			fs.closeSync(capture.fd);
		} catch {}
		capture.fd = null;
	}
	if (capture.dir) {
		try {
			fs.rmSync(capture.dir, { recursive: true, force: true });
		} catch {}
		capture.dir = null;
	}
}

async function drainStderrCapture(capture: StderrCapture, exitLabel: string, tail: StderrTail): Promise<void> {
	try {
		if (capture.fd === null) return;
		const size = fs.fstatSync(capture.fd).size;
		if (size <= 0) return;
		const length = Math.min(size, tail.limit);
		const buffer = new Uint8Array(length);
		fs.readSync(capture.fd, buffer, 0, length, size - length);
		tail.append(buffer);
		for (const rawLine of new TextDecoder().decode(buffer).split("\n")) {
			const line = rawLine.replace(/\r$/u, "");
			if (line.length > 0) logger.debug(`${exitLabel} stderr`, { line });
		}
	} catch {
	} finally {
		cleanupStderrCapture(capture);
	}
}

export function createWorkerHandle<Inbound, Outbound>(
	spawned: SpawnedSubprocess<Outbound>,
	send: (message: Inbound) => void,
): WorkerHandle<Inbound, Outbound> {
	const { proc, inbound, errors, intentionalExit } = spawned;
	return {
		send,
		onMessage(handler) {
			inbound.add(handler);
			return () => inbound.delete(handler);
		},
		onError(handler) {
			errors.add(handler);
			return () => errors.delete(handler);
		},
		async terminate() {
			intentionalExit.value = true;
			try {
				proc.kill("SIGKILL");
			} catch {}
		},
	};
}

export function createUnavailableWorker<
	Inbound extends { type: string; id: string },
	Outbound extends { type: string },
>(error: unknown): WorkerHandle<Inbound, Outbound> {
	const listeners = new Set<(message: Outbound) => void>();
	const errorMessage = error instanceof Error ? error.message : String(error);
	const emit = (message: WorkerOutboundBase): void => {
		for (const listener of listeners) listener(message as unknown as Outbound);
	};
	return {
		send(message) {
			queueMicrotask(() => {
				if (message.type === "ping") {
					emit({ type: "pong", id: message.id });
					return;
				}
				emit({ type: "error", id: message.id, error: errorMessage });
			});
		},
		onMessage(handler) {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		onError() {
			return () => {};
		},
		async terminate() {
			listeners.clear();
		},
	};
}

export function spawnWorkerOrUnavailable<Handle>(
	spawn: () => Handle,
	unavailable: (error: unknown) => Handle,
	warnMessage: string,
): Handle {
	try {
		return spawn();
	} catch (error) {
		logger.warn(warnMessage, { error: error instanceof Error ? error.message : String(error) });
		return unavailable(error);
	}
}

export function logWorkerMessage(message: WorkerLogMessage): void {
	if (message.level === "debug") logger.debug(message.msg, message.meta);
	else if (message.level === "warn") logger.warn(message.msg, message.meta);
	else logger.error(message.msg, message.meta);
}
