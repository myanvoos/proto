import * as AIError from "../error";
import type { AssistantMessage, AssistantMessageEvent } from "../types";

export interface LocalWorkSource {
	readonly hasPendingLocalWork: boolean;
}

type EventWaiter<T> = {
	resolve: (value: IteratorResult<T>) => void;
	reject: (err: unknown) => void;
};

export class EventStream<T, R = T> implements AsyncIterable<T> {
	queue: T[] = [];
	waiting: EventWaiter<T>[] = [];
	done = false;

	#queueHead = 0;
	#waitingHead = 0;
	#bufferEvents = true;

	resultSettled = false;
	#failed = false;
	#error: unknown = undefined;

	#pendingLocalWork = 0;

	#localWorkDelegate: LocalWorkSource | undefined;
	finalResultPromise: Promise<R>;
	resolveFinalResult!: (result: R) => void;
	rejectFinalResult!: (err: unknown) => void;
	isComplete: (event: T) => boolean;
	extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		const { promise, resolve, reject } = Promise.withResolvers<R>();

		promise.catch(() => {});
		this.finalResultPromise = promise;
		this.resolveFinalResult = resolve;
		this.rejectFinalResult = reject;
		this.isComplete = isComplete;
		this.extractResult = extractResult;
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resultSettled = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		this.deliver(event);
	}

	deliver(event: T): void {
		const waiter = this.#takeWaiter();
		if (waiter) {
			waiter.resolve({ value: event, done: false });
		} else if (this.#bufferEvents) {
			this.queue.push(event);
		}
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resultSettled = true;
			this.resolveFinalResult(result);
		} else if (!this.resultSettled) {
			this.resultSettled = true;
			this.rejectFinalResult(
				new AIError.ProviderResponseError("Stream ended without a final result", { kind: "envelope" }),
			);
		}

		this.endWaiting();
	}

	endWaiting(): void {
		for (let index = this.#waitingHead; index < this.waiting.length; index++) {
			this.waiting[index]!.resolve({ value: undefined, done: true });
		}
		this.waiting.length = 0;
		this.#waitingHead = 0;
	}

	fail(err: unknown): void {
		if (this.done) return;
		this.done = true;
		this.#failed = true;
		this.#error = err;
		this.resultSettled = true;
		this.rejectFinalResult(err);
		for (let index = this.#waitingHead; index < this.waiting.length; index++) {
			this.waiting[index]!.reject(err);
		}
		this.waiting.length = 0;
		this.#waitingHead = 0;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.#hasQueuedEvents()) {
				yield this.#takeQueuedEvent();
			} else if (this.#failed) {
				throw this.#error;
			} else if (this.done) {
				return;
			} else {
				const { promise, resolve, reject } = Promise.withResolvers<IteratorResult<T>>();
				this.waiting.push({ resolve, reject });
				const result = await promise;
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}

	/** Drops queued and future events; use only when the caller will not iterate the stream. */
	resultOnly(): Promise<R> {
		this.#bufferEvents = false;
		this.queue.length = 0;
		this.#queueHead = 0;
		return this.finalResultPromise;
	}

	#hasQueuedEvents(): boolean {
		if (this.#queueHead < this.queue.length) return true;
		if (this.#queueHead > 0) {
			this.queue.length = 0;
			this.#queueHead = 0;
		}
		return false;
	}

	#takeQueuedEvent(): T {
		const event = this.queue[this.#queueHead++]!;
		if (this.#queueHead === this.queue.length) {
			this.queue.length = 0;
			this.#queueHead = 0;
		} else if (this.#queueHead >= 1_024 && this.#queueHead * 2 >= this.queue.length) {
			this.queue.splice(0, this.#queueHead);
			this.#queueHead = 0;
		}
		return event;
	}

	#takeWaiter(): EventWaiter<T> | undefined {
		if (this.#waitingHead >= this.waiting.length) {
			if (this.#waitingHead > 0) {
				this.waiting.length = 0;
				this.#waitingHead = 0;
			}
			return undefined;
		}

		const waiter = this.waiting[this.#waitingHead++];
		if (this.#waitingHead === this.waiting.length) {
			this.waiting.length = 0;
			this.#waitingHead = 0;
		} else if (this.#waitingHead >= 1_024 && this.#waitingHead * 2 >= this.waiting.length) {
			this.waiting.splice(0, this.#waitingHead);
			this.#waitingHead = 0;
		}
		return waiter;
	}

	get hasPendingLocalWork(): boolean {
		return this.#pendingLocalWork > 0 || (this.#localWorkDelegate?.hasPendingLocalWork ?? false);
	}

	forwardLocalWorkFrom(source: LocalWorkSource | undefined): void {
		this.#localWorkDelegate = source;
	}

	async trackLocalWork<TWork>(work: Promise<TWork>): Promise<TWork> {
		this.#pendingLocalWork++;
		try {
			return await work;
		} finally {
			this.#pendingLocalWork--;
		}
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			event => event.type === "done" || event.type === "error",
			event => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new AIError.ProviderResponseError("Unexpected event type for final result", { kind: "envelope" });
			},
		);
	}

	override push(event: AssistantMessageEvent): void {
		if (this.done) return;

		if (event.type === "error" && event.error.stopReason === "error") {
			AIError.classifyMessage(event.error);
		}

		if (this.isComplete(event)) {
			this.done = true;
			this.resultSettled = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		this.deliver(event);
	}

	override end(result?: AssistantMessage): void {
		this.done = true;
		if (result !== undefined) {
			if (result.stopReason === "error") {
				AIError.classifyMessage(result);
			}
			this.resultSettled = true;
			this.resolveFinalResult(result);
		} else if (!this.resultSettled) {
			this.resultSettled = true;
			this.rejectFinalResult(
				new AIError.ProviderResponseError("Stream ended without a final result", { kind: "envelope" }),
			);
		}
		this.endWaiting();
	}
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
