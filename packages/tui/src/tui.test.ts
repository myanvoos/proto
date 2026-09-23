import { expect, it } from "bun:test";
import { Image, ImageBudget } from "./components/image";
import { Container } from "./tui";

it("distinguishes detach/reorder from disposal when removing container children", () => {
	const container = new Container();
	let removedDisposals = 0;
	let clearedDisposals = 0;
	const removed = { render: () => [], dispose: () => removedDisposals++ };
	const cleared = { render: () => [], dispose: () => clearedDisposals++ };
	container.addChild(removed);
	container.removeChild(removed);
	container.addChild(removed);
	expect(removedDisposals).toBe(0);
	container.disposeAndRemoveChild(removed);
	container.disposeAndRemoveChild(removed);
	expect(removedDisposals).toBe(1);
	container.addChild(cleared);
	container.clear();
	container.clear();
	expect(clearedDisposals).toBe(0);
	container.addChild(cleared);
	container.disposeChildren();
	container.disposeChildren();
	expect(clearedDisposals).toBe(1);
});

it("drains Kitty image work for viewport and overlay frames", async () => {
	const source = `
import { TUI } from "./src/tui.ts";
import { Image } from "./src/components/image.ts";
import { ImageProtocol, setCellDimensions, setTerminalImageProtocol } from "./src/terminal-capabilities.ts";
import { setKittyGraphics } from "./src/kitty-graphics.ts";

setTerminalImageProtocol(ImageProtocol.Kitty);

class FakeTerminal {
	columns = 20;
	rows = 4;
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

const pending = [];
const scheduler = {
	now: () => 100,
	scheduleImmediate(callback) { pending.push({ callback, cancelled: false }); },
	scheduleRender(callback) {
		const entry = { callback, cancelled: false };
		pending.push(entry);
		return { cancel() { entry.cancelled = true; } };
	},
};
const flush = () => {
	while (pending.length > 0) {
		const entry = pending.shift();
		if (!entry.cancelled) entry.callback();
	}
};
const theme = { fallbackColor: value => value };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const makeImage = (budget, dimensions = { widthPx: 9, heightPx: 18 }, maxHeightCells) =>
	new Image(png, "image/png", theme, { budget, maxHeightCells }, dimensions);

setKittyGraphics({ unicodePlaceholders: false });
setCellDimensions({ widthPx: 1, heightPx: 1 });
const frameTerminal = new FakeTerminal();
const frameTui = new TUI(frameTerminal, false, { renderScheduler: scheduler });
const frameImage = makeImage(frameTui.imageBudget, { widthPx: 1, heightPx: 1 });
frameTui.addChild(frameImage);
frameTui.start({ deferInput: true });
flush();
frameTerminal.writes.length = 0;
frameTui.clearInlineImages();
frameTui.invalidate();
frameTui.requestRender(true);
flush();
const frameOutput = frameTerminal.writes.join("");

const tallTerminal = new FakeTerminal();
const tallTui = new TUI(tallTerminal, false, { renderScheduler: scheduler });
const tallImage = makeImage(tallTui.imageBudget, { widthPx: 9, heightPx: 18 });
tallTui.addChild(tallImage);
tallTui.start({ deferInput: true });
flush();
tallTerminal.writes.length = 0;
tallTui.clearInlineImages();
tallTui.invalidate();
tallTui.requestRender(true);
flush();
const tallOutput = tallTerminal.writes.join("");

setKittyGraphics({ unicodePlaceholders: true });
const placeholderTerminal = new FakeTerminal();
const placeholderTui = new TUI(placeholderTerminal, false, { renderScheduler: scheduler });
const placeholderImage = makeImage(placeholderTui.imageBudget);
placeholderTui.addChild(placeholderImage);
placeholderTui.start({ deferInput: true });
flush();
placeholderTerminal.writes.length = 0;
placeholderTui.clearInlineImages();
placeholderTui.invalidate();
placeholderTui.requestRender(true);
flush();
const placeholderOutput = placeholderTerminal.writes.join("");

setKittyGraphics({ unicodePlaceholders: false });
const overlayTerminal = new FakeTerminal();
const overlayTui = new TUI(overlayTerminal, false, { renderScheduler: scheduler });
overlayTui.addChild({ render: () => ["base"] });
overlayTui.start({ deferInput: true });
flush();
const overlayImage = makeImage(overlayTui.imageBudget, { widthPx: 2, heightPx: 2 }, 2);
overlayTerminal.writes.length = 0;
const overlayHandle = overlayTui.showOverlay({ render: width => overlayImage.render(width) });
flush();
const overlayInitialOutput = overlayTerminal.writes.join("");
overlayTerminal.writes.length = 0;
overlayTui.requestRender(true);
flush();
const persistentOverlayOutput = overlayTerminal.writes.join("");
overlayTerminal.writes.length = 0;
overlayHandle.hide();
flush();
overlayTui.requestRender(true);
flush();
const hiddenOverlayOutput = overlayTerminal.writes.join("");

const fullscreenTerminal = new FakeTerminal();
const fullscreenTui = new TUI(fullscreenTerminal, false, { renderScheduler: scheduler });
const fullscreenImage = makeImage(fullscreenTui.imageBudget, { widthPx: 2, heightPx: 2 }, 2);
fullscreenTui.start({ deferInput: true });
flush();
fullscreenTerminal.writes.length = 0;
const fullscreenHandle = fullscreenTui.showOverlay({ render: width => fullscreenImage.render(width) }, { fullscreen: true });
flush();
const fullscreenInitialOutput = fullscreenTerminal.writes.join("");
fullscreenTerminal.writes.length = 0;
fullscreenHandle.hide();
flush();
fullscreenTui.requestRender(true);
flush();
const fullscreenExitOutput = fullscreenTerminal.writes.join("");

const cappedTerminal = new FakeTerminal();
cappedTerminal.rows = 12;
const cappedTui = new TUI(cappedTerminal, false, { renderScheduler: scheduler });
cappedTui.imageBudget.setCap(2);
const cappedImages = Array.from({ length: 4 }, () => makeImage(cappedTui.imageBudget, { widthPx: 18, heightPx: 1 }, 1));
const cappedGallery = { render: width => cappedImages.flatMap(image => image.render(width)) };
cappedTui.start({ deferInput: true });
flush();
cappedTerminal.writes.length = 0;
cappedTui.showOverlay(cappedGallery, { fullscreen: true });
flush();
const fullscreenCappedTransmits = (cappedTerminal.writes.join("").match(/a=t,/g) || []).length;

console.log(JSON.stringify({
	frameTransmitted: frameOutput.includes("a=t,"),
	framePlacement: frameOutput.includes("a=p,"),
	tallTransmitted: tallOutput.includes("a=t,"),
	tallPlacement: tallOutput.includes("a=p,"),
	tallPending: tallTui.imageBudget.hasPendingTransmits(),
	framePending: frameTui.imageBudget.hasPendingTransmits(),
	placeholderTransmitted: placeholderOutput.includes("a=t,"),
	overlayTransmitted: overlayInitialOutput.includes("a=t,"),
	overlayPlacement: overlayInitialOutput.includes("a=p,"),
	fullscreenTransmitted: fullscreenInitialOutput.includes("a=t,"),
	fullscreenPlacement: fullscreenInitialOutput.includes("a=p,"),
	fullscreenCappedTransmits,
	persistentOverlayDeletes: persistentOverlayOutput.includes("a=d,d=I"),
	hiddenOverlayDeletes: hiddenOverlayOutput.includes("a=d,d=I"),
	fullscreenExitDeletes: fullscreenExitOutput.includes("a=d,d=I"),
}));
`;
	const env: Record<string, string | undefined> = { ...Bun.env, PI_NO_SYNC_OUTPUT: "1" };
	for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PI_TUI_SYNC_OUTPUT"]) {
		delete env[key];
	}
	const proc = Bun.spawn({
		cmd: [process.execPath, "--eval", source],
		cwd: import.meta.dir.replace(/\/src$/u, ""),
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
		frameTransmitted: boolean;
		framePlacement: boolean;
		tallTransmitted: boolean;
		tallPlacement: boolean;
		tallPending: boolean;
		framePending: boolean;
		placeholderTransmitted: boolean;
		overlayTransmitted: boolean;
		overlayPlacement: boolean;
		fullscreenTransmitted: boolean;
		fullscreenPlacement: boolean;
		fullscreenCappedTransmits: number;
		persistentOverlayDeletes: boolean;
		hiddenOverlayDeletes: boolean;
		fullscreenExitDeletes: boolean;
	};
	expect(result.frameTransmitted).toBe(true);
	expect(result.framePlacement).toBe(true);
	expect(result.tallTransmitted).toBe(true);
	expect(result.tallPlacement).toBe(true);
	expect(result.tallPending).toBe(false);
	expect(result.framePending).toBe(false);
	expect(result.placeholderTransmitted).toBe(true);
	expect(result.overlayTransmitted).toBe(true);
	expect(result.overlayPlacement).toBe(true);
	expect(result.fullscreenTransmitted).toBe(true);
	expect(result.fullscreenPlacement).toBe(true);
	expect(result.fullscreenCappedTransmits).toBe(2);
	expect(result.persistentOverlayDeletes).toBe(false);
	expect(result.hiddenOverlayDeletes).toBe(true);
	expect(result.fullscreenExitDeletes).toBe(true);
});

it("retains both side-by-side Kitty placeholder payloads in one viewport frame", async () => {
	const source = `
import { TUI } from "./src/tui.ts";
import { ImageProtocol, setTerminalImageProtocol } from "./src/terminal-capabilities.ts";
import { renderKittyPlaceholderLines, setKittyGraphics } from "./src/kitty-graphics.ts";

setTerminalImageProtocol(ImageProtocol.Kitty);
setKittyGraphics({ unicodePlaceholders: true });

class FakeTerminal {
	columns = 32;
	rows = 1;
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

const scheduler = {
	now: () => 100,
	scheduleImmediate(callback) { callback(); },
	scheduleRender(callback) { callback(); return { cancel() {} }; },
};
const terminal = new FakeTerminal();
const tui = new TUI(terminal, false, { renderScheduler: scheduler });
const left = tui.imageBudget.acquireId("chip-left");
const right = tui.imageBudget.acquireId("chip-right");
const chips = {
	render() {
		const leftSuppressed = tui.imageBudget.observe(left);
		const rightSuppressed = tui.imageBudget.observe(right);
		if (!leftSuppressed && tui.imageBudget.shouldTransmit(left)) tui.imageBudget.enqueueTransmit(left, "a=t," + left);
		if (!rightSuppressed && tui.imageBudget.shouldTransmit(right)) tui.imageBudget.enqueueTransmit(right, "a=t," + right);
		const leftRow = renderKittyPlaceholderLines({ imageId: left, placementId: 1, columns: 1, rows: 1 })[0];
		const rightRow = renderKittyPlaceholderLines({ imageId: right, placementId: 2, columns: 1, rows: 1 })[0];
		return [leftRow + "  " + rightRow];
	},
};
tui.addChild(chips);
tui.start({ deferInput: true });
terminal.writes.length = 0;
tui.clearInlineImages();
tui.invalidate();
tui.requestRender(true);
const output = terminal.writes.join("");
console.log(JSON.stringify({ transmits: (output.match(/a=t,/g) || []).length, pending: tui.imageBudget.hasPendingTransmits() }));
`;
	const env: Record<string, string | undefined> = { ...Bun.env, PI_NO_SYNC_OUTPUT: "1" };
	for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PI_TUI_SYNC_OUTPUT"]) {
		delete env[key];
	}
	const proc = Bun.spawn({
		cmd: [process.execPath, "--eval", source],
		cwd: import.meta.dir.replace(/\/src$/u, ""),
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
	const result = JSON.parse(stdout) as { transmits: number; pending: boolean };
	expect(result.transmits).toBe(2);
	expect(result.pending).toBe(false);
});

it("filters resize image transmits to the emitted viewport rows", async () => {
	const source = `
import { TUI } from "./src/tui.ts";
import { Image } from "./src/components/image.ts";
import { ImageProtocol, setTerminalImageProtocol } from "./src/terminal-capabilities.ts";
import { setKittyGraphics } from "./src/kitty-graphics.ts";

setTerminalImageProtocol(ImageProtocol.Kitty);
setKittyGraphics({ unicodePlaceholders: false });

class FakeTerminal {
	columns = 20;
	rows = 1;
	writes = [];
	onResizeCallback;
	get pendingOutputBytes() { return 0; }
	get kittyProtocolActive() { return false; }
	get kittyEnableSequence() { return null; }
	get appearance() { return undefined; }
	start(_onInput, onResize) { this.onResizeCallback = onResize; }
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

let delayedCallback: (() => void) | undefined;
const scheduler = {
	now: () => 100,
	scheduleImmediate(callback) { callback(); },
	scheduleRender(callback, delayMs) {
		if (delayMs === 0) callback();
		else delayedCallback = callback;
		return { cancel() {} };
	},
};
const theme = { fallbackColor: value => value };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const tuiTerminal = new FakeTerminal();
const tui = new TUI(tuiTerminal, false, { renderScheduler: scheduler });
const first = new Image(png, "image/png", theme, { budget: tui.imageBudget }, { widthPx: 9, heightPx: 18 });
const second = new Image(png, "image/png", theme, { budget: tui.imageBudget }, { widthPx: 9, heightPx: 18 });
tui.addChild(first);
tui.addChild(second);
tui.start({ deferInput: true });
const initial = tuiTerminal.writes.join("");
const ids = [...initial.matchAll(/a=t,[^\\x1b]*i=(\\d+)/g)].map(match => Number(match[1]));
tuiTerminal.writes.length = 0;
tui.clearInlineImages();
tuiTerminal.columns = 19;
tuiTerminal.onResizeCallback();
const resized = tuiTerminal.writes.join("");
void delayedCallback;
console.log(JSON.stringify({ ids, transmits: [...resized.matchAll(/a=t,[^\\x1b]*i=(\\d+)/g)].map(match => Number(match[1])) }));
`;
	const env: Record<string, string | undefined> = { ...Bun.env, PI_NO_SYNC_OUTPUT: "1" };
	for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PI_TUI_SYNC_OUTPUT"]) {
		delete env[key];
	}
	const proc = Bun.spawn({
		cmd: [process.execPath, "--eval", source],
		cwd: import.meta.dir.replace(/\/src$/u, ""),
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
	const result = JSON.parse(stdout) as { ids: number[]; transmits: number[] };
	// Child fallback is viewport-bounded: only the second image is visible in
	// this one-row terminal, so only that image may be transmitted or replayed.
	expect(result.ids).toHaveLength(1);
	expect(result.transmits).toEqual(result.ids);
});

it("releases Image budget ownership through explicit container disposal", () => {
	const budget = new ImageBudget(2);
	const imageKey = "discarded-image";
	const image = new Image(
		"",
		"image/png",
		{ fallbackColor: value => value },
		{ budget, imageKey },
		{ widthPx: 1, heightPx: 1 },
	);
	const container = new Container();
	container.addChild(image);
	container.disposeAndRemoveChild(image);
	const replacement = budget.acquireId(imageKey);
	expect(budget.shouldTransmit(replacement)).toBe(true);
	budget.releaseImageKey(imageKey, replacement);
});

/** Frame writes a Herdr pane emits after DECRQM answers mode 2026 with `status`. */
async function herdrFrameAfterDecrpm(status: number): Promise<string> {
	const source = `
import { TUI } from "./src/tui.ts";
class MockTerminal {
	columns = 20;
	rows = 5;
	writes = [];
	callback;
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
	onPrivateModeReport(callback) { this.callback = callback; }
}
const terminal = new MockTerminal();
let value = "first";
const scheduler = {
	now: () => 0,
	scheduleImmediate(callback) { callback(); return { cancel() {} }; },
	scheduleDelayed(_delay, callback) { callback(); return { cancel() {} }; },
};
const tui = new TUI(terminal, false, { renderScheduler: scheduler });
tui.addChild({ render: () => [value] });
tui.start({ deferInput: true });
terminal.writes.length = 0;
terminal.callback?.(2026, false, true, ${status});
value = "second";
tui.invalidate();
tui.requestRender(true);
const writes = [...terminal.writes];
tui.stop();
console.log(JSON.stringify(writes));
`;
	const env: Record<string, string | undefined> = { ...Bun.env, HERDR_PANE_ID: "pane-1" };
	for (const key of ["HERDR_ENV", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PI_NO_SYNC_OUTPUT", "PI_TUI_SYNC_OUTPUT"]) {
		delete env[key];
	}
	const proc = Bun.spawn({
		cmd: [process.execPath, "--eval", source],
		cwd: import.meta.dir.replace(/\/src$/u, ""),
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
	return (JSON.parse(stdout) as string[]).join("");
}

it("keeps Herdr frame writes bracketed by DECSET 2026 after an unrecognized DECRQM reply", async () => {
	const stream = await herdrFrameAfterDecrpm(0);
	expect(stream).toStartWith("\x1b[?25l\x1b[?2026h\x1b[?7l");
	expect(stream).toEndWith("\x1b[?7h\x1b[?2026l");
});

it("drops DECSET 2026 in Herdr when DECRQM reports the mode permanently reset", async () => {
	const stream = await herdrFrameAfterDecrpm(4);
	expect(stream).not.toContain("\x1b[?2026h");
});

it("keeps full-paint and differential frame streams byte-identical for styled rows", async () => {
	const source = `
import { TUI } from "./src/tui.ts";
class FakeTerminal {
	columns = 12;
	rows = 3;
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
	onPrivateModeReport() {}
}
const terminal = new FakeTerminal();
let value = ["\x1b[31mred\x1b[0m", "normal", "\x1b]8;;https://x\x07link\x1b]8;;\x07"];
const scheduler = {
	now: () => 100,
	scheduleImmediate(callback) { callback(); },
	scheduleRender(callback, _delay) { callback(); return { cancel() {} }; },
};
const tui = new TUI(terminal, false, { renderScheduler: scheduler });
tui.addChild({ render: () => value });
tui.start({ deferInput: true });
const initial = terminal.writes.join("");
terminal.writes.length = 0;
value = ["\x1b[32mgreen\x1b[0m", "normal2", "\x1b]8;;https://x\x07link2\x1b]8;;\x07"];
tui.resetDisplay();
const reset = terminal.writes.join("");
terminal.writes.length = 0;
value = ["\x1b[33myellow\x1b[0m", "normal3", "\x1b]8;;https://x\x07link3\x1b]8;;\x07"];
tui.requestRender();
const update = terminal.writes.join("");
console.log(JSON.stringify({ initial, reset, update }));
`;
	const env: Record<string, string | undefined> = { ...Bun.env, PI_NO_SYNC_OUTPUT: "1" };
	for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PI_TUI_SYNC_OUTPUT"]) {
		delete env[key];
	}
	const proc = Bun.spawn({
		cmd: [process.execPath, "--eval", source],
		cwd: import.meta.dir.replace(/\/src$/u, ""),
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
	const streams = JSON.parse(stdout) as { initial: string; reset: string; update: string };
	expect(streams.initial).toContain("\x1b[31mred\x1b[0m");
	expect(streams.initial).toContain("normal");
	expect(streams.initial).toContain("\x1b]8;;https://x\x07link");
	expect(streams.reset).toContain("\x1b[3J");
	expect(streams.reset).toContain("\x1b[32mgreen\x1b[0m");
	expect(streams.reset).toContain("normal2");
	expect(streams.update).not.toContain("\x1b[3J");
	expect(streams.update).toContain("\x1b[33myellow\x1b[0m");
	expect(streams.update).toContain("normal3");
	for (const stream of Object.values(streams)) {
		expect(stream).toContain("\x1b]8;;\x07");
		expect(stream).toEndWith("\x1b[?7h");
	}
});

it("keeps prepared-row reuse byte-identical across viewport and repaint transitions", async () => {
	const source = `
import { CURSOR_MARKER, TUI } from "./src/tui.ts";
class FakeTerminal {
	columns = 12;
	rows = 3;
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
	onPrivateModeReport() {}
}
const scheduler = {
	now: () => 100,
	scheduleImmediate(callback) { callback(); },
	scheduleRender(callback, _delay) { queueMicrotask(callback); return { cancel() {} }; },
};
async function run(stableRows) {
	const terminal = new FakeTerminal();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	let rows = ["zero", "one", "two" + CURSOR_MARKER];
	const content = { render: () => stableRows ? rows : rows.map(row => row.slice()) };
	tui.addChild(content);
	tui.start({ deferInput: true });
	terminal.writes.length = 0;
	const take = () => {
		const result = terminal.writes.join("");
		terminal.writes.length = 0;
		return result;
	};
	tui.requestRender();
	await Promise.resolve();
	const repetition = take();
	terminal.write("\x1b[2J\x1b[H");
	tui.requestRender(true);
	await Promise.resolve();
	const externalClearRepair = take();
	rows = [rows[0], "ONE", rows[2]];
	tui.requestRender();
	await Promise.resolve();
	const singleRowChange = take();
	rows = [...rows, "three"];
	tui.requestRender();
	await Promise.resolve();
	const windowSlide = take();
	terminal.columns = 8;
	tui.resetDisplay();
	const widthChange = take();
	const overlay = { render: () => ["overlay"] };
	const handle = tui.showOverlay(overlay);
	await Promise.resolve();
	const overlayOpen = take();
	handle.hide();
	await Promise.resolve();
	const overlayClose = take();
	return { repetition, externalClearRepair, singleRowChange, windowSlide, widthChange, overlayOpen, overlayClose };
}
console.log(JSON.stringify({ stable: await run(true), rebuilt: await run(false) }));
`;
	const env: Record<string, string | undefined> = { ...Bun.env, PI_NO_SYNC_OUTPUT: "1" };
	for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PI_TUI_SYNC_OUTPUT"]) {
		delete env[key];
	}
	const proc = Bun.spawn({
		cmd: [process.execPath, "--eval", source],
		cwd: import.meta.dir.replace(/\/src$/u, ""),
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
	const streams = JSON.parse(stdout) as {
		stable: Record<string, string>;
		rebuilt: Record<string, string>;
	};
	expect(streams.stable).toEqual(streams.rebuilt);
	expect(streams.stable.repetition).not.toContain("zero");
	expect(streams.stable.repetition).not.toContain("one");
	expect(streams.stable.repetition).not.toContain("two");
	expect(streams.stable.externalClearRepair).toContain("\x1b[2J\x1b[H");
	expect(streams.stable.externalClearRepair).toContain("zero");
	expect(streams.stable.externalClearRepair).toContain("one");
	expect(streams.stable.externalClearRepair).toContain("two");
	for (const key of ["singleRowChange", "windowSlide", "widthChange", "overlayOpen", "overlayClose"]) {
		expect(streams.stable[key]).not.toBe("");
	}
});

it("bounds oversized frame writes without splitting terminal escape sequences", async () => {
	const source = `
import { TUI } from "./src/tui.ts";
class FakeTerminal {
	columns = 5000;
	rows = 1;
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
	onPrivateModeReport() {}
}
const scheduler = {
	now: () => 100,
	scheduleImmediate(callback) { callback(); },
	scheduleRender(callback, _delay) { callback(); return { cancel() {} }; },
};
const terminal = new FakeTerminal();
const tui = new TUI(terminal, false, { renderScheduler: scheduler });
tui.addChild({ render: () => ["\\x1b[31m" + "a".repeat(5000) + "\\x1b[0m"] });
tui.start({ deferInput: true });
console.log(JSON.stringify(terminal.writes));
`;
	const env: Record<string, string | undefined> = { ...Bun.env, PI_NO_SYNC_OUTPUT: "1" };
	for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PI_TUI_SYNC_OUTPUT"]) {
		delete env[key];
	}
	const proc = Bun.spawn({
		cmd: [process.execPath, "--eval", source],
		cwd: import.meta.dir.replace(/\/src$/u, ""),
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
	const writes = JSON.parse(stdout) as string[];
	// One flush per frame: the oversized line reaches the terminal as a single
	// write with its escape sequences and payload intact.
	expect(writes.length).toBe(1);
	expect(writes[0]).toContain(`\x1b[31m${"a".repeat(5000)}\x1b[0m`);
});
