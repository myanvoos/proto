import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	matchesKey,
	type OverlayFocusOwner,
	type OverlayHandle,
	type OverlayOptions,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { formatDuration } from "../../slash-commands/helpers/format";
import { theme } from "../theme/theme";
import { matchesAppInterrupt } from "../utils/keybinding-matchers";

export interface PauseScreenHost {
	ui: {
		showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
		setFocus(component: Component): void;
		requestRender(): void;
		readonly terminal: { readonly rows: number };
	};
	showStatus(message: string, options?: { dim?: boolean }): void;
	readonly sessionName?: string;
}

const TICK_MS = 1_000;

const BAR_ROWS = 7;
const BAR_WIDTH = 5;
const BAR_GAP = 4;

const MIN_FULL_WIDTH = 64;
const MIN_FULL_HEIGHT = 18;

const TITLE = "P A U S E D";
const BODY_LINES = [
	"Main agent, subagents, and advisor hold at their next step.",
	"In-flight calls finish; nothing new starts until you resume.",
] as const;
const RESUME_HINT = "esc · enter · space — resume";

function centerLine(line: string, width: number): string {
	const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
	return pad > 0 ? " ".repeat(pad) + line : line;
}

function formatClock(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function renderPauseScreen(width: number, height: number, elapsedMs: number, sessionName?: string): string[] {
	const compact = width < MIN_FULL_WIDTH || height < MIN_FULL_HEIGHT;
	const content: string[] = [];

	if (compact) {
		if (sessionName) {
			content.push(centerLine(theme.bold(sessionName), width));
			content.push("");
		}
		content.push(centerLine(theme.bold(theme.fg("accent", `▌▌ ${TITLE}`)), width));
		content.push("");
		content.push(centerLine(theme.fg("dim", `paused for ${formatClock(elapsedMs)}`), width));
		content.push(centerLine(theme.fg("dim", "esc to resume"), width));
	} else {
		if (sessionName) {
			content.push(centerLine(theme.bold(sessionName), width));
			content.push("");
			content.push("");
		}
		const bar = "█".repeat(BAR_WIDTH);
		const glyphRow = `${bar}${" ".repeat(BAR_GAP)}${bar}`;
		for (let i = 0; i < BAR_ROWS; i++) {
			content.push(centerLine(theme.fg("accent", glyphRow), width));
		}
		content.push("");
		content.push(centerLine(theme.bold(theme.fg("accent", TITLE)), width));
		content.push("");
		for (const line of BODY_LINES) {
			content.push(centerLine(theme.fg("muted", line), width));
		}
		content.push("");
		content.push(centerLine(theme.fg("dim", `paused for ${formatClock(elapsedMs)}`), width));
		content.push("");
		content.push(centerLine(theme.fg("dim", RESUME_HINT), width));
	}

	const topPad = Math.max(0, Math.floor((height - content.length) / 2));
	const lines: string[] = new Array(topPad).fill("");
	lines.push(...content);
	while (lines.length < height) lines.push("");
	return lines.slice(0, Math.max(1, height));
}

export class PauseScreenComponent implements Component, OverlayFocusOwner {
	#timer: NodeJS.Timeout | undefined;
	#done = Promise.withResolvers<void>();
	#disposed = false;
	#startedAt = Date.now();

	constructor(readonly host: PauseScreenHost) {}

	run(): Promise<void> {
		this.#startedAt = agentPauseGate.pausedAt ?? Date.now();
		this.#timer ??= setInterval(() => {
			if (!this.#disposed) this.host.ui.requestRender();
		}, TICK_MS);
		this.host.ui.requestRender();
		return this.#done.promise;
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		return component === this;
	}

	handleInput(data: string): void {
		if (
			matchesAppInterrupt(data) ||
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			matchesKey(data, "space") ||
			matchesKey(data, "ctrl+c")
		) {
			if (!this.#disposed) this.#done.resolve();
		}
	}

	render(width: number): readonly string[] {
		const elapsed = Date.now() - this.#startedAt;
		return renderPauseScreen(
			Math.max(1, width),
			Math.max(1, this.host.ui.terminal.rows),
			elapsed,
			this.host.sessionName,
		);
	}
}

export async function runPauseScreen(host: PauseScreenHost): Promise<void> {
	if (!agentPauseGate.pause()) return;
	const component = new PauseScreenComponent(host);
	const overlay = host.ui.showOverlay(component, {
		width: "100%",
		maxHeight: "100%",
		anchor: "top-left",
		margin: 0,
		fullscreen: true,
	});
	try {
		host.ui.setFocus(component);
		await component.run();
	} finally {
		component.dispose();
		host.ui.setFocus(component);
		overlay.hide();
		const heldMs = agentPauseGate.resume();
		if (heldMs !== undefined) {
			host.showStatus(`Resumed after ${formatDuration(heldMs)} — agents are running again.`);
		}
	}
}
