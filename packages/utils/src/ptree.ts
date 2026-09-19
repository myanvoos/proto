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

interface ChildOutputResult {
	text: string;
	overflow: boolean;
	reason?: OutputLimitError;
}

function normalizeOutputLimit(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) throw new RangeError("Output limits must be finite and non-negative");
	return Math.floor(value);
}

async function readChildOutput(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number | undefined,
	onOverflow: (reason: OutputLimitError) => void,
	streamName: "stdout" | "stderr",
): Promise<ChildOutputResult> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			if (maxBytes !== undefined && total + value.byteLength > maxBytes) {
				const accepted = Math.max(0, maxBytes - total);
				if (accepted > 0) {
					chunks.push(value.subarray(0, accepted));
					total += accepted;
				}
				const reason = new OutputLimitError(streamName, maxBytes, "");
				await reader.cancel(reason).catch(() => {});
				onOverflow(reason);
				const bytes = new Uint8Array(total);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.byteLength;
				}
				return { text: decoder.decode(bytes), overflow: true, reason };
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { text: decoder.decode(bytes), overflow: false };
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
	#stderrStream?: ReadableStream<Uint8Array>;
	#stderrLimitError?: OutputLimitError;
	#maxStdoutBytes?: number;
	#maxStderrBytes = DEFAULT_STDERR_CAPTURE_BYTES;

	constructor(
		readonly proc: PipedSubprocess<In>,
		readonly exposeStderr: boolean,
		retainFullStderr = exposeStderr,
		outputLimits: OutputLimits = {},
	) {
		this.#maxStdoutBytes = normalizeOutputLimit(outputLimits.maxStdoutBytes);
		this.#maxStderrBytes = normalizeOutputLimit(outputLimits.maxStderrBytes) ?? DEFAULT_STDERR_CAPTURE_BYTES;
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
		this.#stderrDone = (async () => {
			try {
				let retainedBytes = 0;
				for await (const chunk of stderrStream) {
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
						this.kill(reason);
						break;
					}
				}
			} catch {}
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
		if (reason && !this.#exitReasonPending) this.#exitReasonPending = reason;
		if (!this.proc.killed)
			void Process.fromPid(this.proc.pid)
				?.terminate(gracefulMs === undefined ? undefined : { gracefulMs })
				?.catch(e => void e);
	}

	async text(maxBytes?: number): Promise<string> {
		const result = await readChildOutput(
			this.stdout,
			maxBytes === undefined ? this.#maxStdoutBytes : normalizeOutputLimit(maxBytes),
			reason => this.kill(reason),
			"stdout",
		);
		if (this.#nothrow) return result.text;
		await this.exitedCleanly;
		if (result.overflow) throw result.reason;
		return result.text;
	}

	async blob(): Promise<Blob> {
		const p = new Response(this.stdout).blob();
		if (this.#nothrow) return p;
		const [blob] = await Promise.all([p, this.exitedCleanly]);
		return blob;
	}

	async json(): Promise<unknown> {
		return new Response(this.stdout).json();
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		return new Response(this.stdout).arrayBuffer();
	}

	async bytes(): Promise<Uint8Array> {
		const body = (await new Response(this.stdout).bytes()) as Uint8Array | ArrayBuffer;
		return body instanceof Uint8Array ? body : new Uint8Array(body);
	}

	async wait(opts?: WaitOptions): Promise<ExecResult> {
		const { allowNonZero = false, allowAbort = false, stderr: stderrMode = "buffer" } = opts ?? {};
		const stderrChunks = this.#stderrChunks;
		if (stderrMode === "full" && !stderrChunks) {
			throw new Error('Full stderr capture must be requested when spawning the process (pass stderr: "full")');
		}

		const stdoutP = readChildOutput(
			this.stdout,
			opts?.maxStdoutBytes === undefined ? this.#maxStdoutBytes : normalizeOutputLimit(opts.maxStdoutBytes),
			reason => this.kill(reason),
			"stdout",
		);
		const stderrP =
			stderrMode === "full" && stderrChunks
				? this.#stderrDone.then(() => new TextDecoder().decode(Buffer.concat(stderrChunks)))
				: this.#stderrDone.then(() => this.#stderrTail);

		const [stdoutResult, stderr] = await Promise.all([stdoutP, stderrP]);
		const stdout = stdoutResult.text;

		let exitError: Exception | undefined;
		try {
			await this.#exited;
		} catch (err) {
			if (err instanceof Exception) exitError = err;
			else throw err;
		}

		if (!exitError) exitError = this.exitReason;
		if (!exitError) exitError = stdoutResult.reason ?? this.#stderrLimitError;
		if (!exitError && this.exitCode !== null && this.exitCode !== 0) {
			exitError = new NonZeroExitError(this.exitCode, this.#stderrTail);
		}

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

	attachTimeout(ms: number): void {
		if (ms <= 0 || this.proc.killed) return;
		this.#exited.catch(() => {});
		Promise.race([
			Bun.sleep(ms).then(() => true),
			this.proc.exited.then(
				() => false,
				() => false,
			),
		]).then(timedOut => {
			if (timedOut) this.kill(new TimeoutError(ms, this.#stderrTail));
		});
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
	const { timeout = -1, signal, stderr, maxStdoutBytes, maxStderrBytes, ...rest } = opts ?? {};
	const child = Bun.spawn(cmd, {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
		...rest,
	});
	const cp = new ChildProcess(child, stderr === "full", retainFullStderr, { maxStdoutBytes, maxStderrBytes });
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
