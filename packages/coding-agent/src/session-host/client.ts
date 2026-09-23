import { MAX_RPC_FRAME_BYTES, RpcFrameDecoder } from "../modes/rpc/rpc-frame";

/** Push/find queue for RPC frames with race-free waiter registration. */
export class RpcFrameQueue {
	#frames: object[] = [];
	#waiters = new Set<() => void>();
	#error: Error | undefined;

	push(frame: object): void {
		if (this.#error) return;
		this.#frames.push(frame);
		for (const waiter of this.#waiters) waiter();
	}

	close(error = new Error("session RPC connection closed")): void {
		if (this.#error) return;
		this.#error = error;
		for (const waiter of this.#waiters) waiter();
		this.#waiters.clear();
	}

	async next(): Promise<object> {
		for (;;) {
			const frame = this.#frames.shift();
			if (frame) return frame;
			if (this.#error) throw this.#error;
			await this.#wait();
		}
	}

	/** Awaits the next response frame carrying the given id. */
	async findResponse(id: string, timeoutMs: number): Promise<Record<string, unknown>> {
		const deadline = Date.now() + Math.max(0, timeoutMs);
		for (;;) {
			const index = this.#frames.findIndex(frame => "id" in frame && frame.id === id);
			if (index >= 0) {
				const [frame] = this.#frames.splice(index, 1) as [Record<string, unknown>];
				return frame;
			}
			if (this.#error) throw this.#error;
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`timed out waiting for rpc response ${id}`);
			await this.#wait(remaining);
		}
	}

	async #wait(timeoutMs?: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#waiters.add(resolve);
		const timer = timeoutMs === undefined ? undefined : setTimeout(resolve, timeoutMs);
		try {
			await promise;
		} finally {
			clearTimeout(timer);
			this.#waiters.delete(resolve);
		}
	}
}

export interface SessionRpcConnection {
	sendCommand(command: object): void;
	readonly frames: RpcFrameQueue;
	close(): void;
	readonly closed: Promise<void>;
}

/** Connects to a session host socket and speaks newline-delimited RPC frames. */
export async function connectSessionRpc(socket: string): Promise<SessionRpcConnection> {
	const frames = new RpcFrameQueue();
	let decoder = new RpcFrameDecoder();
	const textDecoder = new TextDecoder("utf-8", { fatal: true });
	let pending = "";
	const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
	const finish = (error?: Error): void => {
		pending = "";
		decoder = new RpcFrameDecoder();
		frames.close(error);
		resolveClosed();
	};
	const conn = await Bun.connect({
		unix: socket,
		socket: {
			data(socket, chunk) {
				try {
					const text = pending + textDecoder.decode(chunk, { stream: true });
					let start = 0;
					for (;;) {
						const end = text.indexOf("\n", start);
						const line = end < 0 ? text.slice(start) : text.slice(start, end);
						if (Buffer.byteLength(line, "utf8") >= MAX_RPC_FRAME_BYTES) {
							throw new Error("session RPC frame exceeded the transport limit");
						}
						if (end < 0) {
							pending = line;
							break;
						}
						if (line.trim()) {
							const frame = decoder.push(JSON.parse(line));
							if (frame) frames.push(frame);
						}
						start = end + 1;
					}
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
					socket.end();
				}
			},
			close() {
				finish();
			},
			end() {
				finish();
			},
			error(_socket, error) {
				finish(error);
			},
		},
	});
	return {
		sendCommand(command: object) {
			conn.write(`${JSON.stringify(command)}\n`);
		},
		frames,
		close() {
			finish();
			conn.end();
		},
		closed,
	};
}
