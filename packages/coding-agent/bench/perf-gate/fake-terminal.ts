import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui";

/**
 * Headless Terminal implementation: records every write with a timestamp so
 * echo/render latency can be measured as time-from-feed to next paint.
 */
export class FakeTerminal implements Terminal {
	columns = 100;
	rows = 40;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	keyboardEnhancementEnterSequence: string | null = null;
	keyboardEnhancementExitSequence: string | null = null;
	appearance: TerminalAppearance | undefined = "dark";
	pendingOutputBytes = 0;

	bytesWritten = 0;
	frames = 0;
	lastWriteNs = 0n;
	writeTimesNs: bigint[] = [];
	#onInput?: (data: string) => void;
	#onResize?: () => void;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#onInput = onInput;
		this.#onResize = onResize;
	}

	enableInput(): void {}

	stop(): void {}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(data: string): void {
		this.bytesWritten += data.length;
		this.frames++;
		this.lastWriteNs = Bun.nanoseconds();
		if (this.writeTimesNs.length < 5_000_000) this.writeTimesNs.push(this.lastWriteNs);
	}

	feed(data: string): void {
		this.#onInput?.(data);
	}

	resize(cols: number, rows: number): void {
		this.columns = cols;
		this.rows = rows;
		this.#onResize?.();
	}

	moveBy(_lines: number): void {}
	hideCursor(_force?: boolean): void {}
	showCursor(_force?: boolean): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	onAppearanceChange(_cb: (appearance: TerminalAppearance, token?: number) => void): void {}
}
