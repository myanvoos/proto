/** A socket write accepts either a byte count (Bun) or the entire buffer (Node). */
export type SocketWrite = (bytes: Uint8Array) => number | boolean;

export const MAX_SOCKET_QUEUE_BYTES = 64 * 1024 * 1024;

/** Connection-local FIFO. A short write blocks until drain, including a zero-byte write. */
export class SocketWriter {
	#write: SocketWrite;
	#onError: (error: Error) => void;
	#limit: number;
	#queue: Uint8Array[] = [];
	#offset = 0;
	#queuedBytes = 0;
	#blocked = false;
	#error: Error | undefined;

	constructor(write: SocketWrite, onError: (error: Error) => void, maxQueuedBytes = MAX_SOCKET_QUEUE_BYTES) {
		this.#write = write;
		this.#onError = onError;
		this.#limit = maxQueuedBytes;
	}

	send(frame: string | Uint8Array): void {
		if (this.#error) throw this.#error;
		const bytes = typeof frame === "string" ? new TextEncoder().encode(frame) : frame.slice();
		if (bytes.byteLength > this.#limit - this.#queuedBytes) {
			const error = new Error("Socket transport backpressure limit exceeded");
			this.#fail(error);
			throw error;
		}
		if (bytes.byteLength === 0) return;
		this.#queue.push(bytes);
		this.#queuedBytes += bytes.byteLength;
		this.#pump();
		if (this.#error) throw this.#error;
	}

	/** Called only for this connection's drain event; never replay bytes on a replacement. */
	drain(): void {
		if (this.#error) return;
		this.#blocked = false;
		this.#pump();
	}

	/** Disconnection invalidates queued bytes without reporting an expected detach as a failure. */
	close(error = new Error("Socket transport connection closed")): void {
		if (this.#error) return;
		this.#error = error;
		this.#queue = [];
		this.#offset = 0;
		this.#queuedBytes = 0;
	}

	#fail(error: Error): void {
		if (this.#error) return;
		this.close(error);
		this.#onError(error);
	}

	#pump(): void {
		try {
			while (!this.#blocked && this.#queue.length > 0) {
				const frame = this.#queue[0]!;
				const suffix = frame.subarray(this.#offset);
				const result = this.#write(suffix);
				const written = typeof result === "boolean" ? suffix.byteLength : result;
				if (!Number.isInteger(written) || written < 0 || written > suffix.byteLength) {
					throw new Error(`Invalid socket write byte count: ${written}`);
				}
				this.#offset += written;
				this.#queuedBytes -= written;
				if (this.#offset === frame.byteLength) {
					this.#queue.shift();
					this.#offset = 0;
				}
				this.#blocked = result === false || written < suffix.byteLength;
			}
		} catch (error) {
			this.#fail(error instanceof Error ? error : new Error(String(error)));
		}
	}
}
