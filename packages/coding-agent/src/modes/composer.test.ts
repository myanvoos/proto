import { expect, test } from "bun:test";
import {
	type Component,
	CURSOR_MARKER,
	Editor,
	type RenderScheduler,
	type Terminal,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";
import { AskDialogComponent } from "./components/ask-dialog";
import { AttachmentChipsBand } from "./components/attachment-chips";
import { HookEditorComponent } from "./components/hook-editor";
import { HookInputComponent } from "./components/hook-input";
import { HookSelectorComponent } from "./components/hook-selector";
import { TranscriptContainer } from "./components/transcript-container";
import { Composer } from "./composer";
import { ExtensionUiController } from "./controllers/extension-ui-controller";
import { getEditorTheme, initThemeSync, theme } from "./theme/theme";
import type { InteractiveModeContext } from "./types";

initThemeSync();

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
		let iterations = 0;
		while (this.#pending.length > 0) {
			if (++iterations > 10_000) throw new Error("render scheduler did not quiesce");
			const entry = this.#pending.shift()!;
			if (!entry.cancelled) entry.callback();
		}
	}
}

class VTermSink implements Terminal {
	readonly vt: VTermTerminal;
	#onResize: (() => void) | undefined;

	constructor(
		public columns: number,
		public rows: number,
	) {
		this.vt = new VTermTerminal({ cols: columns, rows, scrollback: 10_000 });
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

	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.vt.resize(columns, rows);
		this.#onResize?.();
	}

	screen(): string[] {
		const lines = this.vt.buffer.normal;
		return Array.from({ length: this.rows }, (_value, row) =>
			stripAnsi(
				lines
					.getLine(lines.baseY + row)
					?.translateToString(true)
					.trimEnd() ?? "",
			),
		);
	}

	tape(): string[] {
		const lines = this.vt.buffer.normal;
		const rows = Array.from({ length: lines.length }, (_value, row) =>
			stripAnsi(lines.getLine(row)?.translateToString(true).trimEnd() ?? ""),
		);
		while (rows.at(-1) === "") rows.pop();
		return rows;
	}
}

class StaticBlock implements Component {
	constructor(readonly lines: readonly string[]) {}
	render(): readonly string[] {
		return this.lines;
	}
	invalidate(): void {}
	isTranscriptBlockFinalized(): boolean {
		return true;
	}
}

class WrappingBlock implements Component {
	constructor(readonly source: string) {}
	render(width: number): readonly string[] {
		return wrapTextWithAnsi(this.source, width);
	}
	invalidate(): void {}
	isTranscriptBlockFinalized(): boolean {
		return true;
	}
}

/** A live tool-shaped card: tall while it runs, short once it settles. */
class SettlingCard implements Component {
	settled = false;
	constructor(readonly liveRows: number) {}
	render(): readonly string[] {
		return this.settled ? ["settled card"] : Array.from({ length: this.liveRows }, (_v, row) => `live-row-${row}`);
	}
	invalidate(): void {}
	isTranscriptBlockFinalized(): boolean {
		return this.settled;
	}
}

function stripAnsi(text: string): string {
	return Bun.stripANSI(text);
}

function countContaining(rows: readonly string[], marker: string): number {
	return rows.filter(row => row.includes(marker)).length;
}

function expectTranscriptAbovePrompt(terminal: VTermSink, marker = "transcript-"): void {
	const screen = terminal.screen();
	const hairline = screen.findLastIndex(row => row.length > 0 && row === theme.boxSharp.horizontal.repeat(row.length));
	expect(hairline, "the real composer hairline must be visible").toBeGreaterThanOrEqual(0);
	const contamination = screen.slice(hairline).filter(row => row.includes(marker));
	expect(
		contamination,
		`transcript painted into composer chrome at row ${hairline}: ${JSON.stringify(screen)}`,
	).toEqual([]);
}

function createHarness(
	columns: number,
	rows: number,
	quiet = true,
): {
	composer: Composer;
	terminal: VTermSink;
	scheduler: QueuedScheduler;
	transcript: TranscriptContainer;
} {
	const terminal = new VTermSink(columns, rows);
	const scheduler = new QueuedScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { quiet },
		welcome: quiet
			? undefined
			: { version: "1.2.3", modelName: "opus-5", providerName: "anthropic", recentSessions: [] },
	});
	const transcript = new TranscriptContainer();
	composer.setRuntimeChildren([transcript]);
	composer.start({ deferInput: true });
	scheduler.flush();
	return { composer, terminal, scheduler, transcript };
}

function render(composer: Composer, scheduler: QueuedScheduler): void {
	composer.ui.requestRender();
	scheduler.flush();
}

test("reflows an unacknowledged history offer under a new immutable identity", () => {
	const terminal = new VTermSink(72, 12);
	const scheduler = new QueuedScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { quiet: true },
	});
	const transcript = new TranscriptContainer();
	const source =
		"semantic-source alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau";
	transcript.addChild(new WrappingBlock(source));
	composer.setRuntimeChildren([transcript]);
	composer.start({ deferInput: true });
	composer.beginHistoryFlush();
	try {
		const wideOffer = composer.renderFrame({ columns: 72, rows: 12 }).history;
		expect(wideOffer).toBeDefined();
		const wideSnapshot = structuredClone(wideOffer!);

		const narrowOffer = composer.renderFrame({ columns: 24, rows: 12 }).history;
		expect(narrowOffer).toBeDefined();
		expect(narrowOffer).not.toBe(wideOffer);
		expect(narrowOffer!.id).toBeGreaterThan(wideOffer!.id);
		expect(wideOffer, "the withdrawn offer remains byte-for-byte immutable").toEqual(wideSnapshot);
		expect(narrowOffer!.rows).toEqual([...wrapTextWithAnsi(source, 24), ""]);

		composer.acknowledgeHistory(wideOffer!.id);
		expect(composer.renderFrame({ columns: 24, rows: 12 }).history).toBe(narrowOffer);

		composer.acknowledgeHistory(narrowOffer!.id);
		expect(transcript.blockStates()).toEqual(["committed"]);
		expect(composer.renderFrame({ columns: 24, rows: 12 }).history).toBeUndefined();
		composer.acknowledgeHistory(narrowOffer!.id);
		expect(composer.renderFrame({ columns: 24, rows: 12 }).history).toBeUndefined();
	} finally {
		composer.stop();
	}
});

test("history image admission regenerates a frozen offer before its first write", async () => {
	const source = String.raw`
import { Image, ImageProtocol, setCellDimensions, setKittyGraphics, setTerminalImageProtocol } from "../../../tui/src/index.ts";
import { Composer } from "./composer.ts";
import { TranscriptContainer } from "./components/transcript-container.ts";

setTerminalImageProtocol(ImageProtocol.Kitty);
setKittyGraphics({ unicodePlaceholders: false });
setCellDimensions({ widthPx: 1, heightPx: 1 });
class Queue {
	jobs = [];
	now = () => 100;
	scheduleImmediate(callback) { this.jobs.push({ callback, cancelled: false }); }
	scheduleRender(callback) {
		const job = { callback, cancelled: false };
		this.jobs.push(job);
		return { cancel: () => (job.cancelled = true) };
	}
	flush() {
		let guard = 0;
		while (this.jobs.length) {
			if (++guard > 10000) throw new Error("scheduler did not quiesce");
			const job = this.jobs.shift();
			if (!job.cancelled) job.callback();
		}
	}
}
class Sink {
	columns = 64;
	rows = 12;
	writes = [];
	get pendingOutputBytes() { return 0; }
	get kittyProtocolActive() { return false; }
	get kittyEnableSequence() { return null; }
	get appearance() { return undefined; }
	start() {}
	enableInput() {}
	stop() {}
	async drainInput() {}
	write(data) { this.writes.push(data); }
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
	onAppearanceChange() {}
}
const terminal = new Sink();
const scheduler = new Queue();
const composer = new Composer({
	terminal,
	tuiOptions: { renderScheduler: scheduler },
	preferences: { quiet: true, maxInlineImages: 1 },
});
const transcript = new TranscriptContainer();
const imageTheme = { fallbackColor: value => value };
const dimensions = { widthPx: 1, heightPx: 1 };
transcript.addChild(new Image("T0xERVI=", "image/png", imageTheme, {
	budget: composer.ui.imageBudget,
	filename: "older.png",
	imageKey: "older",
}, dimensions));
transcript.addChild(new Image("TkVXRVNU", "image/png", imageTheme, {
	budget: composer.ui.imageBudget,
	filename: "newest.png",
	imageKey: "newest",
}, dimensions));
composer.setRuntimeChildren([transcript]);
composer.start({ deferInput: true });
composer.beginHistoryFlush();
composer.ui.requestRender();
scheduler.flush();
composer.stop();
const output = terminal.writes.join("");
console.log(JSON.stringify({
	states: transcript.blockStates(),
	olderFallback: output.includes("[Image: older.png [image/png] 1x1]"),
	newestFallback: output.includes("[Image: newest.png [image/png] 1x1]"),
	olderPayload: output.includes("T0xERVI="),
	newestPayload: output.includes("TkVXRVNU"),
	transmitIds: [...output.matchAll(/a=t,[^\x1b]*i=(\d+)/g)].map(match => Number(match[1])),
}));
`;
	const env: Record<string, string | undefined> = { ...Bun.env, PI_NO_SYNC_OUTPUT: "1" };
	for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PI_TUI_SYNC_OUTPUT"]) {
		delete env[key];
	}
	const proc = Bun.spawn({
		cmd: [process.execPath, "--eval", source],
		cwd: import.meta.dir,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode).toBe(0);
	expect(stderr).toBe("");
	const result = JSON.parse(stdout) as {
		states: string[];
		olderFallback: boolean;
		newestFallback: boolean;
		olderPayload: boolean;
		newestPayload: boolean;
		transmitIds: number[];
	};
	expect(result.states).toEqual(["committed", "committed"]);
	expect(result.olderFallback).toBe(true);
	expect(result.newestFallback).toBe(false);
	expect(result.olderPayload).toBe(false);
	expect(result.newestPayload).toBe(true);
	expect(new Set(result.transmitIds).size).toBe(1);
});

test("ordinary renders and resizes preserve native history above the actual composer", () => {
	const { composer, terminal, scheduler, transcript } = createHarness(64, 16);
	try {
		for (let block = 0; block < 24; block++) {
			transcript.addChild(new StaticBlock(Array.from({ length: 3 }, (_value, row) => `transcript-${block}-${row}`)));
			render(composer, scheduler);
			expectTranscriptAbovePrompt(terminal);
		}
		const retiredMarker = "transcript-0-0";
		expect(countContaining(terminal.tape(), retiredMarker)).toBe(1);

		for (const [columns, rows] of [
			[48, 11],
			[90, 24],
			[55, 13],
			[64, 16],
		] as const) {
			terminal.resize(columns, rows);
			scheduler.flush();
			render(composer, scheduler);
			expectTranscriptAbovePrompt(terminal);
			expect(countContaining(terminal.tape(), retiredMarker), "resize replayed or cleared retained history").toBe(1);
		}
	} finally {
		composer.stop();
	}
});

test("explicit history replacement replays atomically without duplicate rows", () => {
	const { composer, terminal, scheduler, transcript } = createHarness(58, 12);
	try {
		for (let index = 0; index < 18; index++) transcript.addChild(new StaticBlock([`old-session-${index}`]));
		render(composer, scheduler);
		expect(countContaining(terminal.tape(), "old-session-0")).toBe(1);

		transcript.clear();
		for (let index = 0; index < 20; index++) transcript.addChild(new StaticBlock([`replacement-[${index}]`]));
		composer.beginHistoryReplay();
		render(composer, scheduler);

		const tape = terminal.tape();
		expect(
			tape.some(row => row.includes("old-session-")),
			"destructive replay retained the old session",
		).toBe(false);
		for (let index = 0; index < 20; index++) {
			expect(countContaining(tape, `replacement-[${index}]`), `replacement row ${index}`).toBe(1);
		}
		expectTranscriptAbovePrompt(terminal, "replacement-");
	} finally {
		composer.stop();
	}
});

test("the welcome scene holds the composer against the bottom edge as startup rows clear", () => {
	const { composer, terminal, scheduler, transcript } = createHarness(52, 30, false);
	try {
		composer.setHeaderExtras([], [new StaticBlock(Array.from({ length: 6 }, (_v, row) => `startup-notice-${row}`))]);
		transcript.addChild(new StaticBlock(["session ready"]));
		render(composer, scheduler);
		expect(terminal.screen().at(-1)).toBe("");

		composer.setHeaderExtras([], []);
		render(composer, scheduler);
		const screen = terminal.screen();
		const hairline = screen.findLastIndex(
			row => row.length > 0 && row === theme.boxSharp.horizontal.repeat(row.length),
		);
		expect(hairline).toBeGreaterThan(0);
		expect(screen.slice(hairline + 1).length).toBe(terminal.rows - hairline - 1);
	} finally {
		composer.stop();
	}
});

test("a tall live card settling keeps the real composer on the bottom edge", () => {
	const { composer, terminal, scheduler, transcript } = createHarness(100, 30, false);
	try {
		transcript.addChild(new StaticBlock(["> hello there"]));
		const card = new SettlingCard(35);
		transcript.addChild(card);
		render(composer, scheduler);
		expectTranscriptAbovePrompt(terminal, "live-row-");

		card.settled = true;
		render(composer, scheduler);
		expect(terminal.screen()).toHaveLength(terminal.rows);
		expectTranscriptAbovePrompt(terminal);
		expect(countContaining(terminal.tape(), "settled card")).toBe(1);
	} finally {
		composer.stop();
	}
});

for (const columns of [12, 20, 32, 40, 60]) {
	test(`active draft survives short viewport and home/end navigation at width ${columns}`, () => {
		const { composer, terminal, scheduler } = createHarness(60, 24);
		const draft =
			"BEGIN: narrow terminals must keep the insertion cursor visible while this long draft wraps across many rows; edit safely without sending. END.";
		composer.setStatusComponent(new StaticBlock(["status", ""]));
		composer.editor.setMaxHeight(6);
		composer.editor.setText(draft);
		try {
			render(composer, scheduler);
			for (const rows of [3, 6, 1, 2, 10]) {
				terminal.resize(columns, rows);
				scheduler.flush();
				composer.editor.handleInput("\x01");
				render(composer, scheduler);
				expect(terminal.screen().some(row => row.includes("BEGIN"))).toBe(true);
				composer.editor.handleInput("X");
				render(composer, scheduler);
				expect(terminal.screen().some(row => row.includes("XBEGIN"))).toBe(true);
				composer.editor.handleInput("\x7f");
				composer.editor.handleInput("\x05");
				render(composer, scheduler);
				expect(terminal.screen().some(row => row.includes("END."))).toBe(true);
				expect(composer.editor.getText()).toBe(draft);
			}
			terminal.resize(60, 24);
			scheduler.flush();
			expect(composer.editor.getText()).toBe(draft);
		} finally {
			composer.stop();
		}
	});
}

test("short composer keeps input and active completion above status chrome", async () => {
	const { composer, terminal, scheduler } = createHarness(20, 6);
	composer.setStatusComponent(new StaticBlock(["status", ""]));
	const shown = Promise.withResolvers<void>();
	composer.editor.onAutocompleteUpdate = () => shown.resolve();
	composer.editor.setAutocompleteProvider({
		async getSuggestions() {
			return { items: ["alpha", "beta", "gamma"].map(value => ({ value, label: value })), prefix: "/" };
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
	});
	try {
		composer.editor.handleInput("/");
		await shown.promise;
		for (const rows of [6, 3, 2, 1, 10]) {
			terminal.resize(20, rows);
			scheduler.flush();
			render(composer, scheduler);
			expect(terminal.screen().some(row => row.includes("/"))).toBe(true);
			if (rows > 1) expect(terminal.screen().some(row => row.includes("alpha"))).toBe(true);
		}
		terminal.resize(20, 2);
		scheduler.flush();
		composer.editor.handleInput("\x1b[B");
		render(composer, scheduler);
		expect(terminal.screen().some(row => row.includes("beta"))).toBe(true);
	} finally {
		composer.stop();
	}
});

test("resize preview keeps the composer bottom anchored while the normal-buffer probe settles", () => {
	const { composer, terminal, scheduler } = createHarness(60, 3);
	try {
		composer.editor.setText("draft");
		render(composer, scheduler);
		const preview = composer.renderResizeFrame({ columns: 60, rows: 24 });
		expect(preview).toHaveLength(24);
		expect(preview.findIndex(row => row.includes("draft"))).toBeGreaterThan(16);
		terminal.resize(60, 24);
		scheduler.flush();
		expect(terminal.screen().findLastIndex(row => row.includes("draft"))).toBeGreaterThan(16);
	} finally {
		composer.stop();
	}
});

for (const kind of ["input", "editor", "prompt", "ask", "multi", "selector"] as const) {
	test(`replacement ${kind} keeps its active control visible through terminal resizes`, () => {
		const { composer, terminal, scheduler } = createHarness(40, 24);
		let submitted: unknown;
		const onSubmit = (value: unknown) => {
			submitted = value;
		};
		const noop = () => {};
		const value = "VALUE漢字🙂";
		let control: HookInputComponent | HookEditorComponent | HookSelectorComponent | AskDialogComponent;
		if (kind === "input") {
			control = new HookInputComponent("Input title", undefined, onSubmit, noop);
		} else if (kind === "editor" || kind === "prompt") {
			control = new HookEditorComponent(
				composer.ui,
				"Editor title\nSecondary instructions ".repeat(3),
				`FIRST\nSECOND\n${value}`,
				onSubmit,
				noop,
				{ promptStyle: kind === "prompt" },
			);
		} else if (kind === "selector") {
			control = new HookSelectorComponent("Choose", [value, "BETA 👩‍💻"], onSubmit, noop);
		} else {
			control = new AskDialogComponent(
				[
					{
						id: "q",
						question: "Long question ".repeat(12),
						multi: kind === "multi",
						options: [{ label: value, description: "Optional description ".repeat(20) }, { label: "BETA 👩‍💻" }],
					},
				],
				{ onSubmit, onCancel: noop, onPrompt: async () => undefined },
				{ tui: composer.ui },
			);
		}
		composer.setStatusComponent(new StaticBlock(["status", ""]));
		composer.editorSlot.clear();
		composer.editorSlot.addChild(control);
		composer.ui.setFocus(control);
		if (kind === "input") control.handleInput(value);
		try {
			for (const [columns, rows] of [
				[40, 24],
				[40, 10],
				[32, 6],
				[20, 3],
				[20, 1],
				[40, 24],
			]) {
				terminal.resize(columns!, rows!);
				render(composer, scheduler);
				expect(terminal.screen().some(row => row.includes("VALUE"))).toBe(true);
			}
			if (kind === "editor" || kind === "prompt") {
				control.handleInput("\x01");
				control.handleInput("\x1b[A");
				control.handleInput("\x1b[A");
				terminal.resize(20, 3);
				render(composer, scheduler);
				control.handleInput("X");
				render(composer, scheduler);
				expect(terminal.screen().some(row => row.includes("XFIRST"))).toBe(true);
			}
			if (kind === "input" || kind === "selector") {
				control.handleInput("\r");
				expect(submitted).toBe(value);
			}
			if (kind === "ask" || kind === "multi") {
				terminal.resize(20, 3);
				control.handleInput("\x1b[B");
				render(composer, scheduler);
				expect(terminal.screen().some(row => row.includes("BETA"))).toBe(true);
				if (kind === "multi") {
					control.handleInput(" ");
					control.handleInput("\t");
				} else control.handleInput("\r");
				if (kind === "multi") {
					render(composer, scheduler);
					expect(terminal.screen().some(row => row.includes("Submit"))).toBe(true);
					control.handleInput("\r");
				}
				expect(submitted).toMatchObject({ kind: "submit", results: [{ selectedOptions: ["BETA 👩‍💻"] }] });
			}
		} finally {
			composer.stop();
		}
	});
}

test("guarded ask keeps the draft editable and reveals the answer after clearing it", async () => {
	const { composer, terminal, scheduler } = createHarness(20, 1);
	const controller = new ExtensionUiController({
		editor: composer.editor,
		editorContainer: composer.editorSlot,
		ui: composer.ui,
	} as InteractiveModeContext);
	composer.editor.setText("draft漢字");
	const answer = controller.showAskDialog([{ id: "q", question: "Choose", options: [{ label: "ALPHA" }] }]);
	try {
		render(composer, scheduler);
		expect(terminal.screen().join("\n")).toContain("draft漢字");
		expect(composer.editor.focused).toBe(true);
		const dialog = composer.ui.getFocused()!;
		dialog.handleInput!("\x01");
		dialog.handleInput!("\x0b");
		render(composer, scheduler);
		expect(terminal.screen().join("\n")).toContain("ALPHA");
		dialog.handleInput!("\r");
		expect(await answer).toMatchObject({ kind: "submit", results: [{ selectedOptions: ["ALPHA"] }] });
	} finally {
		composer.stop();
	}
});

test("hook editor retains its configured maximum while its host viewport changes", () => {
	const { composer, scheduler } = createHarness(40, 24);
	const editor = new HookEditorComponent(
		composer.ui,
		"Edit",
		"FIRST\nSECOND\nTHIRD",
		() => {},
		() => {},
		{ maxHeight: 1 },
	);
	try {
		for (const height of [24, 1, 6, 24]) {
			editor.setMaxHeight(height);
			const lines = editor
				.render(40)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(lines).toContain("THIRD");
			expect(lines).not.toContain("SECOND");
		}
		scheduler.flush();
	} finally {
		composer.stop();
	}
});

test("direct custom Editor keeps its preferred cap and visible insertion through resize", () => {
	const { composer, terminal, scheduler } = createHarness(40, 24);
	const editor = new Editor(getEditorTheme());
	editor.setMaxHeight(1);
	editor.setText("FIRST\nSECOND\nVALUE漢字🙂");
	composer.editorSlot.clear();
	composer.editorSlot.addChild(editor);
	composer.ui.setFocus(editor);
	try {
		for (const [columns, rows] of [
			[40, 24],
			[32, 6],
			[20, 3],
			[20, 1],
			[40, 24],
		]) {
			terminal.resize(columns!, rows!);
			render(composer, scheduler);
			expect(terminal.screen().join("\n")).toContain("VALUE漢字🙂");
			expect(terminal.screen().join("\n")).not.toContain("SECOND");
		}
		editor.handleInput("\x01");
		editor.handleInput("\x1b[A");
		editor.handleInput("\x1b[A");
		editor.handleInput("X");
		terminal.resize(20, 3);
		render(composer, scheduler);
		expect(terminal.screen().join("\n")).toContain("XFIRST");
	} finally {
		composer.stop();
	}
});

test("folded paste preview yields a complete summary without hiding input or footer", () => {
	const { composer, terminal, scheduler, transcript } = createHarness(20, 6);
	const content = Array.from({ length: 30 }, (_, index) => `line ${index} 漢字🙂 🧑🏽‍🚀`).join("\n");
	composer.editor.setText("prefix|");
	composer.editor.insertTextAttachment(content);
	const expanded = composer.editor.getExpandedText();
	const band = new AttachmentChipsBand(composer.editor, composer.ui.imageBudget, () => composer.ui.requestRender());
	composer.setRuntimeChildren([transcript, new StaticBlock(["extension status"]), band]);
	composer.setStatusComponent(new StaticBlock(["footer", ""]));
	try {
		render(composer, scheduler);
		for (const [columns, rows] of [
			[20, 6],
			[40, 6],
			[12, 6],
			[20, 3],
			[20, 12],
			[20, 6],
		] as const) {
			terminal.resize(columns, rows);
			scheduler.flush();
			render(composer, scheduler);
			const screen = terminal.screen();
			expect(screen.some(row => row.includes("footer"))).toBe(true);
			// A full card counts the rows its preview hides; a card that cannot fit falls back to
			// the compact caption carrying the whole count.
			// The compact caption carries the whole line count; a full card counts only the rows
			// its four preview lines hide.
			const compactCaption = screen.some(row => row.includes("#1 30 lines"));
			const cardCaption = screen.some(row => row.includes("+26 lines"));
			if (rows >= 6) expect(compactCaption || cardCaption).toBe(true);
			const topBorder = screen.some(row => row.includes(theme.boxRound.topLeft));
			if (topBorder) {
				expect(screen.some(row => row.includes(theme.boxRound.bottomLeft))).toBe(true);
				expect(cardCaption).toBe(true);
			}
			expect(
				composer.renderFrame({ columns, rows }).viewport.filter(row => row.includes(CURSOR_MARKER)),
			).toHaveLength(1);
			expect(composer.editor.getExpandedText()).toBe(expanded);
			expect(expanded).toContain(content);
		}
	} finally {
		composer.stop();
		band.dispose();
	}
});

for (const columns of [20, 30, 40]) {
	test(`streaming busy row and interrupt hint survive a queued steering list at ${columns}x6`, () => {
		const { composer, terminal, scheduler, transcript } = createHarness(columns, 6);
		const queued = new StaticBlock([
			"",
			"Steering · 2",
			"  1. QUEUED 漢字🙂 one",
			"  2. QUEUED 🧑🏽‍🚀 two",
			"  ⤷ Alt+Up to edit",
		]);
		const busy = new StaticBlock(["⣠⣾ Working… ⟦esc⟧"]);
		composer.setRuntimeChildren([transcript, queued, busy], [new StaticBlock(["  Esc interrupt"])]);
		composer.setStatusComponent(new StaticBlock(["  ▰▰▰▰▰▰▱▱ 93% left", ""]));
		try {
			render(composer, scheduler);
			const screen = terminal.screen();
			expect(screen.some(row => row.includes("Working…"))).toBe(true);
			expect(screen.some(row => row.includes("Esc interrupt"))).toBe(true);
			expect(screen.some(row => row.includes("Steering"))).toBe(true);
			expect(screen.some(row => row.includes("ask anything"))).toBe(true);
			// The compressed list sheds entries, never its leading count.
			expect(screen.some(row => row.includes("Alt+Up to edit"))).toBe(false);

			// Given room, the same frame restores the full queue beside the affordances.
			terminal.resize(columns, 10);
			scheduler.flush();
			render(composer, scheduler);
			const tall = terminal.screen();
			for (const marker of ["Steering", "Alt+Up to edit", "Working…", "Esc interrupt"]) {
				expect(
					tall.some(row => row.includes(marker)),
					`${marker} missing at ${columns}x10`,
				).toBe(true);
			}
			expect(
				tall.filter(row => row.includes("QUEUED")),
				`queue entries missing at ${columns}x10`,
			).toHaveLength(2);
		} finally {
			composer.stop();
		}
	});
}

test("a tool confirmation outranks transcript and status chrome on a short terminal", () => {
	const { composer, terminal, scheduler, transcript } = createHarness(20, 6);
	transcript.addChild(new StaticBlock(Array.from({ length: 12 }, (_, i) => `transcript row ${i}`)));
	composer.setStatusComponent(new StaticBlock(["status", "Esc interrupt"]));
	let chosen: string | undefined;
	const confirm = new HookSelectorComponent(
		"CONFIRM 漢字🙂 tool dialog title\nApprove 漢字🙂 this isolated action?",
		["Yes", "No"],
		value => {
			chosen = value;
		},
		() => {},
	);
	composer.editorSlot.clear();
	composer.editorSlot.addChild(confirm);
	composer.ui.setFocus(confirm);
	try {
		for (const rows of [6, 10, 15, 3, 6]) {
			terminal.resize(20, rows);
			render(composer, scheduler);
			const screen = terminal.screen().join("\n");
			expect(screen).toContain("CONF");
			expect(screen).toContain("Yes");
			expect(screen.includes("No") || screen.includes("+1")).toBe(true);
		}
		confirm.handleInput("\r");
		expect(chosen).toBe("Yes");
	} finally {
		composer.stop();
	}
});

test("growing chrome never eats a finalized block at a steady size", () => {
	// Transcript rows the frame counts as live but the terminal cannot paint are
	// lost: they are clipped off the top of the plan and were never retired.
	const { composer, terminal, scheduler, transcript } = createHarness(60, 20);
	try {
		for (let index = 0; index < 12; index++) {
			transcript.addChild(
				new WrappingBlock(`block-${index} an answer long enough to wrap inside a forty column pane`),
			);
			composer.editor.setText(index % 2 === 0 ? `draft ${index}\nsecond line\nthird line` : `draft ${index}`);
			composer.setStatusComponent(new StaticBlock([`status ${index}`, "Esc interrupt"]));
			render(composer, scheduler);
			for (let seen = 0; seen <= index; seen++) {
				expect(countContaining(terminal.tape(), `block-${seen} `), `block-${seen} after block-${index}`).toBe(1);
			}
		}
	} finally {
		composer.stop();
	}
});

test("every finalized block stays retired-once or live through extreme geometries", () => {
	// The retirement/viewport split owns this invariant independently of the
	// writer: at every geometry each finalized block is either already offered to
	// native history (exactly once across the session) or still rendered in the
	// live viewport. A pane too short to paint the tail must retire it, never
	// silently drop it.
	const { composer, scheduler } = createHarness(60, 20, true);
	const transcript = new TranscriptContainer();
	composer.setRuntimeChildren([transcript]);
	const markers = ["transcript-1", "transcript-2", "transcript-3", "transcript-4"];
	for (const marker of markers) {
		transcript.addChild(new WrappingBlock(`${marker} an answer long enough to wrap inside a forty column pane`));
	}
	render(composer, scheduler);
	const retiredCounts = new Map(markers.map(marker => [marker, 0]));
	try {
		for (const [columns, rows] of [
			[60, 20],
			[40, 5],
			[40, 3],
			[40, 2],
			[40, 1],
			[60, 20],
			[20, 4],
			[60, 20],
		] as const) {
			for (let pass = 0; pass < 3; pass++) {
				const plan = composer.renderFrame({ columns, rows });
				const history = (plan.history?.rows ?? []).map(stripAnsi);
				const viewport = plan.viewport.map(stripAnsi);
				if (plan.history) composer.acknowledgeHistory(plan.history.id);
				for (const marker of markers) {
					retiredCounts.set(marker, retiredCounts.get(marker)! + countContaining(history, marker));
					expect(retiredCounts.get(marker), `${marker} retired twice at ${columns}x${rows}`).toBeLessThanOrEqual(
						1,
					);
					const live = countContaining(viewport, marker) > 0;
					expect(
						retiredCounts.get(marker)! > 0 || live,
						`${marker} neither retired nor live at ${columns}x${rows} pass ${pass}`,
					).toBe(true);
				}
			}
		}
	} finally {
		composer.stop();
	}
});

test("an extreme shrink never loses a finalized block from the tape", () => {
	// A finalized block has exactly two lawful fates: retired into the host's
	// append-only scrollback, or still live in the mutable viewport. Vanishing
	// from both is transcript loss, and a pane too short to paint the live tail
	// must retire it rather than drop it.
	const saved = new Map<string, string | undefined>();
	for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "TMUX", "STY", "ZELLIJ"]) {
		saved.set(key, Bun.env[key]);
		delete Bun.env[key];
	}
	const { composer, terminal, scheduler, transcript } = createHarness(60, 20);
	const markers = ["transcript-1", "transcript-2", "transcript-3", "transcript-4"];
	for (const marker of markers) {
		transcript.addChild(new WrappingBlock(`${marker} an answer long enough to wrap inside a forty column pane`));
	}
	render(composer, scheduler);
	try {
		for (const [columns, rows] of [
			[40, 5],
			[60, 20],
			[40, 3],
			[60, 20],
			[40, 1],
			[60, 20],
		] as const) {
			terminal.resize(columns, rows);
			render(composer, scheduler);
			for (const marker of markers) {
				// Never vanished: retired into scrollback, still live, or both — a
				// host shrink pushes the rows it can no longer show into scrollback
				// before SIGWINCH arrives, and that copy cannot be retracted.
				expect(
					countContaining(terminal.tape(), marker),
					`${marker} vanished at ${columns}x${rows}`,
				).toBeGreaterThan(0);
			}
		}
		// The documented recovery clears scrollback and replays the ledger, so the
		// host's pushed copies disappear and every block is written exactly once.
		composer.beginHistoryReplay();
		render(composer, scheduler);
		for (const marker of markers) {
			expect(countContaining(terminal.tape(), marker), `${marker} after replay`).toBe(1);
		}
	} finally {
		composer.stop();
		for (const [key, value] of saved) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	}
});

test("a shrink retires the transcript overflow once and only a replay can bring it back", () => {
	const { composer, scheduler } = createHarness(60, 20, true);
	const transcript = new TranscriptContainer();
	composer.setRuntimeChildren([transcript]);
	const markers = ["transcript-1", "transcript-2", "transcript-3", "transcript-4"];
	for (const marker of markers) {
		transcript.addChild(new WrappingBlock(`${marker} an answer long enough to wrap inside a forty column pane`));
	}
	render(composer, scheduler);
	const frameAt = (columns: number, rows: number) => {
		const plan = composer.renderFrame({ columns, rows });
		if (plan.history) composer.acknowledgeHistory(plan.history.id);
		return {
			history: (plan.history?.rows ?? []).map(row => Bun.stripANSI(row)),
			viewport: plan.viewport.map(row => Bun.stripANSI(row)),
		};
	};
	try {
		// A pane that can hold the transcript keeps every block live.
		expect(frameAt(60, 20).history).toEqual([]);
		for (const marker of markers) {
			expect(countContaining(frameAt(60, 20).viewport, marker)).toBe(1);
		}

		// A five-row pane cannot: the overflow retires into the host's scrollback,
		// which is append-only, so the rows are offered exactly once.
		const shrunk = composer.renderFrame({ columns: 40, rows: 5 });
		const retired = (shrunk.history?.rows ?? []).map(stripAnsi);
		const liveAfterShrink = shrunk.viewport.map(stripAnsi);
		if (shrunk.history) composer.acknowledgeHistory(shrunk.history.id);
		// The retired prefix and the live tail partition the markers: every block
		// is offered exactly once or still rendered, and the split is contiguous.
		const retiredMarkers = markers.filter(marker => countContaining(retired, marker) > 0);
		expect(retiredMarkers.length).toBeGreaterThan(0);
		expect(retiredMarkers).toEqual(markers.slice(0, retiredMarkers.length));
		for (const marker of retiredMarkers) expect(countContaining(retired, marker)).toBe(1);
		for (const marker of markers.slice(retiredMarkers.length)) {
			expect(countContaining(liveAfterShrink, marker), `${marker} must stay live`).toBe(1);
		}
		const reoffered = frameAt(40, 5).history;
		for (const marker of markers) expect(countContaining(reoffered, marker)).toBe(0);

		// Growing back cannot retract that push: retired rows stay retired and are
		// never written a second time.
		const restored = frameAt(60, 20);
		expect(restored.history).toEqual([]);
		for (const marker of retired.filter(row => row.length > 0)) {
			expect(countContaining(restored.viewport, marker)).toBe(0);
		}

		// The documented recovery is an explicit display replacement: it clears
		// native scrollback and replays the whole ledger, each block exactly once.
		composer.beginHistoryReplay();
		const replay = frameAt(60, 20).history;
		for (const marker of markers) expect(countContaining(replay, marker)).toBe(1);
	} finally {
		composer.stop();
	}
});
