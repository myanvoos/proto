import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { deliverMessages } from "../message-delivery";
import type { InteractiveModeContext } from "../types";

/**
 * Longest single timer arm. Due times are absolute wall-clock instants and every tick recomputes the
 * remaining delay, so chunked re-arming survives suspend/resume drift and the 2^31 ms setTimeout
 * ceiling, and it refreshes the countdown rendered above the editor.
 */
const TIMER_CHUNK_MS = 60_000;

export interface ScheduledQueueEntry {
	id: number;

	messages: string[];

	images?: ImageContent[];

	imageLinks?: (string | undefined)[];

	dueAtMs: number;
}

/**
 * Timed half of `/queue`. Each `/queue <duration> <message>` records an independent absolute
 * deadline, so successive `/queue 3h …` and `/queue 18h …` fire 3 and 18 hours from when each was
 * entered rather than chaining. Entries live as long as the TUI does; they are not persisted.
 */
export class ScheduledQueueController {
	readonly #entries: ScheduledQueueEntry[] = [];
	#timer: NodeJS.Timeout | undefined;
	#nextId = 1;

	constructor(private readonly ctx: InteractiveModeContext) {}

	/** Pending entries in delivery order; positions here are what `/queue --cancel <n>` takes. */
	list(): readonly ScheduledQueueEntry[] {
		return this.#entries;
	}

	schedule(
		delayMs: number,
		messages: readonly string[],
		options: { images?: ImageContent[]; imageLinks?: (string | undefined)[] } = {},
	): ScheduledQueueEntry {
		const entry: ScheduledQueueEntry = {
			id: this.#nextId++,
			messages: [...messages],
			images: options.images?.length ? [...options.images] : undefined,
			imageLinks: options.imageLinks ? [...options.imageLinks] : undefined,
			dueAtMs: Date.now() + delayMs,
		};
		this.#entries.push(entry);
		this.#entries.sort((a, b) => a.dueAtMs - b.dueAtMs || a.id - b.id);
		this.#arm();
		return entry;
	}

	/** Cancels the 1-based entry as listed by {@link list}. */
	cancel(position: number): ScheduledQueueEntry | undefined {
		if (position < 1 || position > this.#entries.length) return undefined;
		const [removed] = this.#entries.splice(position - 1, 1);
		this.#arm();
		return removed;
	}

	cancelAll(): number {
		const count = this.#entries.length;
		this.#entries.length = 0;
		this.#arm();
		return count;
	}

	dispose(): void {
		this.#entries.length = 0;
		this.#clearTimer();
	}

	#clearTimer(): void {
		if (!this.#timer) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#arm(): void {
		this.#clearTimer();
		const next = this.#entries[0];
		if (!next) return;
		const delay = Math.min(TIMER_CHUNK_MS, Math.max(0, next.dueAtMs - Date.now()));
		this.#timer = setTimeout(() => this.#onTick(), delay);
	}

	#onTick(): void {
		this.#timer = undefined;
		const now = Date.now();
		const due: ScheduledQueueEntry[] = [];
		while (this.#entries.length > 0 && (this.#entries[0]?.dueAtMs ?? Number.POSITIVE_INFINITY) <= now) {
			const next = this.#entries.shift();
			if (next) due.push(next);
		}
		this.#arm();
		if (due.length === 0) {
			// Chunked re-arm tick: nothing due, just refresh the rendered countdown.
			this.ctx.updatePendingMessagesDisplay();
			return;
		}
		void this.#deliverDue(due);
	}

	async #deliverDue(due: readonly ScheduledQueueEntry[]): Promise<void> {
		for (const entry of due) {
			const result = await deliverMessages(this.ctx, entry.messages, {
				images: entry.images,
				imageLinks: entry.imageLinks,
				preserveDraft: true,
			});
			if (result.error) {
				const detail = result.error instanceof Error ? result.error.message : String(result.error);
				logger.error("Scheduled queue delivery failed", { detail, delivered: result.delivered });
				this.ctx.showError(`Scheduled message failed to send: ${detail}`);
				continue;
			}
			this.ctx.showStatus(
				result.outcome === "compaction"
					? "Scheduled message queued for after compaction"
					: result.outcome === "sent"
						? "Sent scheduled message"
						: "Scheduled message queued for when the agent yields",
			);
		}
		this.ctx.updatePendingMessagesDisplay();
		this.ctx.ui.requestRender();
	}
}
