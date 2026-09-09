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
	expect(writes).toHaveLength(1);
	expect(writes[0]).toStartWith("\x1b[?25l\x1b[?2026h\x1b[?7l");
	expect(writes[0]).toEndWith("\x1b[?7h\x1b[?2026l");
});
