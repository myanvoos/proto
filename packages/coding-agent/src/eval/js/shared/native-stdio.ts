import { KernelStdio } from "@oh-my-pi/pi-natives";

/** The native pump forwards bytes on its reserved pipe, independently of the JS event loop. */
export class NativeStdio {
	readonly console = globalThis.console;
	#capture = new KernelStdio();
	#methods = new Map<string, PropertyDescriptor>();
	#activeRun: string | undefined;
	sequence = 0;

	constructor(readonly owner: () => string | undefined) {
		for (const name of Object.getOwnPropertyNames(this.console)) {
			const descriptor = Object.getOwnPropertyDescriptor(this.console, name)!;
			if (name === "Console" || name.startsWith("_") || typeof descriptor.value !== "function") continue;
			const original = descriptor.value as (...args: unknown[]) => unknown;
			this.#methods.set(name, descriptor);
			Object.defineProperty(this.console, name, {
				...descriptor,
				value: (...args: unknown[]) => this.route(() => Reflect.apply(original, this.console, args)),
			});
		}
	}

	start(runId: string): void {
		this.#capture.start(runId);
		this.#activeRun = runId;
	}

	/** Late retained callbacks get their original run's pipe, never the next cell's output. */
	route<T>(invoke: () => T): T {
		const owner = this.owner();
		if (!owner) return invoke();
		const nested = owner !== this.#activeRun;
		if (nested) this.#capture.start(owner);
		try {
			return invoke();
		} finally {
			this.sequence = nested ? this.#capture.finish() : this.#capture.flush();
		}
	}

	write(
		stream: "stdout" | "stderr",
		invoke: () => boolean,
		chunk: unknown,
		encoding?: unknown,
		callback?: unknown,
	): boolean {
		const owner = this.owner();
		if (!owner || (typeof Bun === "undefined" && owner === this.#activeRun)) return this.route(invoke);
		// Bun caches its FileSink before fd capture, so writes use the native pipe explicitly.
		// Retained Node callbacks also cannot queue a libuv write against the next cell's fd.
		// The pipe is bounded and synchronous; write callbacks retain next-tick scheduling.
		if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) return invoke();
		const bytes =
			typeof chunk === "string"
				? Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : undefined)
				: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		this.sequence = this.#capture.write(owner, stream, bytes);
		const cb = typeof encoding === "function" ? encoding : callback;
		if (typeof cb === "function") process.nextTick(cb as () => void);
		return true;
	}

	finish(): void {
		if (this.#activeRun === undefined) return;
		try {
			this.sequence = this.#capture.finish();
		} finally {
			this.#activeRun = undefined;
		}
	}

	dispose(): void {
		for (const [name, descriptor] of this.#methods) Object.defineProperty(this.console, name, descriptor);
		this.#methods.clear();
		this.#capture.close();
	}
}
