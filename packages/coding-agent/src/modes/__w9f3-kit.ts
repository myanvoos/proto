import type { Component, RenderScheduler, Terminal } from "@oh-my-pi/pi-tui";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";

export class QueuedScheduler implements RenderScheduler {
	readonly #pending: Array<{ callback: () => void; cancelled: boolean; at: number }> = [];
	#now = 100;
	now(): number {
		return this.#now;
	}
	scheduleImmediate(callback: () => void): void {
		this.#pending.push({ callback, cancelled: false, at: this.#now });
	}
	scheduleRender(callback: () => void, delayMs = 0): { cancel(): void } {
		const entry = { callback, cancelled: false, at: this.#now + delayMs };
		this.#pending.push(entry);
		return { cancel: () => (entry.cancelled = true) };
	}
	async flush(): Promise<void> {
		let iterations = 0;
		while (this.#pending.length > 0) {
			if (++iterations > 10_000) throw new Error("render scheduler did not quiesce");
			await Promise.resolve();
			await Promise.resolve();
			this.#pending.sort((a, b) => a.at - b.at);
			const entry = this.#pending.shift()!;
			this.#now = Math.max(this.#now, entry.at);
			if (!entry.cancelled) entry.callback();
		}
		await Promise.resolve();
		await Promise.resolve();
	}
}

export class VTermSink implements Terminal {
	readonly vt: VTermTerminal;
	#onResize: (() => void) | undefined;
	constructor(
		public columns: number,
		public rows: number,
	) {
		this.vt = new VTermTerminal({ cols: columns, rows, scrollback: 50_000 });
	}
	get pendingOutputBytes(): number {
		return 0;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	get kittyEnableSequence(): string | null {
		return null;
	}
	get appearance(): undefined {
		return undefined;
	}
	start(_onInput: (data: string) => void, onResize: () => void): void {
		this.#onResize = onResize;
	}
	enableInput(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.vt.write(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
	/** Real terminals answer CPR; the anchor probe depends on it. */
	async queryCursorPosition(): Promise<{ row: number; col: number } | undefined> {
		return { row: this.vt.buffer.normal.cursorY, col: this.vt.buffer.normal.cursorX };
	}
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.vt.resize(columns, rows);
		this.#onResize?.();
	}
	tape(): string[] {
		const lines = this.vt.buffer.normal;
		const rows = Array.from({ length: lines.length }, (_value, row) =>
			Bun.stripANSI(lines.getLine(row)?.translateToString(true).trimEnd() ?? ""),
		);
		while (rows.at(-1) === "") rows.pop();
		return rows;
	}
}

/** A block that grows while streaming and freezes when finalized. */
export class StreamingBlock implements Component {
	#rows: string[] = [];
	#final = false;
	constructor(readonly name: string) {}
	push(row: string): void {
		this.#rows.push(row);
	}
	finalize(): void {
		this.#final = true;
	}
	render(): readonly string[] {
		return this.#rows;
	}
	invalidate(): void {}
	isTranscriptBlockFinalized(): boolean {
		return this.#final;
	}
}
