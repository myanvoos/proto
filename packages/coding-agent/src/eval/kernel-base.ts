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

	buildPayload: (code: string, msgId: string, options?: TExecuteOptions) => string;
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
	escalationTimer?: NodeJS.Timeout;
	finalize?: () => void;
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

export abstract class BaseKernel<TExecuteOptions extends KernelExecuteOptions = KernelExecuteOptions> {
	readonly id: string;
	#proc: Subprocess | null = null;
	#stdin: Bun.FileSink | null = null;
	#alive = true;
	#disposed = false;
	#shutdownConfirmed = false;
	#exitedPromise: Promise<number> | null = null;
	#pending = new Map<string, PendingExecution>();
	#controlPending = new Map<string, (report: KernelStatusReport | undefined) => void>();
	#readBuffer = "";
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
		};
		this.#pending.set(msgId, pending);

		const finalize = () => {
			if (pending.settled) return;
			pending.settled = true;
			this.#pending.delete(msgId);
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
			if (!requestWritten) {
				finalize();
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

		let result = await this.#waitForExitWithTimeout(timeoutMs);
		if (result === null) {
			try {
				proc.kill("SIGTERM");
			} catch {}
			result = await this.#waitForExitWithTimeout(timeoutMs);
		}
		if (result === null) {
			try {
				proc.kill("SIGKILL");
			} catch {}
			result = await this.#waitForExitWithTimeout(timeoutMs);
		}

		// null = the process did not exit within the deadline; any exit code
		// (including 0) means the process is gone and shutdown is confirmed.
		const confirmed = result !== null;
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
			void entry.options?.onChunk?.(`[kernel] ${reason}\n`);
			entry.finalize?.();
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
					this.#readBuffer += decoder.decode(value, { stream: true });
					await this.#flushFrames();
				}
				this.#readBuffer += decoder.decode();
				await this.#flushFrames();
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

	async #flushFrames(): Promise<void> {
		while (true) {
			const nl = this.#readBuffer.indexOf("\n");
			if (nl < 0) return;
			const line = this.#readBuffer.slice(0, nl);
			this.#readBuffer = this.#readBuffer.slice(nl + 1);
			if (!line.trim()) continue;
			let frame: Frame;
			try {
				frame = JSON.parse(line) as Frame;
			} catch (err) {
				logger.warn(`${this.#options.languageName} runner emitted invalid JSON`, {
					line: line.slice(0, 200),
					error: err instanceof Error ? err.message : String(err),
				});
				continue;
			}
			if (this.#options.traceIpc) {
				logger.debug(`${this.#options.languageName}Kernel recv`, { type: frame.type, id: frame.id });
			}
			await this.#handleFrame(frame);
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
		if (!pending) return;

		switch (frame.type) {
			case "started":
				return;
			case "stdout":
			case "stderr": {
				const text = frame.data ?? "";
				if (text && pending.options?.onChunk) {
					await pending.options.onChunk(text);
				}
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
