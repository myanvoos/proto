import { minFrameIntervalMs } from "../frame-rate";
import {
	onSpinnerIntervalChange,
	STATIC_SPINNER_GLYPH,
	sharedSpinnerFrame,
	spinnerAnimated,
	spinnerInterval,
	spinnerTickDelay,
} from "../spinner-clock";
import type { TUI } from "../tui";
import { getPaddingX, sliceByColumn, visibleWidth } from "../utils";
import { Text } from "./text";

const DEFAULT_SPINNER_FRAMES = [STATIC_SPINNER_GLYPH, "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RENDER_INTERVAL_MS = 1000 / 30;
/** Repaint cadence of a static-spinner row, so a dynamic label (countdown, elapsed) still moves. */
const STATIC_REFRESH_MS = 1000;
const RENDER_BACKPRESSURE_MULTIPLIER = 9;
// One pathological frame (a multi-second stall) must not freeze the spinner
// for nine times as long; bound the cost that feeds the duty-cycle multiplier.
const MAX_BACKPRESSURE_FRAME_COST_MS = 200;

type ColorFn = (str: string) => string;

export type LoaderMessageColorFn = ColorFn & {
	readonly animated?: true;
};

export class Loader extends Text {
	#frames = DEFAULT_SPINNER_FRAMES;
	#currentFrame = 0;
	#intervalId?: NodeJS.Timeout;
	#unsubscribeSpinnerInterval?: () => void;
	#ui: TUI | null = null;
	#lastSpinnerTick = 0;
	#layoutSource?: readonly string[];
	#layout?: readonly { leading: string; content: string; trailing: string }[];
	#layoutFrames: readonly string[] = [];
	#layoutFrame = "";

	constructor(
		ui: TUI,
		private spinnerColorFn: ColorFn,
		private messageColorFn: LoaderMessageColorFn,
		private message: string | (() => string) = "Loading...",
		spinnerFrames?: string[],
	) {
		super("", 1, 0);
		this.#ui = ui;
		if (spinnerFrames && spinnerFrames.length > 0) {
			this.#frames = spinnerFrames;
		}
		this.#applyFrames();
		this.start();
	}

	setSpinnerFrames(frames: string[]) {
		if (frames.length === 0 || frames === this.#frames) {
			return;
		}
		this.#frames = frames;
		this.#applyFrames();
		this.#currentFrame %= this.#frames.length;
		this.#syncText();
		this.#requestPaint();
	}

	#applyFrames() {
		const representatives = new Map<number, string>();
		this.#layoutFrames = this.#frames.map(frame => {
			const width = visibleWidth(frame);
			const representative = representatives.get(width);
			if (representative !== undefined) {
				return representative;
			}
			representatives.set(width, frame);
			return frame;
		});
	}

	override render(width: number): readonly string[] {
		const source = super.render(width);
		if (source !== this.#layoutSource) {
			// Match Text's width-dependent margin degradation so the split never
			// consumes a visible cell on narrow terminals.
			const paddingX = Math.min(getPaddingX(1), Math.floor(Math.max(0, width - 1) / 2));
			this.#layoutSource = source;
			this.#layout = source.map(line => {
				const clamped = visibleWidth(line) > width ? sliceByColumn(line, 0, width, true) : line;
				const body = clamped.slice(paddingX);
				const content = body.trimEnd();
				return {
					leading: clamped.slice(0, paddingX),
					content,
					trailing: body.slice(content.length),
				};
			});
		}

		const frame = this.#frames[this.#currentFrame];

		const sentinel = this.#layoutFrame;
		const lines = [""];
		const layout = this.#layout ?? [];
		for (let i = 0; i < layout.length; i++) {
			const { leading, content, trailing } = layout[i];
			if (i === 0 && content.startsWith(sentinel)) {
				const remainder = content.slice(sentinel.length);
				const separator = remainder.startsWith(" ") ? " " : "";
				const message = remainder.slice(separator.length);
				lines.push(
					`${leading}${this.spinnerColorFn(frame)}${separator}${message ? this.messageColorFn(message) : ""}${trailing}`,
				);
			} else {
				lines.push(`${leading}${content ? this.messageColorFn(content) : ""}${trailing}`);
			}
		}
		return lines;
	}

	start() {
		this.#takeSharedFrame(performance.now());
		this.#syncText();
		this.#requestPaint();
		this.#unsubscribeSpinnerInterval ??= onSpinnerIntervalChange(this.#onSpinnerIntervalChange);
		this.#scheduleTick(spinnerTickDelay(this.#tickIntervalMs()));
	}

	/**
	 * Show the glyph the shared spinner clock holds at `now` (frame 0 when static) and remember the
	 * clock boundary it belongs to, so every spinner on screen shows the same glyph and this one
	 * advances when the clock does, not on a cadence of its own.
	 */
	#takeSharedFrame(now: number): void {
		if (spinnerAnimated()) {
			const intervalMs = spinnerInterval();
			this.#currentFrame = sharedSpinnerFrame(this.#frames.length, now);
			this.#lastSpinnerTick = now - (now % intervalMs);
		} else {
			this.#currentFrame = 0;
			this.#lastSpinnerTick = now;
		}
	}

	/**
	 * A live `tui.spinnerInterval` change takes effect at once: a spinner going static pins frame 0,
	 * and the next tick lands on the new cadence's boundary, so a static → animated switch does not
	 * wait out the old one-second refresh and an animated → static one does not keep ticking at the
	 * old rate.
	 */
	#onSpinnerIntervalChange = (): void => {
		if (!this.#intervalId) return;
		clearTimeout(this.#intervalId);
		this.#takeSharedFrame(performance.now());
		this.#syncText();
		this.#requestPaint();
		this.#scheduleTick(spinnerTickDelay(this.#tickIntervalMs()));
	};

	/**
	 * Tick cadence: shimmer drives a 30 Hz repaint; otherwise the row changes when the glyph advances
	 * on the shared spinner clock, or — with a static spinner — once a second for its dynamic label.
	 * Never faster than a frame can land under the `tui.maxFps` ceiling: a tick that cannot paint is
	 * pure CPU.
	 */
	#tickIntervalMs(): number {
		const base =
			this.messageColorFn.animated === true
				? RENDER_INTERVAL_MS
				: spinnerAnimated()
					? spinnerInterval()
					: STATIC_REFRESH_MS;
		return Math.max(base, minFrameIntervalMs());
	}

	stop() {
		this.#unsubscribeSpinnerInterval?.();
		this.#unsubscribeSpinnerInterval = undefined;
		if (this.#intervalId) {
			clearTimeout(this.#intervalId);
			this.#intervalId = undefined;
		}
	}

	dispose() {
		this.stop();
	}

	setMessage(message: string) {
		if (message === this.message) {
			return;
		}
		this.message = message;
		this.#syncText();
		this.#requestPaint();
	}

	/**
	 * Ticks land on the shared spinner clock's boundaries (see {@link spinnerTickDelay}), so this row
	 * and every live tool card repaint in the same frame; backpressure may hold a tick past a
	 * boundary, after which the next one realigns.
	 */
	#scheduleTick(delayMs: number): void {
		const timer = setTimeout(() => {
			if (this.#intervalId !== timer) return;
			const startedAt = performance.now();
			// Read the live cadence each tick so a setting change takes effect without a restart.
			const animated = spinnerAnimated();
			// A tick that crossed a clock boundary shows the clock's glyph (a held tick may cross several).
			const shouldAdvanceSpinner = animated && startedAt - this.#lastSpinnerTick >= spinnerInterval();
			if (shouldAdvanceSpinner) {
				this.#takeSharedFrame(startedAt);
				this.#syncText();
			} else if (!animated) {
				// Static glyph (frame 0): only a dynamic message can change, and it is re-read here.
				this.#currentFrame = 0;
				this.#syncText();
			}
			if (shouldAdvanceSpinner || !animated || this.#ui?.synchronizedOutput === true) {
				this.#requestPaint();
			}

			// requestComponentRender() only enqueues: the compose/write cost lands on
			// the TUI's completed frame, so pace on whichever is larger.
			const completedFrameCostMs = this.#ui?.lastFrameCostMs ?? 0;
			const now = performance.now();
			const requestCostMs = now - startedAt;
			if (this.#intervalId !== timer) return;
			// Re-derive the cadence: a setting change mid-run moves the next tick, not just the next start.
			const cadenceDelayMs = spinnerTickDelay(this.#tickIntervalMs(), now);
			// Idle for nine times the frame cost to keep animation at or below 10% CPU.
			const boundedFrameCostMs = Math.min(
				MAX_BACKPRESSURE_FRAME_COST_MS,
				Math.max(completedFrameCostMs, requestCostMs),
			);
			const backpressureDelayMs = boundedFrameCostMs * RENDER_BACKPRESSURE_MULTIPLIER;
			this.#scheduleTick(Math.max(cadenceDelayMs, backpressureDelayMs));
		}, delayMs);
		// A spinner tick must never keep the process alive on its own.
		timer.unref?.();
		this.#intervalId = timer;
	}

	#resolveMessage(): string {
		return typeof this.message === "function" ? this.message() : this.message;
	}

	/** Re-wrap the underlying Text only when its message or frame width changes.
	 * A function message is re-evaluated on every spinner tick, so a dynamic
	 * label (a live countdown) advances with the glyph instead of freezing. */
	#syncText(): boolean {
		const layoutFrame = this.#layoutFrames[this.#currentFrame];
		this.#layoutFrame = layoutFrame;
		return this.setText(`${layoutFrame} ${this.#resolveMessage()}`);
	}

	#requestPaint() {
		if (!this.#ui) {
			return;
		}

		this.#ui.requestComponentRender(this);
	}
}
