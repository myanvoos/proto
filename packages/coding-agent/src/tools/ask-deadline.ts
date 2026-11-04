import { untilAborted } from "@oh-my-pi/pi-utils";

/** One deadline for the outstanding form, including navigation and editors. */
export class AskDeadline {
	readonly #controller = new AbortController();
	readonly signal: AbortSignal;
	#timedOut = false;

	constructor(
		readonly timeoutMs: number,
		signal?: AbortSignal,
	) {
		this.signal = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
	}

	async run<T>(operation: () => Promise<T>): Promise<T | undefined> {
		let timer: NodeJS.Timeout | undefined;
		try {
			// Let a rich UI register its countdown first, so it can return confirmed partial answers.
			const pending = untilAborted(this.signal, operation);
			if (this.timeoutMs > 0) {
				timer = setTimeout(() => {
					this.#timedOut = true;
					this.#controller.abort();
				}, this.timeoutMs);
			}
			return await pending;
		} catch (error) {
			if (this.#timedOut) return undefined;
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
}
