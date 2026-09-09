import { expect, it } from "bun:test";

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
	expect(writes.length).toBeGreaterThan(1);
	expect(Math.max(...writes.map(write => write.length))).toBeLessThanOrEqual(1024);
	const stream = writes.join("");
	expect(stream).toContain(`\x1b[31m${"a".repeat(5000)}\x1b[0m`);
});
