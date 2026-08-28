import * as net from "node:net";
import { logger } from "@oh-my-pi/pi-utils";
import { MessageFramer } from "../../jsonrpc/message-framing";
import { daemonClientForProject } from "../../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../../launch/ensure";
import { daemonRuntimeDir } from "../../launch/paths";
import { resolveWorkerSpawnCmd } from "../../subprocess/worker-client";
import type { LspJsonRpcRequest, LspJsonRpcResponse, LspTransport, LspWriteSink } from "../types";
import {
	LSP_MUX_DAEMON_NAME,
	LSP_MUX_PROJECT_DIR_ENV,
	LSP_MUX_READY_PATTERN,
	LSP_MUX_SOCKET_ENV,
	LSP_MUX_WORKER_ARG,
	lspMuxEndpoint,
	MUX_CONNECT_METHOD,
	MUX_PING_METHOD,
	MUX_PING_RESULT,
	type MuxConnectParams,
	type MuxConnectResult,
} from "./protocol";

const CONNECT_TIMEOUT_MS = 3_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 1_500;
const READY_TIMEOUT_MS = 15_000;

const ENSURE_ATTEMPTS = 3;

function connectEndpoint(endpoint: string, timeoutMs: number): Promise<net.Socket> {
	const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
	const socket = net.connect(endpoint);
	const timer = setTimeout(() => {
		socket.destroy();
		reject(new Error(`Timed out connecting to LSP mux at ${endpoint}`));
	}, timeoutMs);
	socket.once("connect", () => {
		clearTimeout(timer);
		socket.removeListener("error", onError);
		resolve(socket);
	});
	const onError = (error: Error) => {
		clearTimeout(timer);
		reject(error);
	};
	socket.once("error", onError);
	return promise;
}

function requestOnSocket(
	socket: net.Socket,
	request: LspJsonRpcRequest,
	timeoutMs: number,
): Promise<{ response: LspJsonRpcResponse; leftover: Buffer }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ response: LspJsonRpcResponse; leftover: Buffer }>();
	const framer = new MessageFramer(Buffer.alloc(0));
	const timer = setTimeout(() => {
		cleanup();
		reject(new Error(`LSP mux ${request.method} timed out`));
	}, timeoutMs);
	const onData = (chunk: Buffer) => {
		framer.push(chunk);
		for (const text of framer.drain(() => {})) {
			let message: LspJsonRpcResponse;
			try {
				message = JSON.parse(text);
			} catch (error) {
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			if (message.id !== request.id) continue;
			cleanup();
			if (message.error) reject(new Error(`LSP mux ${request.method} failed: ${message.error.message}`));
			else resolve({ response: message, leftover: framer.remainder() });
			return;
		}
	};
	const onClose = () => {
		cleanup();
		reject(new Error("LSP mux connection closed during handshake"));
	};
	const cleanup = () => {
		clearTimeout(timer);
		socket.removeListener("data", onData);
		socket.removeListener("close", onClose);
		socket.removeListener("error", onClose);
	};
	socket.on("data", onData);
	socket.once("close", onClose);
	socket.once("error", onClose);
	const content = JSON.stringify(request);
	socket.write(`Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n${content}`);
	return promise;
}

function socketTransport(socket: net.Socket, leftover: Buffer, pid: number | undefined): LspTransport {
	const exited = Promise.withResolvers<number>();
	let exitCode: number | null = null;
	let needDrain = false;
	socket.on("error", () => {});
	socket.once("close", () => {
		exitCode = 0;
		exited.resolve(0);
	});
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			if (leftover.byteLength > 0) controller.enqueue(new Uint8Array(leftover));
			socket.on("data", (chunk: Buffer) =>
				controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
			);
			socket.once("close", () => {
				try {
					controller.close();
				} catch {}
			});
		},
	});
	const stdin: LspWriteSink = {
		write(data) {
			needDrain = !socket.write(data);
			return typeof data === "string" ? Buffer.byteLength(data, "utf-8") : data.byteLength;
		},
		flush() {
			if (!needDrain || socket.destroyed) return;
			return new Promise<void>(resolveDrain => {
				const onDrain = () => {
					needDrain = false;
					socket.removeListener("close", onDrain);
					resolveDrain();
				};
				socket.once("drain", onDrain);
				socket.once("close", onDrain);
			});
		},
	};
	return {
		stdin,
		stdout,
		exited: exited.promise,
		get exitCode() {
			return exitCode;
		},
		pid,
		sharedMux: true,
		kill() {
			socket.destroy();
		},
		peekStderr() {
			return "";
		},
	};
}

let nextHandshakeId = 1;

async function dialMuxServer(endpoint: string, params: MuxConnectParams): Promise<LspTransport> {
	const socket = await connectEndpoint(endpoint, CONNECT_TIMEOUT_MS);
	socket.setNoDelay(true);
	try {
		const { response, leftover } = await requestOnSocket(
			socket,
			{ jsonrpc: "2.0", id: `connect:${nextHandshakeId++}`, method: MUX_CONNECT_METHOD, params },
			HANDSHAKE_TIMEOUT_MS,
		);
		const result = response.result as MuxConnectResult;
		return socketTransport(socket, leftover, result.pid);
	} catch (error) {
		socket.destroy();
		throw error;
	}
}

async function probeMux(endpoint: string): Promise<boolean> {
	try {
		const socket = await connectEndpoint(endpoint, PROBE_TIMEOUT_MS);
		try {
			const { response } = await requestOnSocket(
				socket,
				{ jsonrpc: "2.0", id: "probe", method: MUX_PING_METHOD, params: null },
				PROBE_TIMEOUT_MS,
			);
			return response.result === MUX_PING_RESULT;
		} finally {
			socket.destroy();
		}
	} catch {
		return false;
	}
}

async function ensureLspMuxDaemon(projectDir: string, signal?: AbortSignal): Promise<string | null> {
	const client = await daemonClientForProject(projectDir);
	const endpoint = lspMuxEndpoint(client.projectDir, daemonRuntimeDir(client.projectDir));

	await client.request({ op: "ping" }, signal);
	if (await probeMux(endpoint)) return endpoint;
	const spawn = resolveWorkerSpawnCmd(LSP_MUX_WORKER_ARG);
	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		signal?.throwIfAborted();

		if (await probeMux(endpoint)) return endpoint;
		const existing = await describeQuietly(client, LSP_MUX_DAEMON_NAME, "LSP mux", signal);
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			if (existing.readyAt === undefined) {
				await waitReady(client, LSP_MUX_DAEMON_NAME, "LSP mux", signal, READY_TIMEOUT_MS);
			}
			if (await probeMux(endpoint)) return endpoint;

			await stopQuietly(client, LSP_MUX_DAEMON_NAME, "LSP mux", signal);
			continue;
		}
		try {
			const started = await client.request(
				{
					op: "start",
					spec: {
						name: LSP_MUX_DAEMON_NAME,
						application: spawn.cmd[0]!,
						args: spawn.cmd.slice(1),
						env: {
							[LSP_MUX_SOCKET_ENV]: endpoint,
							[LSP_MUX_PROJECT_DIR_ENV]: client.projectDir,
						},
						cwd: spawn.cwd ?? client.projectDir,
						pty: false,
						ready: { log: LSP_MUX_READY_PATTERN, timeoutMs: READY_TIMEOUT_MS },
						restart: "no",
						persist: false,
						detached: false,
					},
				},
				signal,
			);
			if (started.op !== "start") continue;
			if (await probeMux(endpoint)) return endpoint;
			await stopQuietly(client, LSP_MUX_DAEMON_NAME, "LSP mux", signal);
		} catch (error) {
			signal?.throwIfAborted();

			logger.debug("LSP mux start contention", {
				name: LSP_MUX_DAEMON_NAME,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return null;
}

export async function connectSharedLspTransport(opts: {
	command: string;
	args: string[];
	cwd: string;
	env?: Record<string, string>;
	signal?: AbortSignal;
}): Promise<LspTransport | null> {
	try {
		const endpoint = await ensureLspMuxDaemon(opts.cwd, opts.signal);
		if (!endpoint) return null;
		return await dialMuxServer(endpoint, {
			command: opts.command,
			args: opts.args,
			cwd: opts.cwd,
			env: opts.env,
		});
	} catch (error) {
		if (opts.signal?.aborted) throw error;
		logger.debug("Shared LSP transport unavailable; falling back to local spawn", {
			command: opts.command,
			cwd: opts.cwd,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}
