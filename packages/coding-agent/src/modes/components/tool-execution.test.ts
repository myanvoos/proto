import { expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	getCellDimensions,
	getKittyGraphics,
	ImageProtocol,
	type RenderScheduler,
	setCellDimensions,
	setKittyGraphics,
	setTerminalImageProtocol,
	TERMINAL,
	type Terminal,
	Text,
	TUI,
} from "@oh-my-pi/pi-tui";
import { initThemeSync } from "../theme/theme";
import { ToolExecutionComponent, type ToolExecutionUi } from "./tool-execution";

initThemeSync();

function plain(component: ToolExecutionComponent): string {
	return component
		.render(120)
		.map(row => Bun.stripANSI(row))
		.join("\n");
}

test("partial tool-result deltas coalesce rebuilds while preserving the newest and final result", () => {
	let scheduledRenders = 0;
	let customResultRenders = 0;
	const ui: ToolExecutionUi = {
		requestRender: () => {},
		requestComponentRender: () => {
			scheduledRenders++;
		},
	};
	const tool = {
		label: "streaming-test",
		execute: async () => ({ content: [] }),
		renderResult: (result: { content: Array<{ type: string; text?: string }> }) => {
			customResultRenders++;
			const text = result.content.map(block => block.text ?? "").join("\n");
			return new Text(text, 0, 0);
		},
	} as unknown as AgentTool;
	const component = new ToolExecutionComponent("streaming-test", {}, { useBuiltInRenderer: false }, tool, ui);

	try {
		for (let index = 0; index < 1000; index++) {
			component.updateResult({ content: [{ type: "text", text: `partial-${index}` }] }, true);
		}

		expect(scheduledRenders).toBe(1);
		expect(customResultRenders).toBe(0);
		expect(plain(component)).toContain("partial-999");
		expect(plain(component)).not.toContain("partial-998");
		expect(customResultRenders).toBe(1);

		component.updateResult({ content: [{ type: "text", text: "final-result" }] }, false);
		expect(customResultRenders).toBe(2);
		expect(plain(component)).toContain("final-result");
		expect(plain(component)).not.toContain("partial-999");
	} finally {
		component.dispose();
	}
});

class QueuedScheduler implements RenderScheduler {
	readonly #pending: Array<{ callback: () => void; cancelled: boolean }> = [];
	now(): number {
		return 100;
	}
	scheduleImmediate(callback: () => void): void {
		this.#pending.push({ callback, cancelled: false });
	}
	scheduleRender(callback: () => void): { cancel(): void } {
		const entry = { callback, cancelled: false };
		this.#pending.push(entry);
		return { cancel: () => (entry.cancelled = true) };
	}
	flush(): void {
		let guard = 10_000;
		while (this.#pending.length > 0) {
			if (--guard === 0) throw new Error("render scheduler did not quiesce");
			const entry = this.#pending.shift()!;
			if (!entry.cancelled) entry.callback();
		}
	}
}

class RecordingTerminal implements Terminal {
	columns = 120;
	rows = 40;
	writes: string[] = [];
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
	start(): void {}
	enableInput(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
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
	take(): string {
		const output = this.writes.join("");
		this.writes = [];
		return output;
	}
}

test("a live tool card keeps its image on the terminal across result updates and only resends changed pixels", () => {
	const previousProtocol = TERMINAL.imageProtocol;
	const previousCells = getCellDimensions();
	const previousKitty = getKittyGraphics();
	setTerminalImageProtocol(ImageProtocol.Kitty);
	setKittyGraphics({ unicodePlaceholders: false });
	setCellDimensions({ widthPx: 1, heightPx: 1 });
	const terminal = new RecordingTerminal();
	const scheduler = new QueuedScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const tool = {
		label: "kernel-test",
		execute: async () => ({ content: [] }),
		renderResult: () => new Text("cell output", 0, 0),
	} as unknown as AgentTool;
	const component = new ToolExecutionComponent("kernel-test", {}, { useBuiltInRenderer: false }, tool, tui);
	const plot = { type: "image" as const, data: "UExPVA==", mimeType: "image/png" };
	const result = (text: string, image = plot) => ({ content: [{ type: "text" as const, text }, image] });
	const deletes = (output: string) => output.match(/a=d,d=I/g)?.length ?? 0;
	const transmits = (output: string) => output.match(/a=t,/g)?.length ?? 0;
	try {
		tui.addChild(component);
		tui.start({ deferInput: true });
		component.updateResult(result("partial-0"), true);
		tui.requestRender();
		scheduler.flush();
		expect(transmits(terminal.take())).toBe(1);

		// Kernel output keeps streaming below an already-displayed plot; the
		// final result then settles the card. Neither may delete the plot.
		component.updateResult(result("partial-1"), true);
		tui.requestRender();
		scheduler.flush();
		component.updateResult(result("done"), false);
		tui.requestRender();
		scheduler.flush();
		const settled = terminal.take();
		expect(deletes(settled)).toBe(0);
		expect(transmits(settled)).toBe(0);

		// Different pixels at the same position must replace the payload.
		component.updateResult(result("redrawn", { ...plot, data: "TkVXUExPVA==" }), false);
		tui.requestRender();
		scheduler.flush();
		const replaced = terminal.take();
		expect(transmits(replaced)).toBe(1);
		expect(replaced).toContain("TkVXUExPVA==");
	} finally {
		tui.stop();
		component.dispose();
		setTerminalImageProtocol(previousProtocol);
		setCellDimensions(previousCells);
		setKittyGraphics(previousKitty);
	}
});
