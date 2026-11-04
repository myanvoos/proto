import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { MAX_RPC_FRAME_BYTES } from "../modes/rpc/rpc-frame";
import { MAX_SOCKET_QUEUE_BYTES, SocketWriter } from "../utils/socket-writer";

/**
 * Feeds the RPC command stream from whichever client is currently attached.
 *
 * The stream is deliberately never closed: when a client disconnects, the host
 * keeps the session (model turn, kernels, orchestrator workers) alive and waits
 * for the next `proto attach`. Without this, runRpcMode treats input closure as
 * "RPC client left" and disposes the session.
 *
 * Latest client wins: attaching while another client is connected detaches the
 * old one. Pending bytes from a detached client are dropped so a partial frame
 * never leaks into the next client's command stream.
 */
export class SessionHostMux {
	readonly input: ReadableStream<Uint8Array>;

	#writer: SocketWriter | undefined;
	#attachmentGeneration = 0;
	#pending: Uint8Array[] = [];
	#pendingBytes = 0;
	#fragments: Uint8Array[] = [];
	#fragmentBytes = 0;
	#serving = Promise.withResolvers<void>();
	#wake: (() => void) | undefined;
	#closed = false;

	constructor() {
		this.input = new ReadableStream<Uint8Array>({
			pull: async controller => {
				for (;;) {
					const chunk = this.#pending.shift();
					if (chunk) {
						this.#pendingBytes -= chunk.byteLength;
						controller.enqueue(chunk);
						return;
					}
					if (this.#closed) {
						controller.close();
						return;
					}
					const { promise, resolve } = Promise.withResolvers<void>();
					this.#wake = () => {
						this.#wake = undefined;
						resolve();
					};
					await promise;
				}
			},
		});
	}

	hasClient(): boolean {
		return this.#writer !== undefined;
	}

	/** Authority epoch: queued commands from a retired attachment cannot retain its lease. */
	get attachmentGeneration(): number {
		return this.#attachmentGeneration;
	}

	whenServing(): Promise<void> {
		return this.#serving.promise;
	}

	markServing(): void {
		this.#serving.resolve();
	}

	/** Retire the old connection, including its unsent output and incomplete input frame. */
	attach(writer: SocketWriter): void {
		this.detach();
		this.#attachmentGeneration++;
		this.#writer = writer;
	}

	detach(): void {
		if (this.#writer) this.#attachmentGeneration++;
		this.#writer?.close();
		this.#writer = undefined;
		this.#pending = [];
		this.#pendingBytes = 0;
		this.#fragments = [];
		this.#fragmentBytes = 0;
	}

	/** Only complete byte-delimited lines reach the shared UTF-8 RPC reader. */
	feed(chunk: Uint8Array): void {
		if (!this.#writer) return;
		let start = 0;
		for (let index = 0; index < chunk.byteLength; index++) {
			if (chunk[index] !== 10) continue;
			this.#appendFragment(chunk.subarray(start, index + 1));
			const line = new Uint8Array(this.#fragmentBytes);
			let offset = 0;
			for (const fragment of this.#fragments) {
				line.set(fragment, offset);
				offset += fragment.byteLength;
			}
			this.#fragments = [];
			this.#fragmentBytes = 0;
			this.#pending.push(line);
			this.#pendingBytes += line.byteLength;
			start = index + 1;
		}
		this.#appendFragment(chunk.subarray(start));
		if (this.#pending.length > 0) this.#wake?.();
	}

	#appendFragment(chunk: Uint8Array): void {
		if (this.#fragmentBytes + chunk.byteLength > MAX_RPC_FRAME_BYTES) {
			throw new Error("Session RPC command frame exceeded the transport limit");
		}
		if (this.#pendingBytes + this.#fragmentBytes + chunk.byteLength > MAX_SOCKET_QUEUE_BYTES) {
			throw new Error("Session RPC command backpressure limit exceeded");
		}
		if (chunk.byteLength === 0) return;
		this.#fragments.push(chunk.slice());
		this.#fragmentBytes += chunk.byteLength;
	}

	writeLine(line: string): void {
		this.#writer?.send(line);
	}

	close(): void {
		this.#closed = true;
		this.detach();
		this.#wake?.();
	}
}

let activeMux: SessionHostMux | undefined;

/** Called once by the session host worker before runCli claims RPC input. */
export function activateSessionHostTransport(mux: SessionHostMux): void {
	activeMux = mux;
}

/** RPC input override consumed by claimRpcInput() in protocol modes. */
export function getSessionHostRpcInput(): ReadableStream<Uint8Array> | undefined {
	return activeMux?.input;
}

/** The RPC command loop, not merely the socket listener, is ready to serve. */
export function markSessionHostServing(): void {
	activeMux?.markServing();
}

/** Captured at negotiation; a replaced/disconnected attachment loses command authority. */
export function getSessionHostAttachmentGeneration(): number {
	return activeMux?.attachmentGeneration ?? 0;
}

/** Frame sink override consumed by runRpcMode's writeFrames; null drops frames. */
export function getSessionHostRpcSink(): ((line: string) => void) | undefined {
	if (!activeMux) return undefined;
	return line => activeMux?.writeLine(line);
}

export interface SessionHostServer {
	mux: SessionHostMux;
	stop(): Promise<void>;
}

/**
 * Unix-socket server feeding the mux. One live client at a time; a new
 * connection replaces (and closes) the previous client.
 */
export async function listenSessionHost(socketPath: string): Promise<SessionHostServer> {
	// Bun.listen does not create the socket's parent directory; a pruned or
	// freshly-derived runtime dir must not fail the listen.
	await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
	try {
		await fs.rm(socketPath, { force: true });
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const mux = new SessionHostMux();
	let current: Bun.Socket<SocketWriter | undefined> | undefined;
	const fail = (socket: Bun.Socket<SocketWriter | undefined>, error: Error): void => {
		logger.warn("Session host socket transport failed", { socketPath, error: error.message });
		socket.data?.close(error);
		if (current === socket) {
			current = undefined;
			mux.detach();
		}
		socket.terminate();
	};

	const server = Bun.listen<SocketWriter | undefined>({
		unix: socketPath,
		socket: {
			open(socket) {
				current?.terminate();
				current = socket;
				const writer = new SocketWriter(
					bytes => socket.write(bytes),
					error => fail(socket, error),
				);
				socket.data = writer;
				mux.attach(writer);
			},
			data(socket, chunk) {
				if (current !== socket) return;
				try {
					mux.feed(chunk);
				} catch (error) {
					fail(socket, error instanceof Error ? error : new Error(String(error)));
				}
			},
			drain(socket) {
				socket.data?.drain();
			},
			close(socket) {
				socket.data?.close();
				if (current === socket) {
					current = undefined;
					mux.detach();
				}
			},
			end(socket) {
				socket.data?.close();
				if (current === socket) {
					current = undefined;
					mux.detach();
				}
				socket.terminate();
			},
			error(socket, error) {
				fail(socket, error);
			},
		},
	});

	try {
		await fs.chmod(socketPath, 0o600);
	} catch {}

	return {
		mux,
		async stop(): Promise<void> {
			mux.close();
			current?.terminate();
			current = undefined;
			server.stop(true);
			try {
				await fs.rm(socketPath, { force: true });
			} catch {}
		},
	};
}
