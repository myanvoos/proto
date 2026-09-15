import { afterEach, beforeEach, expect, spyOn, test, vi } from "bun:test";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils/env";
import { setKittyProtocolActive } from "./keys";
import { ProcessTerminal } from "./terminal";

const DA1 = "\x1b[?1;2c";

let restoreHeadless: (() => void) | undefined;
let stdoutWrite: { mockRestore(): void } | undefined;

beforeEach(() => {
	const previousHeadless = setTerminalHeadless(false);
	restoreHeadless = () => setTerminalHeadless(previousHeadless);
	setKittyProtocolActive(false);
	stdoutWrite = spyOn(process.stdout, "write").mockReturnValue(true);
});

afterEach(() => {
	stdoutWrite?.mockRestore();
	stdoutWrite = undefined;
	restoreHeadless?.();
	restoreHeadless = undefined;
	setKittyProtocolActive(false);
});

function feed(data: string): void {
	process.stdin.emit("data", data);
}

function startTerminal(onInput: (data: string) => void = () => {}): ProcessTerminal {
	const terminal = new ProcessTerminal();
	terminal.start(onInput, () => {});
	return terminal;
}

test("keeps a settled OSC11 DA1 owner in FIFO order for later private-mode replies", () => {
	const privateModeReports: Array<[number, boolean, boolean]> = [];
	const terminal = new ProcessTerminal();
	terminal.onPrivateModeReport((mode, supported, confirmed = false) => {
		privateModeReports.push([mode, supported, confirmed]);
	});
	terminal.start(
		() => {},
		() => {},
	);

	try {
		// The OSC11 response arrives before its DA1 sentinel. The keyboard DA1,
		// then the late OSC11 DA1, must each consume its own FIFO entry before
		// the positive 2026 report is matched.
		feed("\x1b]11;rgb:ffff/0000/0000\x07");
		feed(DA1);
		feed(DA1);
		feed("\x1b[?2026;1$y");

		expect(privateModeReports).toContainEqual([2026, true, true]);
	} finally {
		terminal.stop();
	}
});

test("tombstones an OSC11 owner when a malformed reply terminates early", () => {
	const privateModeReports: Array<[number, boolean, boolean]> = [];
	const terminal = new ProcessTerminal();
	terminal.onPrivateModeReport((mode, supported, confirmed = false) => {
		privateModeReports.push([mode, supported, confirmed]);
	});
	terminal.start(
		() => {},
		() => {},
	);

	try {
		feed("\x1b]11;not-a-color\x07");
		feed(DA1);
		feed(DA1);
		feed("\x1b[?2026;1$y");

		expect(privateModeReports).toContainEqual([2026, true, true]);
	} finally {
		terminal.stop();
	}
});

test("reprocesses a complete OSC11 reply after a torn reply and clears pending state", () => {
	const reports: Array<"dark" | "light"> = [];
	const input: string[] = [];
	const terminal = new ProcessTerminal();
	terminal.onAppearanceReport(appearance => reports.push(appearance));
	terminal.start(
		data => input.push(data),
		() => {},
	);

	try {
		// Keep the torn prefix and replacement in one stdin burst: the
		// parser must discard the stale prefix and process the newest reply
		// without relying on a wall-clock flush boundary.
		feed("\x1b]11;rgb:ffff/\x1b]11;rgb:0000/ffff/0000\x07");

		expect(reports).toEqual(["light"]);
		expect(input).toEqual([]);

		// A follow-up refresh must not remain queued behind the replaced reply.
		terminal.refreshAppearance();
		feed("\x1b]11;rgb:0000/0000/ffff\x07");
		expect(reports).toEqual(["light", "dark"]);
	} finally {
		terminal.stop();
	}
});

test("replaces a torn OSC11 prefix held while Kitty parsing is active", () => {
	setKittyProtocolActive(true);
	const reports: Array<"dark" | "light"> = [];
	const terminal = new ProcessTerminal();
	terminal.onAppearanceReport(appearance => reports.push(appearance));
	terminal.start(
		() => {},
		() => {},
	);

	try {
		feed("\x1b]11;rgb:ffff/\x1b]11;rgb:0000/ffff/0000\x07");

		expect(reports).toEqual(["light"]);
	} finally {
		terminal.stop();
		setKittyProtocolActive(false);
	}
});

test("replays buffered resize digits before a fresh CSI sequence", () => {
	vi.useFakeTimers();
	const input: string[] = [];
	const terminal = startTerminal(data => input.push(data));

	try {
		feed("\x1b[?2048;1$y");
		feed("\x1b[48;");
		vi.advanceTimersByTime(100);
		feed("123");
		feed("\x1b[A");

		expect(input.join("")).toBe("123\x1b[A");
	} finally {
		terminal.stop();
		vi.useRealTimers();
	}
});

test("watchdog-releases resize digits that never form a report", () => {
	vi.useFakeTimers();
	const input: string[] = [];
	const terminal = startTerminal(data => input.push(data));

	try {
		feed("\x1b[?2048;1$y");
		feed("\x1b[48;");
		vi.advanceTimersByTime(100);
		feed("123");
		vi.advanceTimersByTime(1000);

		expect(input.join("")).toBe("123");
	} finally {
		terminal.stop();
		vi.useRealTimers();
	}
});

test("forwards a split End key through in-band resize parsing", () => {
	vi.useFakeTimers();
	const input: string[] = [];
	const terminal = startTerminal(data => input.push(data));

	try {
		feed("\x1b[?2048;1$y");
		feed("\x1b[4");
		vi.advanceTimersByTime(120);
		feed("~");

		expect(input.join("")).toBe("\x1b[4~");
	} finally {
		terminal.stop();
		vi.useRealTimers();
	}
});

test("replays ordinary input after an invalid in-band resize prefix", () => {
	vi.useFakeTimers();
	const input: string[] = [];
	const terminal = startTerminal(data => input.push(data));

	try {
		feed("\x1b[?2048;1$y");
		feed("\x1b[48;");
		vi.advanceTimersByTime(100);
		feed("123");
		feed("x");

		expect(input.join("")).toBe("123x");
	} finally {
		terminal.stop();
		vi.useRealTimers();
	}
});
