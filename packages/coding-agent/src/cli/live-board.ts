import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";

const RENDER_INTERVAL_MS = 80;

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface LiveBoardOutput {
	isTTY?: boolean;
	columns?: number;
	rows?: number;
	write(text: string): boolean;
}

interface LiveBoard {
	readonly interactive: boolean;

	log(text: string): void;

	repaint(): void;

	close(): void;
}

export function createLiveBoard(
	render: (spinner: string, width: number) => string[],
	output: LiveBoardOutput = process.stdout,
): LiveBoard {
	const interactive = output.isTTY === true;
	let frame = 0;
	let lineCount = 0;
	let cursorHidden = false;
	let closed = false;
	let timer: NodeJS.Timeout | undefined;

	const dimensions = (): { width: number; maxRows: number } => {
		const columns = output.columns ?? 0;
		const rows = output.rows ?? 0;
		return {
			width: Number.isFinite(columns) && columns > 0 ? Math.trunc(columns) : 80,
			maxRows: Math.max(4, (Number.isFinite(rows) && rows > 0 ? Math.trunc(rows) : 24) - 2),
		};
	};

	const paint = (lines: string[]): void => {
		if (lines.length === 0 && lineCount === 0) return;
		const { width } = dimensions();
		let out = lineCount > 0 ? `\x1b[${lineCount}A` : "";
		out += "\r";
		if (lines.length > 0) {
			out += `${lines.map(line => `\x1b[2K${truncateToWidth(replaceTabs(line), width)}`).join("\r\n")}\r\n`;
		}
		out += "\x1b[0J";
		if (lines.length > 0 && !cursorHidden) {
			out += "\x1b[?25l";
			cursorHidden = true;
		} else if (lines.length === 0 && cursorHidden) {
			out += "\x1b[?25h";
			cursorHidden = false;
		}
		output.write(out);
		lineCount = lines.length;
	};

	const repaint = (): void => {
		if (!interactive || closed) return;
		const { width, maxRows } = dimensions();
		const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "*";
		let lines = render(spinner, width);
		if (lines.length > maxRows) {
			lines = [...lines.slice(0, maxRows - 1), `… +${lines.length - (maxRows - 1)} more`];
		}
		paint(lines);
	};

	if (interactive) {
		timer = setInterval(() => {
			frame += 1;
			repaint();
		}, RENDER_INTERVAL_MS);
		timer.unref?.();
	}

	return {
		interactive,
		log(text) {
			if (closed || !interactive) {
				output.write(`${text}\n`);
				return;
			}
			paint([]);
			output.write(`${text}\n`);
			repaint();
		},
		repaint,
		close() {
			if (closed) return;
			closed = true;
			if (!interactive) return;
			clearInterval(timer);
			paint([]);
		},
	};
}
