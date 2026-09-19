import { getProjectDir, readJsonl, toError } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPRequestOptions,
	MCPStdioServerConfig,
	MCPTransport,
} from "../../mcp/types";
import { toJsonRpcError } from "../../mcp/types";
import { RequestIdAllocator } from "../request-id";
import { isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "../timeout";

interface StdioSpawnCommand {
	cmd: string[];

	detached: boolean;
}

// stdio MCP servers are third-party executables; they must not receive the
// agent's full environment (provider API keys, cloud tokens). The child gets a
// curated, non-secret baseline that keeps real servers working (command lookup,
// caches, temp files, locales, TLS/proxy settings) plus every variable the
// server config explicitly grants via `env`. Grant additional variables by
// listing them in the server's `env`: unless `envPolicy: "literal"` is set, a
// value that names an existing environment variable resolves to that
// variable's value (e.g. `NODE_EXTRA_CA_CERTS: "NODE_EXTRA_CA_CERTS"`), and
// any other value is passed through literally.
const POSIX_BASELINE_ENV_KEYS: readonly string[] = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_RUNTIME_DIR",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
];

// Windows child processes need a wider baseline: node/python and the shell
// resolve system directories, drives, and temp paths through these.
const WINDOWS_BASELINE_ENV_KEYS: readonly string[] = [
	"PATH",
	"SystemRoot",
	"SystemDrive",
	"windir",
	"ComSpec",
	"PATHEXT",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"USERNAME",
	"APPDATA",
	"LOCALAPPDATA",
	"ProgramData",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"CommonProgramFiles",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
	"OS",
	"TMP",
	"TEMP",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
];

export function buildStdioChildEnv(
	configEnv: Record<string, string> | undefined,
	options?: { platform?: NodeJS.Platform; sourceEnv?: Record<string, string | undefined> },
): Record<string, string> {
	const baseline =
		(options?.platform ?? process.platform) === "win32" ? WINDOWS_BASELINE_ENV_KEYS : POSIX_BASELINE_ENV_KEYS;
	const source = options?.sourceEnv ?? Bun.env;
	const env: Record<string, string> = {};
	for (const key of baseline) {
		const value = source[key];
		if (value !== undefined) env[key] = value;
	}
	if (configEnv) {
		for (const [key, value] of Object.entries(configEnv)) {
			env[key] = value;
		}
	}
	return env;
}

interface ResolveStdioSpawnOptions {
	platform?: NodeJS.Platform;
}

export async function resolveStdioSpawnCommand(
	config: MCPStdioServerConfig,
	options: ResolveStdioSpawnOptions,
): Promise<StdioSpawnCommand> {
	const args = config.args ?? [];
	return { cmd: [config.command, ...args], detached: options.platform !== "darwin" };
}

interface FrameSink {
	write(chunk: string): unknown;
	flush(): unknown;
}

const MAX_STDIO_FRAME_BYTES = 8 * 1024 * 1024;
const LF = 0x0a;

function limitJsonlFrameBytes(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	let frameBytes = 0;
	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				let start = 0;
				for (let newline = chunk.indexOf(LF, start); newline !== -1; newline = chunk.indexOf(LF, start)) {
					frameBytes += newline - start;
					if (frameBytes > MAX_STDIO_FRAME_BYTES) {
						throw new Error(`MCP stdio frame exceeded ${MAX_STDIO_FRAME_BYTES} bytes`);
					}
					frameBytes = 0;
					start = newline + 1;
				}

				frameBytes += chunk.byteLength - start;
				if (frameBytes > MAX_STDIO_FRAME_BYTES) {
					throw new Error(`MCP stdio frame exceeded ${MAX_STDIO_FRAME_BYTES} bytes`);
				}
				controller.enqueue(chunk);
			},
		}),
	);
}

export async function writeFrame(stdin: FrameSink, frame: string): Promise<void> {
	await stdin.write(frame);
	await stdin.flush();
}

const TERM_GRACE_MS = 1000;

const KILL_GRACE_MS = 500;

interface KillableSubprocess {
	readonly pid: number;
	readonly exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
}

async function waitForProcessExit(exited: Promise<number>, timeoutMs: number): Promise<boolean> {
	const { promise: timedOut, resolve: resolveTimedOut } = Promise.withResolvers<false>();
	const timer = setTimeout(() => resolveTimedOut(false), timeoutMs);
	try {
		return await Promise.race([
			exited.then(
				() => true,
				() => true,
			),
			timedOut,
		]);
	} finally {
		clearTimeout(timer);
	}
}

function isErrnoCode(error: unknown, code: string): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	return error.code === code;
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Aborted");
}

function signalStdioProcess(proc: KillableSubprocess, detached: boolean, signal: NodeJS.Signals): void {
	if (detached) {
		try {
			process.kill(-proc.pid, signal);
			return;
		} catch (error) {
			if (isErrnoCode(error, "ESRCH")) return;
		}
	}
	try {
		proc.kill(signal);
	} catch {}
}

export async function terminateStdioProcess(
	proc: KillableSubprocess,
	detached: boolean,
	termGraceMs = TERM_GRACE_MS,
): Promise<void> {
	signalStdioProcess(proc, detached, "SIGTERM");
	const exitedOnTerm = await waitForProcessExit(proc.exited, termGraceMs);

	if (exitedOnTerm && !detached) return;
	signalStdioProcess(proc, detached, "SIGKILL");

	if (!exitedOnTerm) await waitForProcessExit(proc.exited, KILL_GRACE_MS);
}

export class StdioTransport implements MCPTransport {
	#process: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	#pendingRequests = new Map<
		string | number,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
		}
	>();
	#connected = false;
	#readLoop: Promise<void> | null = null;
	#terminateInFlight: Promise<void> | null = null;

	#detached = false;
	readonly #requestIds = new RequestIdAllocator();

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;

	constructor(private config: MCPStdioServerConfig) {}

	get connected(): boolean {
		return this.#connected;
	}

	#clearCallbacks(): void {
		this.onClose = undefined;
		this.onError = undefined;
		this.onNotification = undefined;
		this.onRequest = undefined;
	}

	async connect(options?: MCPRequestOptions): Promise<void> {
		if (options?.signal?.aborted) throw abortReason(options.signal);
		if (this.#connected) return;

		const env = buildStdioChildEnv(this.config.env);
		const cwd = this.config.cwd ?? getProjectDir();
		const spawnCommand = await resolveStdioSpawnCommand(this.config, { platform: process.platform });

		const proc = Bun.spawn(spawnCommand.cmd, {
			cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			detached: spawnCommand.detached,
		});
		if (options?.signal?.aborted) {
			await terminateStdioProcess(proc, spawnCommand.detached);
			throw abortReason(options.signal);
		}
		this.#process = proc;
		this.#detached = spawnCommand.detached;

		this.#connected = true;

		this.#readLoop = this.#startReadLoop();

		this.#startStderrLoop();
	}

	async #startReadLoop(): Promise<void> {
		const proc = this.#process;
		if (!proc?.stdout) return;
		try {
			for await (const line of readJsonl(limitJsonlFrameBytes(proc.stdout))) {
				if (!this.#connected) break;
				try {
					this.#handleMessage(line as JsonRpcMessage);
				} catch {}
			}
		} catch (error) {
			if (this.#connected) await this.#handleTransportFailure(error, proc);
		} finally {
			this.#handleClose();
		}
	}

	async #startStderrLoop(): Promise<void> {
		if (!this.#process?.stderr) return;

		const reader = this.#process.stderr.getReader();
		const decoder = new TextDecoder();

		try {
			while (this.#connected) {
				const { done, value } = await reader.read();
				if (done) break;

				const text = decoder.decode(value, { stream: true });
				if (text.trim()) {
				}
			}
		} catch {
		} finally {
			reader.releaseLock();
		}
	}

	#handleMessage(message: JsonRpcMessage | JsonRpcMessage[]): void {
		if (Array.isArray(message)) {
			for (const m of message) this.#handleMessage(m);
			return;
		}

		if ("method" in message && "id" in message && message.id != null) {
			void this.#handleServerRequest(message as JsonRpcRequest);
			return;
		}

		if ("id" in message && message.id != null) {
			const response = message as JsonRpcResponse;
			const pending = this.#pendingRequests.get(response.id);
			if (pending) {
				this.#pendingRequests.delete(response.id);
				if (response.error) {
					pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
				} else {
					pending.resolve(response.result);
				}
			}
			return;
		}

		if ("method" in message) {
			const notification = message as { method: string; params?: unknown };
			this.onNotification?.(notification.method, notification.params);
		}
	}

	async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
		try {
			if (!this.onRequest) {
				await this.#sendResponse(request.id, undefined, { code: -32601, message: "Method not found" });
				return;
			}
			const result = await this.onRequest(request.method, request.params);
			await this.#sendResponse(request.id, result);
		} catch (error) {
			await this.#sendResponse(request.id, undefined, toJsonRpcError(error));
		}
	}

	async #sendResponse(id: string | number, result?: unknown, error?: JsonRpcError): Promise<void> {
		if (!this.#connected || !this.#process?.stdin) return;
		const response = error
			? { jsonrpc: "2.0" as const, id, error }
			: { jsonrpc: "2.0" as const, id, result: result ?? {} };

		try {
			await writeFrame(this.#process.stdin, `${JSON.stringify(response)}\n`);
		} catch (writeError) {
			await this.#handleTransportFailure(writeError);
		}
	}

	#handleClose(): void {
		if (!this.#connected) return;
		this.#connected = false;

		for (const [, pending] of this.#pendingRequests) {
			pending.reject(new Error("Transport closed"));
		}
		this.#pendingRequests.clear();

		const onClose = this.onClose;
		this.#clearCallbacks();
		onClose?.();
	}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error("Transport not connected");
		}

		const id = this.#requestIds.next(this.config.requestIdFormat);
		const request = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const signal = options?.signal;

		if (signal?.aborted) {
			const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
			return Promise.reject(reason);
		}

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let timer: NodeJS.Timeout | undefined;
		let settled = false;

		const cleanup = () => {
			if (settled) return;
			settled = true;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
			this.#pendingRequests.delete(id);
		};

		const onAbort = () => {
			cleanup();
			const reason = signal?.reason instanceof Error ? signal.reason : new Error("Aborted");
			reject(reason);
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		this.#pendingRequests.set(id, {
			resolve: (value: unknown) => {
				cleanup();
				resolve(value as T);
			},
			reject: (error: Error) => {
				cleanup();
				reject(error);
			},
		});

		if (isMCPTimeoutEnabled(timeout)) {
			timer = setTimeout(() => {
				const timeoutError = new Error(`Request timeout after ${timeout}ms`);
				cleanup();
				reject(timeoutError);
				// A request that outlives its timeout means the server stopped
				// answering this pipe. Tear the transport down so the manager
				// reconnects instead of leaving every later call to burn the
				// full timeout on the same wedged process.
				void this.#handleTransportFailure(timeoutError).catch(() => {});
			}, timeout);
		}

		const stdin = this.#process.stdin;
		const message = `${JSON.stringify(request)}\n`;
		const failFromSend = (error: unknown) => {
			if (settled) return;
			cleanup();
			reject(toError(error));
		};
		const send = writeFrame(stdin, message).catch(async error => {
			failFromSend(error);
			await this.#handleTransportFailure(error);
		});
		send.catch(() => {});

		return promise;
	}

	async notify(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<void> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error("Transport not connected");
		}

		if (options?.signal?.aborted) throw abortReason(options.signal);
		const notification = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		try {
			await writeFrame(this.#process.stdin, `${JSON.stringify(notification)}\n`);
		} catch (error) {
			const failure = toError(error);
			await this.#handleTransportFailure(failure);
			throw failure;
		}
	}

	async #handleTransportFailure(
		error: unknown,
		proc: Subprocess<"pipe", "pipe", "pipe"> | null = this.#process,
	): Promise<Error> {
		const failure = toError(error);
		if (this.#connected) {
			try {
				this.onError?.(failure);
			} catch {}
		}
		try {
			this.#handleClose();
		} catch {}
		try {
			await this.#terminateProcess(proc);
		} catch {}
		return failure;
	}

	async #terminateProcess(proc: Subprocess<"pipe", "pipe", "pipe"> | null = this.#process): Promise<void> {
		if (!proc) return;
		if (this.#process === proc) this.#process = null;

		try {
			proc.stdin.end();
		} catch {}

		const termination = terminateStdioProcess(proc, this.#detached);
		this.#terminateInFlight = termination;
		try {
			await termination;
		} finally {
			if (this.#terminateInFlight === termination) this.#terminateInFlight = null;
		}
	}

	async close(_options?: MCPRequestOptions): Promise<void> {
		if (this.#connected) {
			this.#handleClose();
		}

		await this.#terminateProcess();
		// A concurrent teardown (e.g. a timed-out request) may still be killing
		// the child; closing callers must not return until it is done.
		while (this.#terminateInFlight) {
			await this.#terminateInFlight;
		}

		if (this.#readLoop) {
			this.#readLoop.catch(() => {});
			this.#readLoop = null;
		}
	}
}
