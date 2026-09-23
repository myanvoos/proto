import { Process } from "@oh-my-pi/pi-natives";
import type { Spawn, Subprocess } from "bun";

type InMask = "pipe" | "ignore" | Buffer | Uint8Array | null;

type PipedSubprocess<In extends InMask = InMask> = Subprocess<In, "pipe", "pipe">;

export abstract class Exception extends Error {
	constructor(
		message: string,
		public readonly exitCode: number,
		public readonly stderr: string,
	) {
		super(message);
		this.name = this.constructor.name;
	}
	abstract readonly aborted: boolean;
}

export class NonZeroExitError extends Exception {
	static readonly MAX_TRACE = 32 * 1024;

	constructor(exitCode: number, stderr: string) {
		super(`Process exited with code ${exitCode}:\n${stderr}`, exitCode, stderr);
	}
	get aborted() {
		return false;
	}
}

export class AbortError extends Exception {
	constructor(
		public readonly reason: unknown,
		stderr: string,
	) {
		const msg = reason instanceof Error ? reason.message : String(reason ?? "aborted");
		super(`Operation cancelled: ${msg}`, -1, stderr);
	}
	get aborted() {
		return true;
	}
}

export class TimeoutError extends AbortError {
	constructor(timeout: number, stderr: string) {
		super(new Error(`Timed out after ${Math.round(timeout / 1000)}s`), stderr);
	}
}

export class OutputLimitError extends AbortError {
	constructor(stream: "stdout" | "stderr", maxBytes: number, stderr: string) {
		super(new Error(`${stream} exceeded the ${maxBytes} byte output limit`), stderr);
	}
}

export interface OutputLimits {
	maxStdoutBytes?: number;
	maxStderrBytes?: number;
}

export interface WaitOptions extends OutputLimits {
	allowNonZero?: boolean;
	allowAbort?: boolean;

	stderr?: "full" | "buffer";
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	ok: boolean;
	exitError?: Exception;
}

/** The part of a pipe reader collection uses; Bun's and Node's stream reader types both satisfy it. */
interface ChunkReader {
	read(): Promise<{ done: boolean; value?: Uint8Array<ArrayBuffer> }>;
	cancel(reason?: unknown): Promise<void>;
}

interface CollectedOutput {
	bytes: Uint8Array<ArrayBuffer>;
	overflow?: OutputLimitError;
}

function normalizeOutputLimit(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) throw new RangeError("Output limits must be finite and non-negative");
	return Math.floor(value);
}

function concatChunks(chunks: readonly Uint8Array[], length: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

const DEFAULT_STDERR_CAPTURE_BYTES = 1 * 1024 * 1024;

export class ChildProcess<In extends InMask = InMask> {
	#nothrow = false;
	#stderrTail = "";
	#stderrChunks?: Uint8Array[];
	#exitReason?: Exception;
	#exitReasonPending?: Exception;
	#stderrDone: Promise<void>;
	#exited: Promise<number>;
	// The stderr drain counts as one open reader until it ends; stdout readers add themselves.
	#openPipeReaders = 1;
	// Pipe reads race this cutoff only when attachTimeout() sets a command deadline. Untimed commands keep complete
	// EOF-based capture; timed ones stop at the deadline even when an orphaned descendant still holds the pipes.
	#drainCutoff: Promise<void>;
	#resolveDrainCutoff: () => void;
	#timeoutTimer?: NodeJS.Timeout;
	#stderrStream?: ReadableStream<Uint8Array>;
	#stderrLimitError?: OutputLimitError;
	#maxStdoutBytes?: number;
	#maxStderrBytes = DEFAULT_STDERR_CAPTURE_BYTES;
	// Termination in flight after kill(); aborted results wait for it before reporting.
	#terminating?: Promise<boolean | void>;
	#terminateGroup: boolean;

	constructor(
		readonly proc: PipedSubprocess<In>,
		readonly exposeStderr: boolean,
		retainFullStderr = exposeStderr,
		outputLimits: OutputLimits = {},
		terminateGroup = false,
	) {
		this.#maxStdoutBytes = normalizeOutputLimit(outputLimits.maxStdoutBytes);
		this.#maxStderrBytes = normalizeOutputLimit(outputLimits.maxStderrBytes) ?? DEFAULT_STDERR_CAPTURE_BYTES;
		this.#terminateGroup = terminateGroup;
		if (retainFullStderr) this.#stderrChunks = [];

		const dec = new TextDecoder();
		const trim = () => {
			if (this.#stderrTail.length > NonZeroExitError.MAX_TRACE)
				this.#stderrTail = this.#stderrTail.slice(-NonZeroExitError.MAX_TRACE);
		};
		let stderrStream = proc.stderr;
		if (exposeStderr) {
			const [teeStream, drainStream] = stderrStream.tee();
			this.#stderrStream = teeStream;
			stderrStream = drainStream;
		}
		const drainCutoff = Promise.withResolvers<void>();
		this.#drainCutoff = drainCutoff.promise;
		this.#resolveDrainCutoff = drainCutoff.resolve;

		this.#stderrDone = (async () => {
			const reader = stderrStream.getReader();
			try {
				let retainedBytes = 0;
				for (;;) {
					const chunk = await this.#nextChunk(reader);
					if (!chunk) break;
					const accepted = Math.max(0, Math.min(chunk.byteLength, this.#maxStderrBytes - retainedBytes));
					if (accepted > 0) {
						const retained = accepted === chunk.byteLength ? chunk : chunk.subarray(0, accepted);
						this.#stderrChunks?.push(retained);
						this.#stderrTail += dec.decode(retained, { stream: true });
						retainedBytes += accepted;
						trim();
					}
					if (accepted < chunk.byteLength) {
						const reason = new OutputLimitError("stderr", this.#maxStderrBytes, this.#stderrTail);
						this.#stderrLimitError = reason;
						await reader.cancel(reason).catch(() => {});
						this.kill(reason);
						break;
					}
				}
			} catch {}
			this.#openPipeReaders--;
			this.#stderrTail += dec.decode();
			trim();
		})();

		const { promise, resolve, reject } = Promise.withResolvers<number>();
		this.#exited = promise;

		proc.exited
			.catch(() => null)
			.then(async exitCode => {
				if (this.#exitReasonPending) {
					this.#exitReason = this.#exitReasonPending;
					reject(this.#exitReasonPending);
					return;
				}
				if (exitCode === 0) {
					resolve(0);
					return;
				}

				await this.#stderrDone;
				if (this.#exitReasonPending) {
					this.#exitReason = this.#exitReasonPending;
					reject(this.#exitReasonPending);
					return;
				}

				if (exitCode !== null) {
					this.#exitReason = new NonZeroExitError(exitCode, this.#stderrTail);
					resolve(exitCode);
					return;
				}

				const ex = this.proc.killed
					? new AbortError(new Error("process killed"), this.#stderrTail)
					: new NonZeroExitError(-1, this.#stderrTail);
				this.#exitReason = ex;
				reject(ex);
			});
	}

	get pid() {
		return this.proc.pid;
	}
	get exited() {
		return this.#exited;
	}
	get exitCode() {
		return this.proc.exitCode;
	}
	get exitReason() {
		return this.#exitReason;
	}
	get killed() {
		return this.proc.killed;
	}
	get stdin(): Bun.SpawnOptions.WritableToIO<In> {
		return this.proc.stdin;
	}

	get stdout() {
		return this.proc.stdout;
	}

	get stderr() {
		return this.#stderrStream;
	}

	get exitedCleanly(): Promise<number> {
		if (this.#nothrow) return this.#exited;
		return this.#exited.then(code => {
			if (code !== 0) throw new NonZeroExitError(code, this.#stderrTail);
			return code;
		});
	}

	peekStderr() {
		return this.#stderrTail;
	}

	nothrow(): this {
		this.#nothrow = true;
		return this;
	}

	kill(reason?: Exception, gracefulMs?: number) {
		if (reason && !this.#exitReasonPending) {
			this.#exitReasonPending = reason;
			// The normalized exit promise may already have resolved from a dead group leader; results still need to
			// report the later deadline.
			if (this.proc.exitCode !== null) this.#exitReason = reason;
		}
		if (this.proc.exitCode !== null && this.#terminateGroup && this.#openPipeReaders > 0) {
			// A detached child leads its own process group. Once the leader exits the native handle cannot rediscover
			// the group id, but a pipe-holding descendant keeps that exact group alive.
			try {
				process.kill(-this.proc.pid, "SIGKILL");
			} catch {}
			this.#terminating = Promise.resolve();
			return;
		}
		if (!this.proc.killed) {
			const options =
				gracefulMs === undefined
					? this.#terminateGroup
						? { group: true }
						: undefined
					: { gracefulMs, group: this.#terminateGroup };
			this.#terminating = Process.fromPid(this.proc.pid)
				?.terminate(options)
				?.catch(e => void e);
		}
	}

	/** Next chunk, or `undefined` at EOF or once the command deadline cuts collection off. */
	async #nextChunk(reader: ChunkReader): Promise<Uint8Array<ArrayBuffer> | undefined> {
		const next = await Promise.race([reader.read(), this.#drainCutoff.then(() => undefined)]);
		if (next === undefined) {
			await reader.cancel().catch(() => {});
			return undefined;
		}
		return next.done ? undefined : next.value;
	}

	/** Collect stdout until EOF, the command deadline, or `maxBytes` (which kills the child). */
	async #collectStdout(maxBytes: number | undefined): Promise<CollectedOutput> {
		this.#openPipeReaders++;
		const reader = this.proc.stdout.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		let overflow: OutputLimitError | undefined;
		try {
			for (;;) {
				const chunk = await this.#nextChunk(reader);
				if (!chunk) break;
				if (maxBytes !== undefined && length + chunk.byteLength > maxBytes) {
					const accepted = maxBytes - length;
					if (accepted > 0) {
						chunks.push(chunk.subarray(0, accepted));
						length += accepted;
					}
					overflow = new OutputLimitError("stdout", maxBytes, "");
					await reader.cancel(overflow).catch(() => {});
					this.kill(overflow);
					break;
				}
				chunks.push(chunk);
				length += chunk.byteLength;
			}
		} catch {
			// A cancelled or failed read keeps whatever was already collected.
		} finally {
			this.#openPipeReaders--;
			reader.releaseLock();
		}
		return { bytes: concatChunks(chunks, length), overflow };
	}

	async #throwIfAborted(): Promise<void> {
		const exitReason = this.exitReason;
		if (!exitReason?.aborted) return;
		if (this.#terminating) await this.#terminating;
		throw exitReason;
	}

	async #readOutputBytes(maxBytes: number | undefined, waitForCleanExit: boolean): Promise<Uint8Array<ArrayBuffer>> {
		const p = this.#collectStdout(maxBytes);
		if (this.#nothrow) return (await p).bytes;
		const { bytes, overflow } = waitForCleanExit ? (await Promise.all([p, this.exitedCleanly]))[0] : await p;
		if (overflow) throw overflow;
		await this.#throwIfAborted();
		return bytes;
	}

	async text(maxBytes?: number): Promise<string> {
		const limit = maxBytes === undefined ? this.#maxStdoutBytes : normalizeOutputLimit(maxBytes);
		return new TextDecoder().decode(await this.#readOutputBytes(limit, true));
	}

	async blob(): Promise<Blob> {
		return new Blob([await this.#readOutputBytes(this.#maxStdoutBytes, true)]);
	}

	async json(): Promise<unknown> {
		return JSON.parse(new TextDecoder().decode(await this.#readOutputBytes(this.#maxStdoutBytes, false)));
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		return (await this.#readOutputBytes(this.#maxStdoutBytes, false)).buffer;
	}

	async bytes(): Promise<Uint8Array> {
		return this.#readOutputBytes(this.#maxStdoutBytes, false);
	}

	async wait(opts?: WaitOptions): Promise<ExecResult> {
		const { allowNonZero = false, allowAbort = false, stderr: stderrMode = "buffer" } = opts ?? {};
		const stderrChunks = this.#stderrChunks;
		if (stderrMode === "full" && !stderrChunks) {
			throw new Error('Full stderr capture must be requested when spawning the process (pass stderr: "full")');
		}

		const stdoutP = this.#collectStdout(
			opts?.maxStdoutBytes === undefined ? this.#maxStdoutBytes : normalizeOutputLimit(opts.maxStdoutBytes),
		);
		const stderrP =
			stderrMode === "full" && stderrChunks
				? this.#stderrDone.then(() => new TextDecoder().decode(Buffer.concat(stderrChunks)))
				: this.#stderrDone.then(() => this.#stderrTail);

		const [stdoutResult, stderr] = await Promise.all([stdoutP, stderrP]);
		const stdout = new TextDecoder().decode(stdoutResult.bytes);

		let exitError: Exception | undefined;
		try {
			await this.#exited;
		} catch (err) {
			if (err instanceof Exception) exitError = err;
			else throw err;
		}
		this.#clearTimeout();

		if (!exitError) exitError = this.exitReason;
		if (!exitError) exitError = stdoutResult.overflow ?? this.#stderrLimitError;
		if (!exitError && this.exitCode !== null && this.exitCode !== 0) {
			exitError = new NonZeroExitError(this.exitCode, this.#stderrTail);
		}

		// Hold an aborted result until the kill completes: reporting while termination is still in flight would leave
		// timed-out descendants alive past the caller's budget.
		if (exitError?.aborted && this.#terminating) await this.#terminating;

		const exitCode = exitError?.aborted ? null : (this.exitCode ?? (exitError ? exitError.exitCode : null));
		const ok = exitCode === 0 && !exitError;

		if (exitError) {
			if ((exitError.aborted && !allowAbort) || (!exitError.aborted && !allowNonZero)) throw exitError;
		}

		return { stdout, stderr, exitCode, ok, exitError };
	}

	attachSignal(signal: AbortSignal): void {
		const onAbort = () => this.kill(new AbortError(signal.reason, "<cancelled>"));
		if (signal.aborted) return void onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		this.#exited.catch(() => {}).finally(() => signal.removeEventListener("abort", onAbort));
	}

	#clearTimeout(): void {
		if (!this.#timeoutTimer) return;
		clearTimeout(this.#timeoutTimer);
		this.#timeoutTimer = undefined;
	}

	attachTimeout(ms: number): void {
		if (ms <= 0 || this.proc.killed) return;
		this.#exited.catch(() => {});
		// One unref'd deadline controls both termination and pipe collection; wait() clears it, so a fast command
		// does not hold the event loop for the unused remainder.
		const timer = setTimeout(() => {
			// The caller's budget is breached: hard-kill the tree (a graceful phase loses TERM-ignoring descendants once
			// the root dies). A detached group can outlive its leader; kill it only while an inherited pipe proves the
			// group still has a live member, which avoids stale group-id reuse.
			if (this.proc.exitCode === null || (this.#openPipeReaders > 0 && this.#terminateGroup)) {
				this.kill(new TimeoutError(ms, this.#stderrTail), -1);
			}
			this.#resolveDrainCutoff();
		}, ms);
		timer.unref?.();
		this.#timeoutTimer = timer;
	}

	[Symbol.dispose](): void {
		if (this.proc.exitCode !== null) return;
		this.kill(new AbortError("process disposed", this.#stderrTail));
	}
}

type ChildSpawnOptions<In extends InMask = InMask> = Omit<
	Spawn.SpawnOptions<In, "pipe", "pipe">,
	"stdout" | "stderr" | "detached"
> &
	OutputLimits & {
		signal?: AbortSignal;
		detached?: boolean;

		stderr?: "full" | null;
	};

function spawnInternal<In extends InMask = InMask>(
	cmd: string[],
	opts: ChildSpawnOptions<In> | undefined,
	retainFullStderr: boolean,
): ChildProcess<In> {
	const { timeout = -1, signal, stderr, detached, maxStdoutBytes, maxStderrBytes, ...rest } = opts ?? {};
	const child = Bun.spawn(cmd, {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
		detached,
		...rest,
	});
	const cp = new ChildProcess(
		child,
		stderr === "full",
		retainFullStderr,
		{ maxStdoutBytes, maxStderrBytes },
		detached === true,
	);
	if (signal) cp.attachSignal(signal);
	if (timeout > 0) cp.attachTimeout(timeout);
	return cp;
}

export function spawn<In extends InMask = InMask>(cmd: string[], opts?: ChildSpawnOptions<In>): ChildProcess<In> {
	return spawnInternal(cmd, opts, opts?.stderr === "full");
}

export interface ExecOptions extends Omit<ChildSpawnOptions, "stderr" | "stdin">, WaitOptions {
	input?: string | Buffer | Uint8Array;
}

export async function exec(cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
	const { input, stderr, allowAbort, allowNonZero, maxStdoutBytes, maxStderrBytes, ...spawnOpts } = opts ?? {};
	const stdin = typeof input === "string" ? Buffer.from(input) : input;
	const resolved: ChildSpawnOptions =
		stdin === undefined
			? { ...spawnOpts, maxStdoutBytes, maxStderrBytes }
			: { ...spawnOpts, stdin, maxStdoutBytes, maxStderrBytes };
	using child = spawnInternal(cmd, resolved, stderr === "full");
	return await child.wait({ stderr, allowAbort, allowNonZero, maxStdoutBytes, maxStderrBytes });
}

type SignalValue = AbortSignal | number | null | undefined;

export function combineSignals(...signals: SignalValue[]): AbortSignal | undefined {
	let timeout: number | undefined;

	let n = 0;
	for (let i = 0; i < signals.length; i++) {
		const s = signals[i];
		if (s instanceof AbortSignal) {
			if (s.aborted) return s;
			if (i !== n) signals[n] = s;
			n++;
		} else if (typeof s === "number" && s > 0) {
			timeout = timeout === undefined ? s : Math.min(timeout, s);
		}
	}
	if (timeout !== undefined) {
		signals[n] = AbortSignal.timeout(timeout);
		n++;
	}
	switch (n) {
		case 0:
			return undefined;
		case 1:
			return signals[0] as AbortSignal;
		default:
			return AbortSignal.any(signals.slice(0, n) as AbortSignal[]);
	}
}
