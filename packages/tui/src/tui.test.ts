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

it("drains Kitty image work for direct and overlay writes", async () => {
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

const scheduler = {
	now: () => 100,
	scheduleImmediate(callback) { callback(); },
	scheduleRender(callback) { callback(); return { cancel() {} }; },
};
const theme = { fallbackColor: value => value };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const makeImage = (budget, dimensions = { widthPx: 9, heightPx: 18 }) =>
	new Image(png, "image/png", theme, { budget }, dimensions);

setKittyGraphics({ unicodePlaceholders: false });
setCellDimensions({ widthPx: 1, heightPx: 1 });
const directTerminal = new FakeTerminal();
const directTui = new TUI(directTerminal, false, { renderScheduler: scheduler });
const directImage = makeImage(directTui.imageBudget, { widthPx: 1, heightPx: 1 });
directTui.addChild(directImage);
directTui.start({ deferInput: true });
directTerminal.writes.length = 0;
directTui.clearInlineImages();
directTui.requestDirectWrite(directImage);
const directOutput = directTerminal.writes.join("");

const tallTerminal = new FakeTerminal();
const tallTui = new TUI(tallTerminal, false, { renderScheduler: scheduler });
const tallImage = makeImage(tallTui.imageBudget, { widthPx: 9, heightPx: 18 });
tallTui.addChild(tallImage);
tallTui.start({ deferInput: true });
tallTerminal.writes.length = 0;
tallTui.clearInlineImages();
tallTui.requestDirectWrite(tallImage);
const tallOutput = tallTerminal.writes.join("");

setKittyGraphics({ unicodePlaceholders: true });
const placeholderTerminal = new FakeTerminal();
const placeholderTui = new TUI(placeholderTerminal, false, { renderScheduler: scheduler });
const placeholderImage = makeImage(placeholderTui.imageBudget);
placeholderTui.addChild(placeholderImage);
placeholderTui.start({ deferInput: true });
placeholderTerminal.writes.length = 0;
placeholderTui.clearInlineImages();
placeholderTui.requestDirectWrite(placeholderImage);
const placeholderOutput = placeholderTerminal.writes.join("");

setKittyGraphics({ unicodePlaceholders: false });
const overlayTerminal = new FakeTerminal();
const overlayTui = new TUI(overlayTerminal, false, { renderScheduler: scheduler });
overlayTui.addChild({ render: () => ["base"] });
overlayTui.start({ deferInput: true });
const overlayImage = makeImage(overlayTui.imageBudget);
overlayTerminal.writes.length = 0;
const overlayHandle = overlayTui.showOverlay(overlayImage);
overlayTerminal.writes.length = 0;
overlayTui.requestRender(true);
const persistentOverlayOutput = overlayTerminal.writes.join("");
overlayTerminal.writes.length = 0;
overlayHandle.hide();
overlayTui.requestRender(true);
const hiddenOverlayOutput = overlayTerminal.writes.join("");

const fullscreenTerminal = new FakeTerminal();
const fullscreenTui = new TUI(fullscreenTerminal, false, { renderScheduler: scheduler });
const fullscreenImage = makeImage(fullscreenTui.imageBudget);
fullscreenTui.start({ deferInput: true });
fullscreenTerminal.writes.length = 0;
const fullscreenHandle = fullscreenTui.showOverlay(fullscreenImage, { fullscreen: true });
fullscreenTerminal.writes.length = 0;
fullscreenHandle.hide();
fullscreenTui.requestRender(true);
const fullscreenExitOutput = fullscreenTerminal.writes.join("");

console.log(JSON.stringify({
	directTransmitted: directOutput.includes("a=t,"),
	directPlacement: directOutput.includes("a=p,"),
	tallTransmitted: tallOutput.includes("a=t,"),
	tallPlacement: tallOutput.includes("a=p,"),
	tallPending: tallTui.imageBudget.hasPendingTransmits(),
	directPending: directTui.imageBudget.hasPendingTransmits(),
	placeholderTransmitted: placeholderOutput.includes("a=t,"),
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
		directTransmitted: boolean;
		directPlacement: boolean;
		tallTransmitted: boolean;
		tallPlacement: boolean;
		tallPending: boolean;
		directPending: boolean;
		placeholderTransmitted: boolean;
		persistentOverlayDeletes: boolean;
		hiddenOverlayDeletes: boolean;
		fullscreenExitDeletes: boolean;
	};
	expect(result.directTransmitted).toBe(true);
	expect(result.directPlacement).toBe(true);
	expect(result.tallTransmitted).toBe(true);
	expect(result.tallPlacement).toBe(true);
	expect(result.tallPending).toBe(false);
	expect(result.directPending).toBe(false);
	expect(result.placeholderTransmitted).toBe(true);
	expect(result.persistentOverlayDeletes).toBe(false);
	expect(result.hiddenOverlayDeletes).toBe(true);
});

it("retains both side-by-side Kitty placeholder payloads in a direct write", async () => {
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
tui.requestDirectWrite(chips);
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
	expect(result.ids.length).toBe(2);
	expect(result.transmits).toEqual([result.ids[1]]);
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

it("keeps Herdr frame writes bracketed by DECSET 2026 after an unsupported DECRQM reply", async () => {
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
terminal.callback?.(2026, false, true);
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
	const writes = JSON.parse(stdout) as string[];
	const stream = writes.join("");
	expect(stream).toStartWith("\x1b[?25l\x1b[?2026h\x1b[?7l");
	expect(stream).toEndWith("\x1b[?7h\x1b[?2026l");
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
	expect(streams.initial).toBe(
		"\x1b[?25l\x1b[?7l\x1b[2J\x1b[H\x1b[31mred\x1b[0m\x1b[0m\r\nnormal\x1b[0m\r\n\x1b]8;;https://x\x07link\x1b]8;;\x07\x1b[0m\x1b]8;;\x07\x1b[?25l\x1b[?7h",
	);
	expect(streams.reset).toBe(
		"\x1b[?25l\x1b[?7l\x1b[H\x1b[3J\x1b[32mgreen\x1b[0m\x1b[0m\x1b[K\r\nnormal2\x1b[0m\x1b[K\r\n\x1b]8;;https://x\x07link2\x1b]8;;\x07\x1b[0m\x1b]8;;\x07\x1b[K\x1b[?25l\x1b[?7h",
	);
	expect(streams.update).toBe(
		"\x1b[?25l\x1b[?7l\x1b[2A\r\x1b[33myellow\x1b[0m\x1b[0m\x1b[K\r\nnormal3\x1b[0m\x1b[K\r\n\x1b]8;;https://x\x07link3\x1b]8;;\x07\x1b[0m\x1b]8;;\x07\x1b[K\x1b[?25l\x1b[?7h",
	);
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
	expect(streams.stable.repetition).toBe("");
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
