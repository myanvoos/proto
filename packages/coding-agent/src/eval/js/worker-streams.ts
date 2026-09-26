import { Readable } from "node:stream";
import { KERNEL_INPUT_CHUNK_BYTES } from "../kernel-streams";
import type { Transport } from "./worker-protocol";

export class WorkerInput extends Readable {
	#requested = false;
	constructor(
		readonly runId: string,
		readonly transport: Transport,
		enabled: boolean,
	) {
		super({ highWaterMark: KERNEL_INPUT_CHUNK_BYTES });
		if (!enabled) this.push(null);
	}
	override _read(): void {
		if (this.#requested || this.destroyed) return;
		this.#requested = true;
		this.transport.send({ type: "stdin-request", runId: this.runId });
	}
	feed(data: string, eof: boolean): void {
		if (this.destroyed) return;
		if (!this.#requested || data.length > Math.ceil(KERNEL_INPUT_CHUNK_BYTES / 3) * 4) {
			this.destroy(new Error("Invalid kernel stdin credit"));
			return;
		}
		const bytes = Buffer.from(data, "base64");
		if (bytes.length > KERNEL_INPUT_CHUNK_BYTES || (!eof && bytes.length === 0)) {
			this.destroy(new Error("Invalid kernel stdin chunk"));
			return;
		}
		this.#requested = false;
		if (bytes.length) this.push(bytes);
		if (eof) this.push(null);
	}
}

/** Stop-and-wait frames bound IPC independently of a consumer's read speed.
 * Writers honoring write(false)/drain never fill the bounded noncooperative queue.
 */
export class WorkerOutput {
	#pending = Promise.resolve();
	#bytes = 0;
	#writes = 0;
	#error?: Error;
	constructor(readonly send: (chunk: string | Uint8Array, stream: "stdout" | "stderr") => Promise<void>) {}

	write(chunk: string | Uint8Array, stream: "stdout" | "stderr" = "stdout"): Promise<void> {
		if (this.#error) throw this.#error;
		const size = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
		if (this.#bytes + size > 32 * 1024 * 1024 || this.#writes >= 4096) {
			throw new Error("Kernel output exceeded pending budget (32 MiB or 4096 writes); await stdout drain");
		}
		this.#bytes += size;
		this.#writes++;
		const previous = this.#pending;
		const write = async (): Promise<void> => {
			try {
				await previous;
				if (this.#error) throw this.#error;
				const length = typeof chunk === "string" ? chunk.length : chunk.byteLength;
				const step = typeof chunk === "string" ? KERNEL_INPUT_CHUNK_BYTES / 4 : KERNEL_INPUT_CHUNK_BYTES;
				for (let offset = 0; offset < length; ) {
					let end = Math.min(offset + step, length);
					if (typeof chunk === "string" && end < length) {
						const last = chunk.charCodeAt(end - 1);
						if (last >= 0xd800 && last <= 0xdbff) end--;
					}
					await this.send(
						typeof chunk === "string" ? chunk.slice(offset, end) : chunk.subarray(offset, end),
						stream,
					);
					offset = end;
				}
			} catch (error) {
				this.#error = error instanceof Error ? error : new Error(String(error));
			} finally {
				this.#bytes -= size;
				this.#writes--;
			}
		};
		this.#pending = write();
		return this.#pending;
	}
	backpressured(): boolean {
		return this.#bytes >= KERNEL_INPUT_CHUNK_BYTES;
	}

	async flush(): Promise<void> {
		await this.#pending;
		if (this.#error) throw this.#error;
	}
}
