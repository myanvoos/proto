import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import type { FsObservation } from "./fs-observations";
import { type KernelDisplayOutput, renderKernelDisplay } from "./py/display";

export type KernelRuntimeEnv = Record<string, string | null>;

export interface KernelExecuteOptions {
	id?: string;

	cwd?: string;

	env?: Record<string, string | undefined> | Record<string, string | null>;
	fsObservations?: FsObservation[];
	signal?: AbortSignal;
	onChunk?: (text: string) => Promise<void> | void;
	retainedOutputBytes?: () => number;
	releaseOutput?: () => void;
	onDisplay?: (output: KernelDisplayOutput) => Promise<void> | void;
	timeoutMs?: number;
	silent?: boolean;
	storeHistory?: boolean;
	allowStdin?: boolean;

	prelude?: boolean;
}

export interface KernelExecuteResult {
	status: "ok" | "error";
	executionCount?: number;
	error?: { name: string; value: string; traceback: string[] };
	cancelled: boolean;
	timedOut: boolean;
	stdinRequested: boolean;

	kernelKilled?: boolean;
}

export interface KernelShutdownResult {
	confirmed: boolean;
}

export interface KernelShutdownOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface KernelStartOptions {
	cwd: string;
	env?: Record<string, string | undefined>;

	interpreter?: string;
	signal?: AbortSignal;
	deadlineMs?: number;
}

interface BaseKernelOptions<TExecuteOptions extends KernelExecuteOptions = KernelExecuteOptions> {
	languageName: string;

	traceIpc: boolean;

	exitPayload: string;

	interruptEscalationMs: number;

	shutdownGraceMs: number;

	detachedProcessTree: boolean;

	buildPayload: (code: string, msgId: string, options?: TExecuteOptions) => string;

	buildCancelPayload?: (msgId: string) => string;
}

export type FrameType = "started" | "stdout" | "stderr" | "display" | "result" | "error" | "done";

export interface Frame {
	type: FrameType;
	id?: string;
	data?: string;
	bundle?: Record<string, unknown>;
	ename?: string;
	evalue?: string;
	traceback?: string[];
	status?: "ok" | "error";
	executionCount?: number;
	cancelled?: boolean;
	busy?: number;
}

export interface KernelStatusReport {
	/** Number of in-flight kernel request tasks (0 = quiescent). */
	busy: number;
	executionCount?: number;
}

type TextFrameKind = "stdout" | "stderr";
type UnicodeTails = Partial<Record<TextFrameKind, string>>;

interface CompletedOutputSink {
	retainedOutputBytes?: () => number;
	releaseOutput?: () => void;
	timer: NodeJS.Timeout;
	onChunk?: (text: string) => Promise<void> | void;
	onDisplay?: (output: KernelDisplayOutput) => Promise<void> | void;
	unicodeTails: UnicodeTails;
}

interface PendingExecution {
	resolve: (result: KernelExecuteResult) => void;
	options?: KernelExecuteOptions;
	status: "ok" | "error";
	executionCount?: number;
	error?: { name: string; value: string; traceback: string[] };
	cancelled: boolean;
	timedOut: boolean;
	stdinRequested: boolean;
	kernelKilled: boolean;
	settled: boolean;
	started: boolean;
	cancelRequested: boolean;
	cancelControlSent: boolean;
	escalationTimer?: NodeJS.Timeout;
	finalize?: () => void;
	requestCancel?: () => void;
	unicodeTails: UnicodeTails;
}

export function getRemainingTimeMs(deadlineMs?: number): number | undefined {
	if (deadlineMs === undefined) return undefined;
	return Math.max(0, deadlineMs - Date.now());
}

export function createAbortError(name: "AbortError" | "TimeoutError", message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

export function throwIfAborted(signal: AbortSignal | undefined, fallbackReason: string): void {
	if (!signal?.aborted) return;
	const reason = signal.reason;
	if (reason instanceof Error) throw reason;
	throw createAbortError("AbortError", typeof reason === "string" ? reason : fallbackReason);
}

export function isTimeoutReason(reason: unknown): boolean {
	if (reason instanceof DOMException) return reason.name === "TimeoutError";
	if (reason instanceof Error) return reason.name === "TimeoutError";
	return false;
}

function isMissingProcessError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function processGroupExists(processGroupId: number): boolean {
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch (error) {
		return !isMissingProcessError(error);
	}
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-processGroupId, signal);
	} catch (error) {
		if (!isMissingProcessError(error)) {
			logger.warn("Failed to signal kernel process group", {
				processGroupId,
				signal,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (processGroupExists(processGroupId)) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;
		await Bun.sleep(Math.min(25, remainingMs));
	}
	return true;
}

async function terminateWindowsProcessTree(processId: number, force: boolean, timeoutMs: number): Promise<boolean> {
	try {
		const command = ["taskkill", "/PID", String(processId), "/T"];
		if (force) command.push("/F");
		const taskkill = Bun.spawn(command, {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});
		return (await taskkill.exited) === 0;
	} catch (error) {
		logger.warn("Failed to terminate Windows kernel process tree", {
			processId,
			force,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

export async function terminateDetachedProcessTree(
	proc: Pick<Subprocess, "pid" | "kill">,
	timeoutMs: number,
): Promise<boolean> {
	if (process.platform === "win32") {
		if (await terminateWindowsProcessTree(proc.pid, false, timeoutMs)) return true;
		return await terminateWindowsProcessTree(proc.pid, true, timeoutMs);
	}

	signalProcessGroup(proc.pid, "SIGTERM");
	if (await waitForProcessGroupExit(proc.pid, timeoutMs)) return true;
	signalProcessGroup(proc.pid, "SIGKILL");
	return await waitForProcessGroupExit(proc.pid, timeoutMs);
}

// Text/JSON frames above this are rejected before JSON.parse. Keep enough
// headroom for the documented 20 MiB decoded-image budget (base64 expands 4/3).
const MAX_KERNEL_FRAME_CHARS = 32 * 1024 * 1024;
const MAX_COMPLETED_OUTPUT_SINKS = 256;
const MAX_COMPLETED_OUTPUT_BYTES = 512 * 1024;
const COMPLETED_OUTPUT_TTL_MS = 30_000;

function unrefTimeout(callback: () => void, delayMs: number): NodeJS.Timeout {
	const timer = setTimeout(callback, delayMs);
	timer.unref?.();
	return timer;
}

export abstract class BaseKernel<TExecuteOptions extends KernelExecuteOptions = KernelExecuteOptions> {
	readonly id: string;
	#proc: Subprocess | null = null;
	#stdin: Bun.FileSink | null = null;
	#alive = true;
	#disposed = false;
	#shutdownConfirmed = false;
	#exitedPromise: Promise<number> | null = null;
	#pending = new Map<string, PendingExecution>();
	#completedOutputSinks = new Map<string, CompletedOutputSink>();
	#controlPending = new Map<string, (report: KernelStatusReport | undefined) => void>();
	#readChunks: string[] = [];
	#readChars = 0;
	#discardingOversizedFrame = false;
	readonly #options: BaseKernelOptions<TExecuteOptions>;

	constructor(id: string, options: BaseKernelOptions<TExecuteOptions>) {
		this.id = id;
		this.#options = options;
	}

	setProcess(proc: Subprocess<"pipe", "pipe", "pipe">) {
		this.#proc = proc;
		this.#stdin = proc.stdin;
		this.#exitedPromise = proc.exited;
		void this.#exitedPromise.then(code => {
			this.#alive = false;
			this.#abortPendingExecutions(`${this.#options.languageName} kernel exited with code ${code}`, {
				kernelKilled: true,
			});
		});

		this.#startReader(proc.stdout as ReadableStream<Uint8Array>);
		this.#startStderrDrain(proc.stderr as ReadableStream<Uint8Array>);
	}

	isAlive(): boolean {
		return this.#alive && !this.#disposed;
	}

	async execute(code: string, options?: TExecuteOptions): Promise<KernelExecuteResult> {
		if (!this.isAlive()) {
			throw new Error(`${this.#options.languageName} kernel is not running`);
		}

		const msgId = options?.id ?? Snowflake.next();
		const { promise, resolve } = Promise.withResolvers<KernelExecuteResult>();
		const pending: PendingExecution = {
			resolve,
			options,
			status: "ok",
			cancelled: false,
			timedOut: false,
			stdinRequested: false,
			settled: false,
			kernelKilled: false,
			started: false,
			cancelRequested: false,
			cancelControlSent: false,
			unicodeTails: {},
		};
		this.#pending.set(msgId, pending);

		const finalize = () => {
			if (pending.settled) return;
			pending.settled = true;
			this.#pending.delete(msgId);
			if (!pending.cancelled && (pending.options?.onChunk || pending.options?.onDisplay)) {
				this.#evictCompletedOutputSink(msgId);
				this.#completedOutputSinks.set(msgId, {
					onChunk: pending.options.onChunk,
					retainedOutputBytes: pending.options.retainedOutputBytes,
					releaseOutput: pending.options.releaseOutput,
					timer: unrefTimeout(() => this.#evictCompletedOutputSink(msgId), COMPLETED_OUTPUT_TTL_MS),
					onDisplay: pending.options.onDisplay,
					unicodeTails: pending.unicodeTails,
				});
				this.#trimCompletedOutputSinks();
			}
			cleanup();
			resolve({
				status: pending.status,
				executionCount: pending.executionCount,
				error: pending.error,
				cancelled: pending.cancelled,
				timedOut: pending.timedOut,
				stdinRequested: pending.stdinRequested,
				kernelKilled: pending.kernelKilled,
			});
		};

		let requestWritten = false;
		const requestCancel = () => {
			if (pending.settled || pending.escalationTimer) return;
			pending.cancelRequested = true;
			if (!requestWritten) {
				finalize();
				return;
			}
			if (!pending.started && this.#options.buildCancelPayload) {
				if (!pending.cancelControlSent) {
					pending.cancelControlSent = true;
					void this.#writeLine(this.#options.buildCancelPayload(msgId)).catch(error => {
						if (pending.settled) return;
						pending.status = "error";
						pending.error = {
							name: "TransportError",
							value: error instanceof Error ? error.message : String(error),
							traceback: [],
						};
						finalize();
					});
				}
				return;
			}
			void this.interrupt();
			const escalation = setTimeout(() => {
				if (pending.settled) return;
				logger.warn(`${this.#options.languageName} runner did not respond to SIGINT; terminating subprocess`, {
					kernelId: this.id,
				});
				pending.kernelKilled = true;
				void this.shutdown();
			}, this.#options.interruptEscalationMs);
			escalation.unref?.();
			pending.escalationTimer = escalation;
		};
		pending.requestCancel = requestCancel;

		const onAbort = () => {
			pending.cancelled = true;
			pending.timedOut = pending.timedOut || isTimeoutReason(options?.signal?.reason);
			requestCancel();
		};
		const timeoutId =
			typeof options?.timeoutMs === "number" && options.timeoutMs > 0
				? setTimeout(() => {
						pending.timedOut = true;
						pending.cancelled = true;
						requestCancel();
					}, options.timeoutMs)
				: undefined;

		const cleanup = () => {
			clearTimeout(timeoutId);
			clearTimeout(pending.escalationTimer);
			pending.escalationTimer = undefined;
			options?.signal?.removeEventListener("abort", onAbort);
		};

		if (options?.signal) {
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
				if (options.signal.aborted) {
					options.signal.removeEventListener("abort", onAbort);
					onAbort();
				}
			}
		}

		pending.finalize = finalize;

		const payload = this.#options.buildPayload(code, msgId, options);

		if (pending.settled) {
			return promise;
		}

		requestWritten = true;
		try {
			await this.#writeLine(payload);
		} catch (err) {
			pending.status = "error";
			pending.cancelled = true;
			pending.error = {
				name: "TransportError",
				value: err instanceof Error ? err.message : String(err),
				traceback: [],
			};
			finalize();
		}

		return promise;
	}

	/**
	 * Probe the kernel for in-flight work without executing user code.
	 * Returns undefined when the kernel is not running or did not answer in time;
	 * callers must treat undefined as "possibly busy".
	 */
	async requestStatus(timeoutMs = 2_000): Promise<KernelStatusReport | undefined> {
		if (!this.isAlive() || this.#disposed) return undefined;
		const msgId = Snowflake.next();
		const { promise, resolve } = Promise.withResolvers<KernelStatusReport | undefined>();
		this.#controlPending.set(msgId, resolve);
		const timer = setTimeout(() => {
			if (this.#controlPending.delete(msgId)) resolve(undefined);
		}, timeoutMs);
		timer.unref?.();
		try {
			await this.#writeLine(JSON.stringify({ type: "status", id: msgId }));
		} catch {
			if (this.#controlPending.delete(msgId)) resolve(undefined);
		}
		try {
			return await promise;
		} finally {
			clearTimeout(timer);
			this.#controlPending.delete(msgId);
		}
	}

	/** True when the kernel reports in-flight request tasks. Undefined = unknown (treat as busy). */
	async isBusy(): Promise<boolean | undefined> {
		const report = await this.requestStatus();
		if (report === undefined) return undefined;
		return report.busy > 0;
	}

	async interrupt(): Promise<void> {
		if (!this.#proc || this.#disposed) return;
		try {
			this.#proc.kill("SIGINT");
		} catch (err) {
			logger.warn(`Failed to interrupt ${this.#options.languageName.toLowerCase()} runner`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async shutdown(options?: KernelShutdownOptions): Promise<KernelShutdownResult> {
		if (this.#shutdownConfirmed) return { confirmed: true };

		this.#alive = false;
		this.#abortPendingExecutions(`${this.#options.languageName} kernel shutdown`, { kernelKilled: true });
		for (const id of this.#completedOutputSinks.keys()) this.#evictCompletedOutputSink(id);

		const timeoutMs = options?.timeoutMs ?? this.#options.shutdownGraceMs;
		const proc = this.#proc;
		if (!proc) {
			this.#shutdownConfirmed = true;
			this.#disposed = true;
			return { confirmed: true };
		}

		try {
			await this.#writeLine(this.#options.exitPayload).catch(() => {});
		} catch {}

		try {
			this.#stdin?.end();
		} catch {}

		let result: number | null;
		let treeExited = true;
		if (this.#options.detachedProcessTree && process.platform === "win32") {
			// taskkill must see the live root PID to discover descendants, so start
			// tree shutdown immediately after requesting the runner's clean exit.
			treeExited = await terminateDetachedProcessTree(proc, timeoutMs);
			result = await this.#waitForExitWithTimeout(timeoutMs);
		} else {
			result = await this.#waitForExitWithTimeout(timeoutMs);
			if (this.#options.detachedProcessTree) {
				treeExited = !processGroupExists(proc.pid);
				if (result === null || !treeExited) {
					treeExited = await terminateDetachedProcessTree(proc, timeoutMs);
					if (result === null) result = await this.#waitForExitWithTimeout(timeoutMs);
				}
			} else if (result === null) {
				try {
					proc.kill("SIGTERM");
				} catch {}
				result = await this.#waitForExitWithTimeout(timeoutMs);
				if (result === null) {
					try {
						proc.kill("SIGKILL");
					} catch {}
					result = await this.#waitForExitWithTimeout(timeoutMs);
				}
			}
		}

		// Confirmation requires both the runner and its detached descendants to
		// be gone; returning early would leak cell-spawned background processes.
		const confirmed = result !== null && treeExited;
		this.#shutdownConfirmed = confirmed;
		this.#disposed = true;
		return { confirmed };
	}

	#abortPendingExecutions(reason: string, options?: { kernelKilled?: boolean }): void {
		if (this.#pending.size === 0) return;
		const pending = Array.from(this.#pending.values());
		this.#pending.clear();
		const kernelKilledDefault = options?.kernelKilled ?? false;
		for (const entry of pending) {
			if (entry.settled) continue;
			entry.status = "error";
			entry.cancelled = true;
			entry.kernelKilled = entry.kernelKilled || kernelKilledDefault;
			try {
				const notification = entry.options?.onChunk?.(`[kernel] ${reason}\n`);
				void notification?.catch(error => {
					logger.warn("Kernel shutdown output consumer failed", { error: String(error) });
				});
			} catch (error) {
				logger.warn("Kernel shutdown output consumer failed", { error: String(error) });
			} finally {
				entry.finalize?.();
			}
		}
	}

	async #writeLine(line: string): Promise<void> {
		if (!this.#stdin) {
			throw new Error(`${this.#options.languageName} kernel stdin is not open`);
		}
		if (this.#options.traceIpc) {
			logger.debug(`${this.#options.languageName}Kernel send`, { preview: line.slice(0, 120) });
		}
		this.#stdin.write(`${line}\n`);
		this.#stdin.flush();
	}

	#startReader(stream: ReadableStream<Uint8Array>): void {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		const loop = async () => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					await this.#consumeFrameText(decoder.decode(value, { stream: true }));
				}
				await this.#consumeFrameText(decoder.decode());
			} catch (err) {
				logger.warn(`${this.#options.languageName} kernel reader failed`, {
					error: err instanceof Error ? err.message : String(err),
				});
			} finally {
				try {
					reader.releaseLock();
				} catch {}
			}
		};
		void loop();
	}

	#startStderrDrain(stream: ReadableStream<Uint8Array>): void {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		const loop = async () => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const text = decoder.decode(value);
					if (text.trim()) {
						logger.warn(`${this.#options.languageName} runner stderr`, { text });
					}
				}
			} catch {
			} finally {
				try {
					reader.releaseLock();
				} catch {}
			}
		};
		void loop();
	}

	async #consumeFrameText(text: string): Promise<void> {
		let remaining = text;
		while (remaining.length > 0) {
			if (this.#discardingOversizedFrame) {
				const newline = remaining.indexOf("\n");
				if (newline < 0) return;
				this.#discardingOversizedFrame = false;
				remaining = remaining.slice(newline + 1);
				continue;
			}

			const newline = remaining.indexOf("\n");
			const segment = newline < 0 ? remaining : remaining.slice(0, newline);
			if (this.#readChars + segment.length > MAX_KERNEL_FRAME_CHARS) {
				const prefixLength = Math.max(0, MAX_KERNEL_FRAME_CHARS - this.#readChars);
				const prefix = [...this.#readChunks, segment.slice(0, prefixLength)].join("");
				await this.#rejectOversizedFrame(prefix);
				this.#readChunks = [];
				this.#readChars = 0;
				if (newline < 0) {
					this.#discardingOversizedFrame = true;
					return;
				}
				remaining = remaining.slice(newline + 1);
				continue;
			}

			this.#readChunks.push(segment);
			this.#readChars += segment.length;
			if (newline < 0) return;
			const line = this.#readChunks.join("");
			this.#readChunks = [];
			this.#readChars = 0;
			await this.#parseFrameLine(line);
			remaining = remaining.slice(newline + 1);
		}
	}

	async #rejectOversizedFrame(prefix: string): Promise<void> {
		const idMatch = /"id"\s*:\s*("(?:\\.|[^"\\])*")/.exec(prefix);
		let rid: string | undefined;
		if (idMatch?.[1]) {
			try {
				rid = JSON.parse(idMatch[1]) as string;
			} catch {}
		}
		const message = `[kernel] ${this.#options.languageName} runner frame exceeded ${MAX_KERNEL_FRAME_CHARS} characters and was discarded before JSON parsing.\n`;
		const pending = rid ? this.#pending.get(rid) : undefined;
		if (pending) {
			pending.status = "error";
			pending.error = { name: "FrameTooLarge", value: message.trim(), traceback: [] };
			try {
				await pending.options?.onChunk?.(message);
			} catch (error) {
				this.#failOutputConsumer(rid, error);
			}
			return;
		}
		logger.warn(`${this.#options.languageName} runner emitted an oversized unattributed frame`);
	}

	async #parseFrameLine(line: string): Promise<void> {
		if (!line.trim()) return;
		let frame: Frame;
		try {
			frame = JSON.parse(line) as Frame;
		} catch (err) {
			logger.warn(`${this.#options.languageName} runner emitted invalid JSON`, {
				line: line.slice(0, 200),
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}
		if (this.#options.traceIpc) {
			logger.debug(`${this.#options.languageName}Kernel recv`, { type: frame.type, id: frame.id });
		}
		try {
			await this.#handleFrame(frame);
		} catch (error) {
			// An output consumer may fail (for example, artifact storage is full).
			// Keep draining the protocol: stopping here wedges every later cell.
			this.#failOutputConsumer(frame.id, error);
			if (frame.type === "done" && frame.id) this.#pending.get(frame.id)?.finalize?.();
		}
	}

	#trimCompletedOutputSinks(): void {
		let retainedBytes = [...this.#completedOutputSinks.values()].reduce(
			(total, sink) => total + Math.max(0, sink.retainedOutputBytes?.() ?? 0),
			0,
		);
		while (
			this.#completedOutputSinks.size > MAX_COMPLETED_OUTPUT_SINKS ||
			retainedBytes > MAX_COMPLETED_OUTPUT_BYTES
		) {
			const oldest = this.#completedOutputSinks.keys().next().value;
			if (oldest === undefined) break;
			const removed = this.#completedOutputSinks.get(oldest);
			this.#evictCompletedOutputSink(oldest);
			retainedBytes -= Math.max(0, removed?.retainedOutputBytes?.() ?? 0);
		}
	}

	#evictCompletedOutputSink(id: string): void {
		const sink = this.#completedOutputSinks.get(id);
		if (!sink) return;
		this.#completedOutputSinks.delete(id);
		clearTimeout(sink.timer);
		sink.releaseOutput?.();
		logger.debug(`${this.#options.languageName} late output attribution expired`, { id });
	}

	#failOutputConsumer(rid: string | undefined, error: unknown): void {
		const pending = rid ? this.#pending.get(rid) : undefined;
		if (pending) {
			pending.status = "error";
			pending.error = {
				name: "OutputError",
				value: error instanceof Error ? error.message : String(error),
				traceback: [],
			};
			pending.options = { ...pending.options, onChunk: undefined, onDisplay: undefined };
		} else {
			if (rid) this.#evictCompletedOutputSink(rid);
			logger.warn("Kernel background output consumer failed", { error: String(error) });
		}
	}

	async #forwardTextFrame(
		sink: { onChunk?: (text: string) => Promise<void> | void; unicodeTails: UnicodeTails },
		kind: TextFrameKind,
		text: string,
	): Promise<void> {
		let combined = `${sink.unicodeTails[kind] ?? ""}${text}`;
		sink.unicodeTails[kind] = undefined;
		const last = combined.charCodeAt(combined.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) {
			sink.unicodeTails[kind] = combined.slice(-1);
			combined = combined.slice(0, -1);
		}
		const repaired = combined.toWellFormed();
		if (repaired) await sink.onChunk?.(repaired);
		if (repaired !== combined) {
			await sink.onChunk?.(
				"\n[kernel] output contained an unrecoverable unpaired UTF-16 surrogate; replaced with U+FFFD.\n",
			);
		}
	}

	async #handleFrame(frame: Frame): Promise<void> {
		const rid = frame.id;
		if (!rid) return;
		const control = this.#controlPending.get(rid);
		if (control) {
			this.#controlPending.delete(rid);
			if (frame.type === "done") {
				control({ busy: typeof frame.busy === "number" ? frame.busy : 0, executionCount: frame.executionCount });
			} else if (frame.type === "error") {
				control(undefined);
			}
			return;
		}
		const pending = this.#pending.get(rid);
		if (!pending) {
			const completed = this.#completedOutputSinks.get(rid);
			if (!completed) {
				logger.debug(`${this.#options.languageName} late output has no retained consumer`, { id: rid });
				return;
			}
			if (frame.type === "stdout" || frame.type === "stderr") {
				await this.#forwardTextFrame(completed, frame.type, frame.data ?? "");
				this.#trimCompletedOutputSinks();
				return;
			}
			if (frame.type === "display" || frame.type === "result") {
				const { text, outputs } = await renderKernelDisplay(frame.bundle ?? {});
				if (text) await completed.onChunk?.(text);
				for (const output of outputs) await completed.onDisplay?.(output);
				this.#trimCompletedOutputSinks();
			}
			return;
		}

		switch (frame.type) {
			case "started":
				pending.started = true;
				if (pending.cancelRequested) pending.requestCancel?.();
				return;
			case "stdout":
			case "stderr": {
				await this.#forwardTextFrame(
					{ onChunk: pending.options?.onChunk, unicodeTails: pending.unicodeTails },
					frame.type,
					frame.data ?? "",
				);
				return;
			}
			case "display":
			case "result": {
				const bundle = frame.bundle ?? {};
				const { text, outputs } = await renderKernelDisplay(bundle);
				if (text && pending.options?.onChunk) {
					await pending.options.onChunk(text);
				}
				if (outputs.length > 0 && pending.options?.onDisplay) {
					for (const output of outputs) {
						await pending.options.onDisplay(output);
					}
				}
				return;
			}
			case "error": {
				const traceback = Array.isArray(frame.traceback) ? frame.traceback.map(String) : [];
				pending.status = "error";
				pending.error = {
					name: String(frame.ename ?? "Error"),
					value: String(frame.evalue ?? ""),
					traceback,
				};
				const message =
					traceback.length > 0 ? `${traceback.join("\n")}\n` : `${pending.error.name}: ${pending.error.value}\n`;
				if (pending.options?.onChunk) {
					await pending.options.onChunk(message);
				}
				return;
			}
			case "done": {
				for (const kind of ["stdout", "stderr"] as const) {
					if (!pending.unicodeTails[kind]) continue;
					pending.unicodeTails[kind] = undefined;
					await pending.options?.onChunk?.(
						"�\n[kernel] output ended with an unrecoverable unpaired UTF-16 surrogate; replaced with U+FFFD.\n",
					);
				}
				if (typeof frame.executionCount === "number") {
					pending.executionCount = frame.executionCount;
				}
				if (frame.status === "error" && pending.status === "ok") {
					pending.status = "error";
				}
				if (frame.cancelled) {
					pending.cancelled = true;
				}
				pending.finalize?.();
				return;
			}
		}
	}

	async executeWithBudget(
		code: string,
		signal: AbortSignal | undefined,
		timeoutMs: number,
		label: string,
		extra?: Partial<TExecuteOptions>,
	): Promise<void> {
		const controller = new AbortController();
		const cleanups: Array<() => void> = [];
		if (signal) {
			if (signal.aborted) {
				controller.abort(signal.reason);
			} else {
				const onAbort = () => controller.abort(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
				cleanups.push(() => signal.removeEventListener("abort", onAbort));
			}
		}
		const timer =
			timeoutMs > 0
				? setTimeout(() => controller.abort(createAbortError("TimeoutError", `${label} timed out`)), timeoutMs)
				: undefined;
		if (timer) cleanups.push(() => clearTimeout(timer));
		try {
			throwIfAborted(controller.signal, label);
			const result = await this.execute(code, {
				...extra,
				signal: controller.signal,
				silent: true,
				storeHistory: false,
			} as TExecuteOptions);
			if (result.cancelled) {
				throw createAbortError(result.timedOut ? "TimeoutError" : "AbortError", `${label} cancelled`);
			}
			if (result.status === "error") {
				const reason = result.error?.value ?? `${this.#options.languageName} kernel init failed`;
				throw new Error(`${label} failed: ${reason}`);
			}
		} finally {
			for (const cleanup of cleanups) cleanup();
		}
	}

	#waitForExitWithTimeout(timeoutMs: number): Promise<number | null> {
		if (!this.#exitedPromise) return Promise.resolve(0);
		const exitedPromise = this.#exitedPromise;
		const timeout = new Promise<null>(resolve => {
			const timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs));
			timer.unref?.();
		});
		return Promise.race([exitedPromise.then(code => code as number | null), timeout]);
	}
}
