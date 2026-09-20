import { RpcFrameDecoder } from "../modes/rpc/rpc-frame";

/** Push/find queue for RPC frames with race-free waiter registration. */
export class RpcFrameQueue {
	#frames: object[] = [];
	#waiters = new Set<() => void>();

	push(frame: object): void {
		this.#frames.push(frame);
		for (const waiter of this.#waiters) waiter();
	}

	async next(): Promise<object> {
		for (;;) {
			const frame = this.#frames.shift();
			if (frame) return frame;
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.add(resolve);
			try {
				// Re-check after registering: a push landing between the shift
				// above and waiter registration must not be lost.
				const queued = this.#frames.shift();
				if (queued) return queued;
				await promise;
			} finally {
				this.#waiters.delete(resolve);
			}
		}
	}

	/** Awaits the next response frame carrying the given id. */
	async findResponse(id: string, timeoutMs: number): Promise<Record<string, unknown>> {
		const deadline = Date.now() + timeoutMs;
		const matches = (frame: object): boolean => {
			if (typeof frame !== "object" || frame === null || !("id" in frame)) return false;
			return (frame as { id: unknown }).id === id;
		};
		for (;;) {
			const index = this.#frames.findIndex(matches);
			if (index >= 0) {
				const [frame] = this.#frames.splice(index, 1) as [Record<string, unknown>];
				return frame;
			}
			if (Date.now() > deadline) throw new Error(`timed out waiting for rpc response ${id}`);
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.add(resolve);
			try {
				// Re-check after registering so a push that lands between the
				// findIndex above and waiter registration cannot be lost.
				const indexNow = this.#frames.findIndex(matches);
				if (indexNow >= 0) {
					const [frame] = this.#frames.splice(indexNow, 1) as [Record<string, unknown>];
					return frame;
				}
				if (Date.now() > deadline) throw new Error(`timed out waiting for rpc response ${id}`);
				await promise;
			} finally {
				this.#waiters.delete(resolve);
			}
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
	const decoder = new RpcFrameDecoder();
	const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
	const conn = await Bun.connect({
		unix: socket,
		socket: {
			data(_socket, chunk) {
				const text = new TextDecoder().decode(chunk);
				for (const line of text.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					try {
						const parsed: unknown = JSON.parse(trimmed);
						const frame = decoder.push(parsed);
						if (frame) frames.push(frame);
					} catch {
						// partial JSON line or chunk bookkeeping — decoder handles reassembly
					}
				}
			},
			close() {
				resolveClosed();
			},
			error() {
				resolveClosed();
			},
		},
	});
	return {
		sendCommand(command: object) {
			conn.write(`${JSON.stringify(command)}\n`);
		},
		frames,
		close() {
			conn.end();
		},
		closed,
	};
}
