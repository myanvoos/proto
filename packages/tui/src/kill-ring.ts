import { materializeString } from "@oh-my-pi/pi-utils/materialize-string";

export const KILL_RING_MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 60;

export class KillRing {
	#ring: string[] = [];
	#bytes = 0;

	/** Oversize kills remain deleted but are not retained for yank. */
	push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
		if (!text) return;
		const bytes = Buffer.byteLength(text);
		if (bytes > KILL_RING_MAX_BYTES) return;
		const last = opts.accumulate ? this.#ring.at(-1) : undefined;
		if (last !== undefined && Buffer.byteLength(last) + bytes <= KILL_RING_MAX_BYTES) {
			this.#ring[this.#ring.length - 1] = materializeString(opts.prepend ? text + last : last + text);
		} else {
			this.#ring.push(materializeString(text));
		}
		this.#bytes += bytes;
		while (this.#ring.length > MAX_ENTRIES || this.#bytes > KILL_RING_MAX_BYTES) {
			this.#bytes -= Buffer.byteLength(this.#ring.shift()!);
		}
	}

	clear(): void {
		this.#ring = [];
		this.#bytes = 0;
	}

	peek(): string | undefined {
		return this.#ring.at(-1);
	}

	rotate(): void {
		if (this.#ring.length > 1) {
			const last = this.#ring.pop()!;
			this.#ring.unshift(last);
		}
	}

	get length(): number {
		return this.#ring.length;
	}
}
