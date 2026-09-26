import type { ReadableStreamDefaultReader } from "node:stream/web";

/** One credit permits one bounded chunk; callers cancel when the cell settles. */
export const KERNEL_INPUT_CHUNK_BYTES = 64 * 1024;

export class KernelInputReader {
	#reader?: ReadableStreamDefaultReader<Uint8Array>;
	#remainder?: Uint8Array;
	#closed = false;
	#reading = false;

	constructor(stream?: ReadableStream<Uint8Array>) {
		this.#reader = stream?.getReader();
	}

	async read(): Promise<Uint8Array | undefined> {
		if (this.#closed) return undefined;
		if (this.#reading) throw new Error("Kernel stdin received overlapping read credits");
		this.#reading = true;
		try {
			while (!this.#remainder?.byteLength) {
				const item = await this.#reader?.read();
				if (!item || item.done || this.#closed) return undefined;
				this.#remainder = item.value;
			}
			const chunk = this.#remainder.subarray(0, KERNEL_INPUT_CHUNK_BYTES);
			this.#remainder = this.#remainder.subarray(chunk.byteLength);
			return chunk;
		} finally {
			this.#reading = false;
		}
	}

	cancel(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#remainder = undefined;
		const reader = this.#reader;
		this.#reader = undefined;
		void reader
			?.cancel()
			.finally(() => reader.releaseLock())
			.catch(() => undefined);
	}
}
