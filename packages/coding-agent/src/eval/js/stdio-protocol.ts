import { deserialize, serialize } from "bun:jsc";

// Versioned structured-clone frames preserve Uint8Array/ArrayBuffer and rich tool replies.
export const JS_KERNEL_STDIO_VERSION = 1;
export const MAX_JS_KERNEL_WIRE_BYTES = 48 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

export function encodeJsKernelFrame(value: unknown): string {
	const bytes = serialize(value, { binaryType: "nodebuffer" });
	if (bytes.byteLength > MAX_PAYLOAD_BYTES) throw new Error("JS kernel transport frame exceeds 32 MiB");
	return `${JSON.stringify({ version: JS_KERNEL_STDIO_VERSION, bun: Bun.version, data: bytes.toString("base64") })}\n`;
}

export function decodeJsKernelFrame(line: Uint8Array): unknown {
	if (line.byteLength > MAX_JS_KERNEL_WIRE_BYTES) throw new Error("JS kernel transport frame exceeds wire limit");
	const envelope = JSON.parse(new TextDecoder().decode(line)) as { version?: unknown; bun?: unknown; data?: unknown };
	if (envelope.version !== JS_KERNEL_STDIO_VERSION || envelope.bun !== Bun.version) {
		throw new Error(
			`Incompatible remote proto kernel transport (protocol ${String(envelope.version)}, Bun ${String(envelope.bun)}; expected protocol ${JS_KERNEL_STDIO_VERSION}, Bun ${Bun.version}). Install a compatible proto host explicitly.`,
		);
	}
	if (
		typeof envelope.data !== "string" ||
		envelope.data.length > Math.ceil(MAX_PAYLOAD_BYTES / 3) * 4 ||
		!/^[A-Za-z0-9+/]*={0,2}$/u.test(envelope.data)
	)
		throw new Error("Invalid JS kernel transport payload");
	const bytes = Buffer.from(envelope.data, "base64");
	if (bytes.byteLength > MAX_PAYLOAD_BYTES) throw new Error("JS kernel transport frame exceeds 32 MiB");
	return deserialize(bytes) as unknown;
}

/** Bounded FIFO with real sink backpressure; overflow fails the owning transport instead of silently dropping frames. */
export class JsKernelFrameWriter {
	#sink: Bun.FileSink;
	#pending: Promise<void> = Promise.resolve();
	#queuedBytes = 0;
	#error?: Error;
	#onError: (error: Error) => void;

	constructor(sink: Bun.FileSink, onError: (error: Error) => void) {
		this.#sink = sink;
		this.#onError = onError;
	}

	send(value: unknown): void {
		if (this.#error) throw this.#error;
		const frame = encodeJsKernelFrame(value);
		if (this.#queuedBytes + frame.length > 64 * 1024 * 1024)
			throw new Error("JS kernel transport backpressure limit exceeded");
		this.#queuedBytes += frame.length;
		this.#pending = this.#pending
			.then(async () => {
				if (this.#error) return;
				this.#sink.write(frame);
				await this.#sink.flush();
			})
			.catch(error => {
				this.#error = error instanceof Error ? error : new Error(String(error));
				this.#onError(this.#error);
			})
			.finally(() => {
				this.#queuedBytes -= frame.length;
			});
	}

	async flush(): Promise<void> {
		await this.#pending;
		if (this.#error) throw this.#error;
	}
}
