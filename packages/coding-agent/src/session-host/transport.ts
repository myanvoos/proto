import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

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

	#write: ((line: string) => number) | undefined;
	#pending: Uint8Array[] = [];
	#wake: (() => void) | undefined;
	#closed = false;

	constructor() {
		this.input = new ReadableStream<Uint8Array>({
			pull: controller => {
				const next = () => {
					while (this.#pending.length > 0) {
						const chunk = this.#pending.shift();
						if (chunk && chunk.byteLength > 0) {
							controller.enqueue(chunk);
							return true;
						}
					}
					return false;
				};
				if (next()) return;
				if (this.#closed) {
					controller.close();
					return;
				}
				return new Promise<void>(resolve => {
					this.#wake = () => {
						this.#wake = undefined;
						resolve();
					};
				}).then(() => {
					next();
				});
			},
		});
	}

	hasClient(): boolean {
		return this.#write !== undefined;
	}

	/** Latest-wins attach; pending bytes of a replaced client are dropped so a
	 *  partial frame never leaks into the next client's command stream. */
	attach(write: (line: string) => number): void {
		this.#pending = [];
		this.#write = write;
	}

	detach(): void {
		this.#write = undefined;
		this.#pending = [];
	}

	feed(chunk: Uint8Array): void {
		if (!this.#write) return;
		this.#pending.push(chunk);
		this.#wake?.();
	}

	writeLine(line: string): void {
		this.#write?.(line);
	}

	close(): void {
		this.#closed = true;
		this.#write = undefined;
		this.#wake?.();
	}
}

export interface SessionHostRpcTransport {
	input: ReadableStream<Uint8Array>;
	writeFrame(line: string): void;
	hasClient(): boolean;
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
	let current: { close(): void } | undefined;

	const server = Bun.listen<undefined>({
		unix: socketPath,
		socket: {
			open(socket) {
				if (current) current.close();
				current = socket;
				mux.attach(line => socket.write(line));
			},
			data(_socket, chunk) {
				mux.feed(chunk);
			},
			close(socket) {
				if (current === socket) {
					current = undefined;
					mux.detach();
				}
			},
			error(socket) {
				if (current === socket) {
					current = undefined;
					mux.detach();
				}
				try {
					socket.end();
				} catch {}
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
			current?.close();
			current = undefined;
			await new Promise<void>(resolve => {
				server.stop(true);
				resolve();
			});
			try {
				await fs.rm(socketPath, { force: true });
			} catch {}
		},
	};
}
