import { afterEach, beforeEach, expect, spyOn, test, vi } from "bun:test";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils/env";
import { setKittyProtocolActive } from "./keys";
import { ProcessTerminal } from "./terminal";
import { isTerminalFocused, NotifyProtocol, TERMINAL } from "./terminal-capabilities";
import { isInsideTerminalMultiplexer } from "./ttyid";

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

test("headless stop clears callbacks before the terminal is reused", () => {
	setTerminalHeadless(true);
	const stalePrivateModeReports: number[] = [];
	const terminal = new ProcessTerminal();
	terminal.onPrivateModeReport(mode => stalePrivateModeReports.push(mode));
	terminal.start(
		() => {},
		() => {},
	);
	terminal.stop();

	setTerminalHeadless(false);
	terminal.start(
		() => {},
		() => {},
	);
	try {
		feed("\x1b[?2026;1$y");
		expect(stalePrivateModeReports).toEqual([]);
	} finally {
		terminal.stop();
	}
});

test("releases ordinary input when an unterminated OSC11 reply outlives the reply window", () => {
	vi.useFakeTimers();
	const input: string[] = [];
	const terminal = new ProcessTerminal();
	terminal.start(
		data => input.push(data),
		() => {},
	);

	try {
		// A reply torn mid-body and never terminated: StdinBuffer flushes it on
		// its hold timer, the parser buffers it, and ordinary keystrokes must
		// surface again once the buffer outlives the reply window instead of
		// being swallowed for the rest of the session.
		feed("\x1b]11;rgb:ffff/00");
		vi.advanceTimersByTime(500);
		expect(input).toEqual([]);

		vi.advanceTimersByTime(1500);
		feed("q");
		expect(input).toEqual(["q"]);
	} finally {
		terminal.stop();
		vi.useRealTimers();
	}
});

test("releases ordinary input when an unterminated OSC11 reply outgrows the reply bound", () => {
	vi.useFakeTimers();
	const input: string[] = [];
	const reports: Array<"dark" | "light"> = [];
	const terminal = new ProcessTerminal();
	terminal.onAppearanceReport(appearance => reports.push(appearance));
	terminal.start(
		data => input.push(data),
		() => {},
	);

	try {
		// The oversized unterminated reply is one StdinBuffer burst: prefix and
		// trailing keystrokes arrive as a single torn sequence, append, and trip
		// the length bound. The next ordinary keystroke must reach input.
		feed(
			"\x1b]11;rgb:ffff/00xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
		);
		vi.advanceTimersByTime(500);
		expect(input).toEqual([]);

		feed("y");
		expect(input).toEqual(["y"]);

		// The released query must not wedge appearance refreshes either.
		terminal.refreshAppearance();
		feed("\x1b]11;rgb:0000/ffff/0000\x07");
		expect(reports).toEqual(["light"]);
	} finally {
		terminal.stop();
		vi.useRealTimers();
	}
});

test("keeps assembling a genuinely torn OSC11 reply across stdin bursts", () => {
	vi.useFakeTimers();
	const input: string[] = [];
	const reports: Array<"dark" | "light"> = [];
	const terminal = new ProcessTerminal();
	terminal.onAppearanceReport(appearance => reports.push(appearance));
	terminal.start(
		data => input.push(data),
		() => {},
	);

	try {
		// A reply split across two bursts must still assemble and resolve:
		// the stall release must not fire while the reply is still alive.
		feed("\x1b]11;rgb:0000/0");
		feed("000/0000\x07");
		vi.advanceTimersByTime(500);
		expect(reports).toEqual(["dark"]);
		expect(input).toEqual([]);
	} finally {
		terminal.stop();
		vi.useRealTimers();
	}
});

// The OSC99 probe is skipped inside a terminal multiplexer, and CI/dev shells are often running in one
// (tmux, screen, zellij, herdr). Clear those markers for the duration so the test exercises the probe
// rather than silently asserting nothing.
const MULTIPLEXER_ENV_KEYS = [
	"TMUX",
	"STY",
	"ZELLIJ",
	"HERDR_ENV",
	"HERDR_PANE_ID",
	"HERDR_TAB_ID",
	"HERDR_WORKSPACE_ID",
	"CMUX_WORKSPACE_ID",
	"CMUX_SURFACE_ID",
	"CMUX_REMOTE_TRANSPORT",
] as const;

function suppressMultiplexerEnv(): () => void {
	const saved = new Map<string, string | undefined>();
	for (const key of MULTIPLEXER_ENV_KEYS) {
		saved.set(key, Bun.env[key]);
		delete Bun.env[key];
	}
	const savedTerm = Bun.env.TERM;
	Bun.env.TERM = "xterm-256color";
	return () => {
		for (const [key, value] of saved) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		if (savedTerm === undefined) delete Bun.env.TERM;
		else Bun.env.TERM = savedTerm;
	};
}

test("releases ordinary input when an unterminated OSC99 probe reply outgrows the reply bound", () => {
	const previousProtocol = TERMINAL.notifyProtocol;
	const restoreEnv = suppressMultiplexerEnv();
	Bun.env.PI_TUI_OSC99_PROBE = "1";
	(TERMINAL as { notifyProtocol: NotifyProtocol }).notifyProtocol = NotifyProtocol.Osc99;
	vi.useFakeTimers();
	const input: string[] = [];
	const terminal = new ProcessTerminal();
	terminal.start(
		data => input.push(data),
		() => {},
	);

	try {
		// start() probes OSC99 support; an unterminated reply must release the
		// probe (as unsupported) instead of swallowing keystrokes forever. If
		// the probe were never armed, the bursts would surface as input and the
		// first assertion would fail, so this also pins the arming.
		// Longer than OSC99_REPLY_MAX_LENGTH so the length bound, not the time bound, releases the probe.
		feed(`\x1b]99;id=probe;pay${"x".repeat(5_000)}`);
		vi.advanceTimersByTime(500);
		expect(input).toEqual([]);

		feed("z");
		expect(input).toEqual(["z"]);
	} finally {
		terminal.stop();
		vi.useRealTimers();
		(TERMINAL as { notifyProtocol: NotifyProtocol }).notifyProtocol = previousProtocol;
		delete Bun.env.PI_TUI_OSC99_PROBE;
		restoreEnv();
	}
});

const SCRUBBED_ENV = { TERM: "xterm-256color" } as unknown as NodeJS.ProcessEnv;

test("a secondary device attributes reply identifies a multiplexer the environment hides", () => {
	const terminal = startTerminal();
	try {
		expect(isInsideTerminalMultiplexer(SCRUBBED_ENV)).toBe(false);
		// tmux answers DA2 with terminal id 84 ("T") even when it was entered
		// through `env -i`, so TMUX is unset and only the reply can tell.
		feed("\x1b[>84;0;0c");
		expect(isInsideTerminalMultiplexer(SCRUBBED_ENV)).toBe(true);
	} finally {
		terminal.stop();
	}
	expect(isInsideTerminalMultiplexer(SCRUBBED_ENV)).toBe(false);
});

test("an XTVERSION reply identifies a multiplexer the environment hides", () => {
	const terminal = startTerminal();
	try {
		feed("\x1bP>|tmux 3.4\x1b\\");
		expect(isInsideTerminalMultiplexer(SCRUBBED_ENV)).toBe(true);
	} finally {
		terminal.stop();
	}
	feed("\x1bP>|screen\x1b\\");
	expect(isInsideTerminalMultiplexer(SCRUBBED_ENV)).toBe(false);
});

test("a direct terminal identity leaves the direct-terminal resize path in place", () => {
	const terminal = startTerminal();
	try {
		// xterm reports a DEC model number, WezTerm/kitty report their names.
		feed("\x1b[>41;354;0c");
		expect(isInsideTerminalMultiplexer(SCRUBBED_ENV)).toBe(false);
		feed("\x1bP>|WezTerm 20240203\x1b\\");
		expect(isInsideTerminalMultiplexer(SCRUBBED_ENV)).toBe(false);
	} finally {
		terminal.stop();
	}
});

test("host identity queries go out on attach and their replies never reach input", () => {
	const input: string[] = [];
	const wasTTY = process.stdout.isTTY;
	// #safeWrite only reaches a tty; fake one so the probe bytes are observable.
	(process.stdout as unknown as { isTTY: boolean }).isTTY = true;
	const terminal = startTerminal(data => input.push(data));
	try {
		const written = (stdoutWrite as unknown as { mock: { calls: unknown[][] } }).mock.calls
			.map(call => String(call[0]))
			.join("");
		expect(written).toContain("\x1b[>0q");
		expect(written).toContain("\x1b[>c");
		feed("\x1bP>|tmux 3.4\x1b\\");
		feed("\x1b[>84;0;0c");
		expect(input.join("")).toBe("");
	} finally {
		terminal.stop();
		(process.stdout as unknown as { isTTY: boolean }).isTTY = wasTTY;
	}
});

test("DEC 1004 focus reports drive focus state and never reach input", () => {
	const input: string[] = [];
	const wasTTY = process.stdout.isTTY;
	(process.stdout as unknown as { isTTY: boolean }).isTTY = true;
	const terminal = startTerminal(data => input.push(data));
	try {
		const written = (stdoutWrite as unknown as { mock: { calls: unknown[][] } }).mock.calls
			.map(call => String(call[0]))
			.join("");
		expect(written).toContain("\x1b[?1004h");

		// Nothing reported yet: focus is unknown, not "focused".
		expect(isTerminalFocused()).toBeUndefined();

		feed("\x1b[O");
		expect(isTerminalFocused()).toBe(false);
		feed("\x1b[I");
		expect(isTerminalFocused()).toBe(true);

		// Focus reports are unsolicited CSI; they must not be typed as keys.
		expect(input.join("")).toBe("");

		feed("hello");
		expect(input.join("")).toBe("hello");
	} finally {
		terminal.stop();
		(process.stdout as unknown as { isTTY: boolean }).isTTY = wasTTY;
	}
});

test("focus reporting is disabled and forgotten when the terminal stops", () => {
	const wasTTY = process.stdout.isTTY;
	(process.stdout as unknown as { isTTY: boolean }).isTTY = true;
	const terminal = startTerminal();
	try {
		feed("\x1b[I");
		expect(isTerminalFocused()).toBe(true);
	} finally {
		terminal.stop();
		(process.stdout as unknown as { isTTY: boolean }).isTTY = wasTTY;
	}
	const written = (stdoutWrite as unknown as { mock: { calls: unknown[][] } }).mock.calls
		.map(call => String(call[0]))
		.join("");
	expect(written).toContain("\x1b[?1004l");
	// A stale "focused" must not survive into the next terminal.
	expect(isTerminalFocused()).toBeUndefined();
});
