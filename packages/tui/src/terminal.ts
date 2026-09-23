import * as fs from "node:fs";
import { TtyWriter } from "@oh-my-pi/pi-natives";
import { stripControlChars } from "@oh-my-pi/pi-utils";
import { $env, isBunTestRuntime, isTerminalHeadless } from "@oh-my-pi/pi-utils/env";
import * as logger from "@oh-my-pi/pi-utils/logger";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { restoreTerminalStderr, suppressTerminalStderr } from "@oh-my-pi/pi-utils/stderr-guard";
import { setKittyProtocolActive } from "./keys";
import { StdinBuffer } from "./stdin-buffer";
import {
	clearTerminalFocusTracking,
	isInsideTerminalMultiplexer,
	NotifyProtocol,
	setCellDimensions,
	setOsc99Supported,
	setOutboundWriter,
	setTerminalFocused,
	TERMINAL,
} from "./terminal-capabilities";
import { isInsideTmux, wrapTmuxPassthrough } from "./tmux";
import { getReportedTerminalHostIdentity, setReportedTerminalHostIdentity } from "./ttyid";
import { setHangulCompatibilityJamoWidth } from "./utils";

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
/** XTVERSION then secondary device attributes: whichever the host answers names it. */
const HOST_IDENTITY_QUERY = "\x1b[>0q\x1b[>c";
const HOST_IDENTITY_REPROBE_MS = 1000;
let hostIdentityProbedAt = 0;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const IN_BAND_RESIZE_WATCHDOG_MS = 1000;
const IN_BAND_RESIZE_PREFIX = "\x1b[48;";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0;\x07";
function shouldEnableModifyOtherKeysFallback(env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (!env.SSH_CONNECTION && !env.SSH_TTY && !env.SSH_CLIENT) return true;
	return TERMINAL.id !== "base" && TERMINAL.id !== "trueColor";
}

/**
 * Backlog ceiling that arms the stall watchdog. A live terminal keeps this near
 * zero; crossing it means either a wedged PTY reader or a single legitimately
 * huge frame (a resumed transcript repainting many inline images). The two are
 * told apart by {@link StdoutStallWatchdog} drain progress, not this number.
 */
const MAX_STDOUT_BACKLOG_BYTES = 64 * 1024 * 1024;

/**
 * Backlog at or below which stdout is healthy again: the TUI resumes composing
 * frames and a {@link StdoutStallWatchdog} episode ends. The TUI render gate uses
 * this same value, so the watchdog stays armed across the entire range where
 * frames are deferred — a consumer that wedges between this level and the arm
 * cap is still re-sampled instead of freezing the session.
 */
export const STDOUT_BACKLOG_CLEAR_BYTES = 256 * 1024;

/**
 * How long an armed backlog may go without drain progress before the consumer
 * is declared gone. A slow-but-alive terminal keeps reaching new low-water
 * marks; a wedged one that flushes nothing is torn down within this window.
 */
const STDOUT_STALL_TIMEOUT_MS = 2_000;

/** Cadence at which {@link ProcessTerminal} re-samples the backlog while an episode is armed. */
const STDOUT_STALL_POLL_MS = 250;

/** A capability reply (OSC 11/OSC 99) that has not terminated within this
 * window is abandoned: a torn reply must not swallow ordinary input. */
const OSC_REPLY_TIMEOUT_MS = 1000;
const OSC11_REPLY_MAX_LENGTH = 128;
const OSC99_REPLY_MAX_LENGTH = 4096;

/**
 * Bounds a never-draining stdout backlog without killing a single large but
 * actively draining frame.
 *
 * A stalled-but-alive PTY reader never throws, so the pending byte count is the
 * only signal that output is going nowhere — but tripping on the instantaneous
 * count kills a legitimate oversized frame that would drain. An episode starts
 * when the backlog first exceeds `armBytes` and lasts until it drains back to
 * `clearBytes`; during it the terminal is declared disconnected only when the
 * backlog reaches no new low-water mark for `stallMs`.
 *
 * Exported for unit testing; `ProcessTerminal` is the sole production user.
 */
export class StdoutStallWatchdog {
	#lowWater = Number.POSITIVE_INFINITY;
	#stalledSinceMs = 0;
	#armed = false;

	constructor(
		private readonly armBytes: number = MAX_STDOUT_BACKLOG_BYTES,
		private readonly clearBytes: number = STDOUT_BACKLOG_CLEAR_BYTES,
		private readonly stallMs: number = STDOUT_STALL_TIMEOUT_MS,
	) {}

	/** True while an episode is active and the backlog must be polled to completion. */
	get armed(): boolean {
		return this.#armed;
	}

	/**
	 * Feed the current pending-byte count and clock reading. Returns true once an
	 * armed episode has gone `stallMs` with no drain progress.
	 */
	sample(pending: number, nowMs: number): boolean {
		if (!this.#armed) {
			if (pending <= this.armBytes) return false;
			this.#armed = true;
			this.#lowWater = pending;
			this.#stalledSinceMs = nowMs;
			return false;
		}
		if (pending <= this.clearBytes) {
			this.reset();
			return false;
		}
		if (pending < this.#lowWater) {
			// Drain progress: a new low-water mark restarts the stall clock.
			this.#lowWater = pending;
			this.#stalledSinceMs = nowMs;
			return false;
		}
		return nowMs - this.#stalledSinceMs >= this.stallMs;
	}

	/** Episode ended (drained) or terminal torn down: stop watching. */
	reset(): void {
		this.#armed = false;
		this.#lowWater = Number.POSITIVE_INFINITY;
		this.#stalledSinceMs = 0;
	}
}

let activeTerminal: ProcessTerminal | null = null;

let terminalEverStarted = false;
// Set only after ProcessTerminal.stop() has completed every restoration write.
// A missing active terminal is otherwise ambiguous: it can be a clean stop or
// a crash path that still needs the emergency fallback sequence.
let terminalCleanlyStopped = false;

let altScreenActive = false;
let terminalRestoreRegistered = false;

function registerPostmortemTerminalRestore(): void {
	if (terminalRestoreRegistered) return;
	terminalRestoreRegistered = true;
	postmortem.register("terminal-restore", () => {
		emergencyTerminalRestore();
	});
}

export function setAltScreenActive(active: boolean): void {
	altScreenActive = active;
}

export function writeThroughActiveTerminal(data: string): boolean {
	if (!activeTerminal) return false;
	activeTerminal.write(data);
	return true;
}

const stdoutErrorHandlers = new Set<(err: Error) => void>();
let stdoutErrorListenerInstalled = false;

function onStdoutError(err: Error): void {
	for (const handler of stdoutErrorHandlers) handler(err);
}

function writeOutboundViaActiveTerminal(data: string): void {
	if (!writeThroughActiveTerminal(data)) process.stdout.write(data);
}

function registerStdoutErrorHandler(handler: (err: Error) => void): () => void {
	stdoutErrorHandlers.add(handler);
	if (!stdoutErrorListenerInstalled) {
		process.stdout.on("error", onStdoutError);
		stdoutErrorListenerInstalled = true;
	}
	return () => {
		stdoutErrorHandlers.delete(handler);
	};
}

/**
 * Re-ask a host that has not named itself yet. Startup answers arrive in
 * milliseconds, but a terminal that resizes before the reply — or an app whose
 * input was attached late — would otherwise run a whole resize burst against
 * the environment's word alone. One extra query per second costs nothing and
 * lands long before the settled repaint that depends on the answer.
 */
export function refreshTerminalHostIdentity(now: number = Date.now()): void {
	if (getReportedTerminalHostIdentity() !== null) return;
	if (now - hostIdentityProbedAt < HOST_IDENTITY_REPROBE_MS) return;
	hostIdentityProbedAt = now;
	activeTerminal?.write(HOST_IDENTITY_QUERY);
}

export function emergencyTerminalRestore(): void {
	try {
		restoreTerminalStderr();
		const terminal = activeTerminal;
		if (terminal) {
			if (altScreenActive) {
				const keyboardExit =
					terminal.keyboardEnhancementExitSequence ?? (terminal.kittyEnableSequence ? "\x1b[<u" : "");
				terminal.write(`${keyboardExit}\x1b[?1049l`);
				altScreenActive = false;
			}
			terminal.stop();
			terminal.showCursor(true);
		} else if (terminalEverStarted && !terminalCleanlyStopped && !isTerminalHeadless()) {
			process.stdout.write(
				"\x1b[?2026l" +
					"\x1b[?7h" +
					"\x1b[?1l\x1b>" +
					"\x1b[?2004l" +
					"\x1b[?2031l" +
					"\x1b[?2048l" +
					"\x1b[?5522l" +
					"\x1b[<u" +
					"\x1b[>4;0m" +
					"\x1b[?1006l\x1b[?1003l\x1b[?1000l" +
					(altScreenActive ? "\x1b[?1049l\x1b[?1l\x1b>\x1b[<u" : "") +
					"\x1b[?25h",
			);
			altScreenActive = false;
			if (process.stdin.setRawMode) {
				process.stdin.setRawMode(false);
			}
		}
	} catch {}
}

export type TerminalAppearance = "dark" | "light";

export interface TerminalStartOptions {
	deferInput?: boolean;
}

export type TerminalAppearanceRequestToken = number;
/**
 * Fired once per DEC private mode when DECRQM support resolves. `confirmed` is
 * false when only the DA1 sentinel arrived. `status` is the DECRPM value
 * (0 unrecognized, 1/2 set/reset, 3 permanently set, 4 permanently reset) when
 * the terminal answered DECRQM.
 */
export type PrivateModeReportHandler = (mode: number, supported: boolean, confirmed?: boolean, status?: number) => void;

export interface Terminal {
	start(
		onInput: (data: string) => void,
		onResize: () => void,
		onDisconnect?: () => void,
		options?: TerminalStartOptions,
	): void;

	enableInput?(): void;

	stop(): void;

	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	write(data: string): void;

	get columns(): number;
	get rows(): number;

	/**
	 * Re-read the window size from the OS now, without waiting for SIGWINCH to
	 * reach the event loop. When it changed, dispatch the resize callback before
	 * returning true.
	 */
	refreshSize?(): boolean;

	readonly pendingOutputBytes?: number;

	get kittyProtocolActive(): boolean;

	get kittyEnableSequence(): string | null;

	readonly keyboardEnhancementEnterSequence?: string | null;

	readonly keyboardEnhancementExitSequence?: string | null;

	moveBy(lines: number): void;

	hideCursor(force?: boolean): void;
	showCursor(force?: boolean): void;

	clearLine(): void;
	clearFromCursor(): void;
	clearScreen(): void;

	setTitle(title: string): void;

	setProgress(active: boolean): void;

	onAppearanceChange(
		callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void,
	): void;

	onAppearanceReport?(
		callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void,
	): (() => void) | void;

	refreshAppearance?(requestToken?: TerminalAppearanceRequestToken): TerminalAppearanceRequestToken | void;

	get appearance(): TerminalAppearance | undefined;

	onPrivateModeReport?(callback: PrivateModeReportHandler): void;

	/**
	 * Ask the terminal where its cursor is (CPR, `CSI 6 n`). Resolves with the
	 * zero-based screen position, or `undefined` when the terminal answers the
	 * DA1 sentinel first (no CPR support) or the terminal goes away.
	 */
	queryCursorPosition?(): Promise<TerminalCursorPosition | undefined>;
}

export interface TerminalCursorPosition {
	row: number;
	col: number;
}

type Da1SentinelOwner =
	| { kind: "keyboard" }
	| { kind: "osc11" }
	| { kind: "privateMode"; mode: number }
	| { kind: "osc99Probe"; id: string }
	| { kind: "cursorPosition"; resolve: (position: TerminalCursorPosition | undefined) => void }
	| { kind: "cursorPositionSettled" };

let nextOsc99ProbeId = 1;

function parseOsc99KeyValues(section: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const part of section.split(":")) {
		const eq = part.indexOf("=");
		if (eq !== 1) continue;
		values.set(part.slice(0, eq), part.slice(eq + 1));
	}
	return values;
}
const XTERM_SCROLL_TO_BOTTOM_MODES = [1010, 1011] as const;
type Osc11QueryRoute = "direct" | "tmux";
const TMUX_OSC11_CACHE_REFRESH_DELAY_MS = 100;

function isXtermScrollToBottomMode(mode: number): boolean {
	return mode === 1010 || mode === 1011;
}

function isPrivateModeSet(status: string): boolean {
	return status === "1" || status === "3";
}

function isPrivateModeSupported(status: string): boolean {
	return status !== "0" && status !== "4";
}

export class ProcessTerminal implements Terminal {
	#wasRaw = false;
	#inputHandler?: (data: string) => void;
	#resizeHandler?: () => void;

	#inputDeferred = false;
	#stdoutResizeListener?: () => void;
	#kittyProtocolActive = false;
	#kittyEnableSeq: string | null = null;
	#modifyOtherKeysActive = false;
	#modifyOtherKeysTimeout?: Timer;
	#stdinBuffer?: StdinBuffer;
	#stdinDataHandler?: (data: string) => void;
	#disconnectHandler?: () => void;
	#stdinEndHandler = () => {
		this.#markTerminalDisconnected("stdin ended");
	};
	#stdinCloseHandler = () => {
		this.#markTerminalDisconnected("stdin closed");
	};
	#stdinErrorHandler = (err: Error) => {
		this.#markTerminalDisconnected("stdin failed", err);
	};
	#dead = false;
	#active = false;

	#cursorVisible: boolean | undefined;

	#headless = isTerminalHeadless();
	#writeLogPath = $env.PI_TUI_WRITE_LOG || "";
	#stdoutErrorCleanup?: () => void;
	#stdoutErrorHandler = (err: Error) => {
		this.#markTerminalDisconnected("stdout failed", err);
	};

	// Bounds the stdout backlog against a stalled PTY consumer without killing a
	// single large-but-draining frame. See StdoutStallWatchdog.
	#stdoutStall = new StdoutStallWatchdog();
	#stdoutStallTimer?: Timer;

	#outputPump?: TtyWriter;

	#xtermScrollToBottomRestoreModes = new Set<number>();
	#appearanceCallbacks: Array<
		(appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void
	> = [];
	#appearanceReportCallbacks: Array<
		(appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void
	> = [];
	#appearance: TerminalAppearance | undefined;
	#osc11Pending = false;
	#osc11ActiveToken?: TerminalAppearanceRequestToken;
	#osc11QueuedQuery?: { route: Osc11QueryRoute; token?: TerminalAppearanceRequestToken };
	#nextAppearanceRequestToken = 1;
	#osc11ResponseBuffer = "";
	#osc11ResponseStartedAt = 0;
	#osc11TmuxRefreshTimer?: Timer;
	#osc99PendingId: string | undefined;
	#osc99ResponseBuffer = "";
	#osc99ResponseStartedAt = 0;
	#osc99Capabilities = new Map<string, string>();
	#privateCsiResponseBuffer = "";
	#cursorPositionResponseBuffer = "";
	#da1SentinelOwners: Da1SentinelOwner[] = [];

	#privateModeSupport = new Map<number, boolean>();
	#privateModeCallbacks: PrivateModeReportHandler[] = [];

	#inBandResizeActive = false;
	#inBandResizeWatchdog?: Timer;

	#inBandResizeBuffer = "";
	#reportedColumns?: number;
	#reportedRows?: number;
	#mode2031DebounceTimer?: Timer;
	#progressTimer?: Timer;

	get kittyProtocolActive(): boolean {
		return this.#kittyProtocolActive;
	}

	get kittyEnableSequence(): string | null {
		return this.#kittyProtocolActive ? this.#kittyEnableSeq : null;
	}

	get keyboardEnhancementEnterSequence(): string | null {
		if (this.#kittyProtocolActive) return this.#kittyEnableSeq;
		return this.#modifyOtherKeysActive ? "\x1b[>4;2m" : null;
	}

	get keyboardEnhancementExitSequence(): string | null {
		return this.#kittyProtocolActive ? "\x1b[<u" : null;
	}

	get appearance(): TerminalAppearance | undefined {
		return this.#appearance;
	}

	onAppearanceChange(
		callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void,
	): void {
		this.#appearanceCallbacks.push(callback);

		if (this.#appearance) {
			try {
				callback(this.#appearance);
			} catch {}
		}
	}

	onAppearanceReport(
		callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void,
	): () => void {
		this.#appearanceReportCallbacks.push(callback);
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			const index = this.#appearanceReportCallbacks.indexOf(callback);
			if (index !== -1) this.#appearanceReportCallbacks.splice(index, 1);
		};
	}

	refreshAppearance(requestToken?: TerminalAppearanceRequestToken): TerminalAppearanceRequestToken | void {
		if (!this.#active || this.#headless || this.#dead) return;
		const token = requestToken ?? this.#nextAppearanceRequestToken++;
		if (token >= this.#nextAppearanceRequestToken) {
			this.#nextAppearanceRequestToken = token + 1;
		}
		this.#queryBackgroundColor(isInsideTmux() ? "tmux" : "direct", token);
		return token;
	}

	onPrivateModeReport(callback: PrivateModeReportHandler): void {
		this.#privateModeCallbacks.push(callback);
	}

	start(
		onInput: (data: string) => void,
		onResize: () => void,
		onDisconnect?: () => void,
		options?: TerminalStartOptions,
	): void {
		this.#inputHandler = onInput;
		this.#resizeHandler = onResize;
		this.#disconnectHandler = onDisconnect;

		this.#cursorVisible = undefined;

		this.#headless = isTerminalHeadless();
		if (this.#headless) return;
		terminalCleanlyStopped = false;
		registerPostmortemTerminalRestore();

		activeTerminal = this;
		terminalEverStarted = true;
		setOutboundWriter(writeOutboundViaActiveTerminal);

		if (process.stdout.isTTY && !isBunTestRuntime() && !this.#outputPump) {
			try {
				this.#outputPump = new TtyWriter(1);
			} catch (err) {
				logger.debug("tty output pump unavailable; using direct stdout writes", { err: String(err) });
			}
		}

		suppressTerminalStderr();

		this.#stdoutResizeListener = () => {
			this.#cursorVisible = undefined;
			this.#reconcileInBandGeometryOnResize();
			this.#resizeHandler?.();
		};
		process.stdout.on("resize", this.#stdoutResizeListener);

		process.kill(process.pid, "SIGWINCH");

		setHangulCompatibilityJamoWidth(TERMINAL.hangulJamoWidth);

		if (options?.deferInput) {
			this.#inputDeferred = true;
			return;
		}
		this.#attachInput();
	}

	enableInput(): void {
		if (!this.#inputDeferred) return;
		this.#inputDeferred = false;
		if (this.#headless || this.#dead) return;
		this.#attachInput();
	}

	#attachInput(): void {
		this.#wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			try {
				process.stdin.setRawMode(true);
			} catch (err) {
				this.#markTerminalDisconnected("stdin raw mode setup failed", err);
				return;
			}
		}
		process.stdin.setEncoding("utf8");
		process.stdin.on("end", this.#stdinEndHandler);
		process.stdin.on("close", this.#stdinCloseHandler);
		process.stdin.on("error", this.#stdinErrorHandler);
		process.stdin.resume();

		this.#safeWrite("\x1b[?2004h");

		// DEC 1004 focus reporting: hosts that ignore it simply never reply, and
		// focus stays unknown rather than being assumed.
		this.#safeWrite("\x1b[?1004h");

		this.#safeWrite("\x1b[?1l\x1b>");

		this.#queryAndEnableKittyProtocol();

		this.#queryTerminalHostIdentity();

		this.#active = true;

		this.#queryBackgroundColor();

		this.#queryOsc99Support();

		this.#safeWrite("\x1b[?2031h");

		this.#queryPrivateMode(2026);
		this.#queryPrivateMode(2048);
		this.#queryPrivateMode(2031);
		// Bracketed paste is queried only to confirm the terminal brackets pastes;
		// once confirmed, StdinBuffer's unbracketed raw-paste heuristic is off.
		this.#queryPrivateMode(2004);
		for (const mode of XTERM_SCROLL_TO_BOTTOM_MODES) {
			this.#queryPrivateMode(mode);
		}
	}

	#setupStdinBuffer(): void {
		this.#stdinBuffer = new StdinBuffer({ timeout: 50 });

		const kittyResponsePattern = /^\x1b\[\?(\d+)u$/;

		const appearanceDsrPattern = /^\x1b\[\?997;([12])n$/;

		// The trailing alpha channel is optional: WezTerm/rxvt reply rgba:R/G/B/A.
		const osc11ResponsePattern =
			/^\x1b\]11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\/[0-9a-fA-F]{1,4})?(?:\x07|\x1b\\)$/;

		const da1ResponsePattern = /^\x1b\[\?[\d;]*c$/;

		const privateCsiPartialPattern = /^\x1b\[\?[\d;]*[\x20-\x2f]*$/;

		const decrpmResponsePattern = /^\x1b\[\?(\d+);(\d+)\$y$/;

		// XTVERSION (`DCS > | name ST`) and secondary device attributes
		// (`CSI > id ; version ; keyboard c`) both name the host that owns this
		// tty, whatever the environment claims.
		const xtversionResponsePattern = /^\x1bP>\|([^\x1b\x07]*)(?:\x1b\\|\x07)$/;
		const secondaryDaResponsePattern = /^\x1b\[>(\d*)(?:;[\d;]*)?c$/;

		const inBandResizePattern = /^\x1b\[48;(\d+)(?::[\d:]*)?;(\d+)(?::[\d:]*)?;(\d+)(?::[\d:]*)?;(\d+)(?::[\d:]*)?t$/;

		const cursorPositionPattern = /^\x1b\[(\d+);(\d+)R$/;
		const cursorPositionPartialPattern = /^\x1b\[[\d;]*$/;

		this.#stdinBuffer.on("data", (sequence: string) => {
			const noPendingReply =
				this.#privateCsiResponseBuffer.length === 0 &&
				this.#inBandResizeBuffer.length === 0 &&
				this.#cursorPositionResponseBuffer.length === 0 &&
				this.#osc11ResponseBuffer.length === 0 &&
				this.#osc99ResponseBuffer.length === 0;
			if (noPendingReply) {
				// DEC 1004 focus reports are unsolicited CSI I / CSI O; without
				// this they reach #inputHandler and are typed as stray keys.
				if (sequence === FOCUS_IN || sequence === FOCUS_OUT) {
					setTerminalFocused(sequence === FOCUS_IN);
					return;
				}
				if (sequence.length === 0 || sequence.charCodeAt(0) !== 0x1b) {
					if (this.#inputHandler) {
						this.#inputHandler(sequence);
					}
					return;
				}
			}

			if (this.#privateCsiResponseBuffer || privateCsiPartialPattern.test(sequence)) {
				if (this.#privateCsiResponseBuffer && sequence.startsWith("\x1b")) {
					this.#privateCsiResponseBuffer = "";
				} else {
					this.#privateCsiResponseBuffer += sequence;

					if (this.#privateCsiResponseBuffer.length > 256) {
						this.#privateCsiResponseBuffer = "";
						return;
					}
					const lastChar = this.#privateCsiResponseBuffer.at(-1)!;
					const lastCode = lastChar.charCodeAt(0);
					if (lastCode >= 0x40 && lastCode <= 0x7e) {
						sequence = this.#privateCsiResponseBuffer;
						this.#privateCsiResponseBuffer = "";
					} else if (!privateCsiPartialPattern.test(this.#privateCsiResponseBuffer)) {
						this.#privateCsiResponseBuffer = "";
						return;
					} else {
						return;
					}
				}
			}

			const inBandResizePartialPattern = /^\x1b\[4[\d;:]*$/;
			const isInBandResizePartial = this.#inBandResizeActive && inBandResizePartialPattern.test(sequence);
			let abandonedInBandResize: string | undefined;
			if (this.#inBandResizeBuffer && sequence.startsWith("\x1b")) {
				const stale = this.#inBandResizeBuffer;
				this.#inBandResizeBuffer = "";
				this.#clearInBandResizeWatchdog();
				// A new partial CSI replaces the stale resize prefix, but the
				// ordinary-looking bytes accumulated after that prefix must not
				// be lost. Replay them before holding the new sequence.
				if (isInBandResizePartial) {
					this.#releaseInBandResizeSuffix(stale);
					this.#inBandResizeBuffer = sequence;
					this.#armInBandResizeWatchdog();
					return;
				}
				// A fresh complete escape likewise abandons the stale prefix,
				// while the fresh sequence continues through normal parsing.
				this.#releaseInBandResizeSuffix(stale);
			} else if (this.#inBandResizeBuffer || isInBandResizePartial) {
				this.#inBandResizeBuffer += sequence;
				if (this.#inBandResizeBuffer.length > 256) {
					abandonedInBandResize = this.#inBandResizeBuffer;
					this.#inBandResizeBuffer = "";
					this.#clearInBandResizeWatchdog();
				} else {
					const lastCode = this.#inBandResizeBuffer.charCodeAt(this.#inBandResizeBuffer.length - 1);
					if (lastCode >= 0x40 && lastCode <= 0x7e) {
						abandonedInBandResize = this.#inBandResizeBuffer;
						sequence = this.#inBandResizeBuffer;
						this.#inBandResizeBuffer = "";
						this.#clearInBandResizeWatchdog();
					} else if (!inBandResizePartialPattern.test(this.#inBandResizeBuffer)) {
						// The accumulated bytes are a torn report prefix (they
						// began with ESC): abandon only that prefix and replay the
						// typed suffix as ordinary input.
						abandonedInBandResize = this.#inBandResizeBuffer;
						this.#inBandResizeBuffer = "";
						this.#clearInBandResizeWatchdog();
					} else {
						this.#armInBandResizeWatchdog();
						return;
					}
				}
			}

			const resizeMatch = sequence.match(inBandResizePattern);
			if (resizeMatch) {
				this.#handleInBandResizeReport(resizeMatch[1]!, resizeMatch[2]!, resizeMatch[3]!, resizeMatch[4]!);
				return;
			}
			if (abandonedInBandResize !== undefined) {
				sequence = abandonedInBandResize.startsWith(IN_BAND_RESIZE_PREFIX)
					? abandonedInBandResize.slice(IN_BAND_RESIZE_PREFIX.length)
					: abandonedInBandResize;
			}

			if (this.#hasPendingCursorPositionQuery()) {
				const isPartial = cursorPositionPartialPattern.test(sequence);
				if (this.#cursorPositionResponseBuffer && sequence.startsWith("\x1b")) {
					this.#cursorPositionResponseBuffer = isPartial ? sequence : "";
					if (isPartial) return;
				} else if (this.#cursorPositionResponseBuffer || isPartial) {
					this.#cursorPositionResponseBuffer += sequence;
					if (this.#cursorPositionResponseBuffer.length > 64) {
						this.#cursorPositionResponseBuffer = "";
						return;
					}
					const lastCode = this.#cursorPositionResponseBuffer.charCodeAt(
						this.#cursorPositionResponseBuffer.length - 1,
					);
					if (lastCode >= 0x40 && lastCode <= 0x7e) {
						sequence = this.#cursorPositionResponseBuffer;
						this.#cursorPositionResponseBuffer = "";
					} else if (!cursorPositionPartialPattern.test(this.#cursorPositionResponseBuffer)) {
						this.#cursorPositionResponseBuffer = "";
						return;
					} else {
						return;
					}
				}
				const cursorMatch = sequence.match(cursorPositionPattern);
				if (cursorMatch) {
					this.#resolveCursorPositionQuery({
						row: Math.max(0, parseInt(cursorMatch[1]!, 10) - 1),
						col: Math.max(0, parseInt(cursorMatch[2]!, 10) - 1),
					});
					return;
				}
			}

			const decrpmMatch = sequence.match(decrpmResponsePattern);
			if (decrpmMatch) {
				this.#handlePrivateModeReport(parseInt(decrpmMatch[1]!, 10), decrpmMatch[2]!);
				return;
			}

			const xtversionMatch = sequence.match(xtversionResponsePattern);
			if (xtversionMatch) {
				this.#handleHostIdentityReport(xtversionMatch[1]!);
				return;
			}

			const secondaryDaMatch = sequence.match(secondaryDaResponsePattern);
			if (secondaryDaMatch) {
				this.#handleSecondaryDeviceAttributes(secondaryDaMatch[1]!);
				return;
			}

			if (da1ResponsePattern.test(sequence)) {
				const owner = this.#da1SentinelOwners.shift();
				if (!owner) {
					return;
				}
				switch (owner.kind) {
					case "osc11": {
						if (this.#osc11Pending) {
							this.#osc11Pending = false;
							this.#osc11ActiveToken = undefined;
							this.#osc11ResponseBuffer = "";
						}

						if (
							this.#osc11QueuedQuery !== undefined &&
							!this.#osc11Pending &&
							!this.#da1SentinelOwners.some(o => o.kind === "osc11") &&
							!this.#dead
						) {
							const query = this.#osc11QueuedQuery;
							this.#osc11QueuedQuery = undefined;
							this.#startOsc11Query(query.route, query.token);
						}
						break;
					}
					case "privateMode": {
						this.#resolvePrivateMode(owner.mode, false, false);
						break;
					}
					case "keyboard": {
						if (this.#modifyOtherKeysTimeout) {
							clearTimeout(this.#modifyOtherKeysTimeout);
							this.#modifyOtherKeysTimeout = undefined;
						}
						this.#enableModifyOtherKeysFallback();
						break;
					}
					case "osc99Probe": {
						this.#resolveOsc99Support(owner.id, false);
						break;
					}
					case "cursorPosition": {
						owner.resolve(undefined);
						break;
					}
					case "cursorPositionSettled":
						break;
				}
				return;
			}

			const match = sequence.match(kittyResponsePattern);
			if (match) {
				if (this.#modifyOtherKeysTimeout) {
					clearTimeout(this.#modifyOtherKeysTimeout);
					this.#modifyOtherKeysTimeout = undefined;
				}

				if (this.#modifyOtherKeysActive) {
					this.#safeWrite("\x1b[>4;0m");
					this.#modifyOtherKeysActive = false;
				}

				const reportedFlags = parseInt(match[1]!, 10);
				this.#kittyProtocolActive = true;
				setKittyProtocolActive(true);
				if ((reportedFlags & 2) !== 0) {
					this.#kittyEnableSeq = "\x1b[>7u";
					this.#safeWrite(this.#kittyEnableSeq);
				} else {
					this.#kittyEnableSeq = "\x1b[>5u";
					this.#safeWrite(this.#kittyEnableSeq);
				}
				return;
			}

			if (this.#osc11Pending && (this.#osc11ResponseBuffer || sequence.startsWith("\x1b]11;"))) {
				const osc11Start = "\x1b]11;";
				const replacementStart = sequence.indexOf(osc11Start, osc11Start.length);
				if (replacementStart !== -1) {
					// StdinBuffer may hold a torn reply while Kitty parsing is
					// active, then emit the stale prefix and its replacement as
					// one sequence. Keep only the newest OSC11 reply.
					this.#osc11ResponseBuffer = "";
					sequence = sequence.slice(replacementStart);
				}
				if (this.#osc11ResponseBuffer && sequence.startsWith("\x1b") && sequence !== "\x1b\\") {
					// A fresh ESC-starting sequence replaces a torn OSC11 reply.
					// Clear only the stale prefix, then process this sequence
					// through the normal OSC11 parser below.
					this.#osc11ResponseBuffer = "";
				}
				if (
					this.#osc11ResponseBuffer &&
					this.#replyBufferStalled(
						this.#osc11ResponseStartedAt,
						this.#osc11ResponseBuffer.length,
						OSC11_REPLY_MAX_LENGTH,
					)
				) {
					// An unterminated torn reply must not wedge the parser either: once
					// the buffer outlives the reply window, release the query and fall
					// through so ordinary keystrokes reach the input handler instead
					// of feeding the wedge.
					this.#abandonOsc11Query();
				}
				if (this.#osc11ResponseBuffer || sequence.startsWith("\x1b]11;")) {
					if (this.#osc11ResponseBuffer === "") this.#osc11ResponseStartedAt = Date.now();
					this.#osc11ResponseBuffer += sequence;
					const osc11Match = this.#osc11ResponseBuffer.match(osc11ResponsePattern);
					if (!osc11Match) {
						// A terminated but malformed reply must not wedge the parser:
						// drop it and release ordinary input instead of buffering on.
						if (/(\x07|\x1b\\)$/.test(this.#osc11ResponseBuffer)) {
							this.#abandonOsc11Query();
						}
						return;
					}
					const [, rHex, gHex, bHex] = osc11Match;
					this.#osc11Pending = false;
					const requestToken = this.#osc11ActiveToken;
					this.#osc11ActiveToken = undefined;
					this.#osc11ResponseBuffer = "";
					// A terminal that answers OSC11 but has not replied to the
					// DA1 sentinel may still send that sentinel later. Tombstone
					// the owner in place so the late reply cannot shift FIFO
					// matching onto an unrelated query.
					const ownerIndex = this.#da1SentinelOwners.findIndex(o => o.kind === "osc11");
					if (ownerIndex !== -1) {
						this.#da1SentinelOwners[ownerIndex] = { kind: "cursorPositionSettled" };
					}
					this.#handleOsc11Response(rHex!, gHex!, bHex!, requestToken);
					// A refresh queued behind the pending query starts now.
					const queued = this.#osc11QueuedQuery;
					this.#osc11QueuedQuery = undefined;
					if (queued && !this.#dead) this.#queryBackgroundColor(queued.route, queued.token);
					return;
				}
			}

			if (this.#osc99PendingId && (this.#osc99ResponseBuffer || sequence.startsWith("\x1b]99;"))) {
				if (this.#osc99ResponseBuffer && sequence.startsWith("\x1b") && sequence !== "\x1b\\") {
					this.#osc99ResponseBuffer = "";
				} else if (
					this.#osc99ResponseBuffer &&
					this.#replyBufferStalled(
						this.#osc99ResponseStartedAt,
						this.#osc99ResponseBuffer.length,
						OSC99_REPLY_MAX_LENGTH,
					)
				) {
					// Same wedge rule as OSC 11: an unterminated probe reply releases
					// as unsupported instead of swallowing ordinary input forever.
					const probeId = this.#osc99PendingId;
					this.#osc99ResponseBuffer = "";
					if (probeId !== undefined) this.#resolveOsc99Support(probeId, false);
				} else {
					if (this.#osc99ResponseBuffer === "") this.#osc99ResponseStartedAt = Date.now();
					this.#osc99ResponseBuffer += sequence;
					const osc99Match = this.#osc99ResponseBuffer.match(/^\x1b\]99;([^;]*);([\s\S]*?)(?:\x07|\x1b\\)$/u);
					if (!osc99Match) return;
					const [, meta, payload] = osc99Match;
					this.#osc99ResponseBuffer = "";
					this.#handleOsc99CapabilityResponse(meta!, payload!);
					return;
				}
			}

			const appearanceMatch = sequence.match(appearanceDsrPattern);
			if (appearanceMatch) {
				if (this.#mode2031DebounceTimer) clearTimeout(this.#mode2031DebounceTimer);
				this.#mode2031DebounceTimer = setTimeout(() => {
					this.#mode2031DebounceTimer = undefined;
					this.#queryBackgroundColor();
				}, 100);
				return;
			}
			if (this.#inputHandler) {
				this.#inputHandler(sequence);
			}
		});

		this.#stdinBuffer.on("paste", (content: string) => {
			if (this.#inputHandler) {
				this.#inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		this.#stdinDataHandler = (data: string) => {
			this.#stdinBuffer!.process(data);
		};
	}

	/** A capability-reply buffer that outgrew the reply length cap or outlived
	 * the reply window can no longer be a valid reply: treat it as abandoned
	 * so a torn, unterminated sequence stops swallowing ordinary input. */
	#replyBufferStalled(startedAt: number, length: number, maxLength: number): boolean {
		return length > maxLength || Date.now() - startedAt > OSC_REPLY_TIMEOUT_MS;
	}

	#abandonOsc11Query(): void {
		this.#osc11Pending = false;
		this.#osc11ActiveToken = undefined;
		this.#osc11ResponseBuffer = "";
		// The sentinel owner for the abandoned query must not linger either,
		// or later refreshes queue forever behind it.
		const staleOwner = this.#da1SentinelOwners.findIndex(o => o.kind === "osc11");
		if (staleOwner !== -1) {
			// Keep the entry in the FIFO. The terminal may still answer
			// the query's DA1 sentinel after OSC11; removing it would
			// shift that reply onto the next query owner.
			this.#da1SentinelOwners[staleOwner] = { kind: "cursorPositionSettled" };
		}
		// A refresh queued behind the wedged query must not strand: settle
		// it now that the pending state is cleared.
		const queued = this.#osc11QueuedQuery;
		this.#osc11QueuedQuery = undefined;
		if (queued) this.#queryBackgroundColor(queued.route, queued.token);
	}

	#queryBackgroundColor(route: Osc11QueryRoute = "direct", token?: TerminalAppearanceRequestToken): void {
		if (this.#dead) return;

		if (this.#osc11Pending || this.#da1SentinelOwners.some(o => o.kind === "osc11")) {
			const queued = this.#osc11QueuedQuery;
			this.#osc11QueuedQuery = {
				route: queued?.route === "tmux" || route === "tmux" ? "tmux" : "direct",
				token: token ?? queued?.token,
			};
			return;
		}
		this.#startOsc11Query(route, token);
	}

	#startOsc11Query(route: Osc11QueryRoute, token?: TerminalAppearanceRequestToken): void {
		this.#osc11Pending = true;
		this.#osc11ActiveToken = token;
		this.#osc11ResponseBuffer = "";
		if (route === "tmux") {
			if (this.#osc11TmuxRefreshTimer) {
				clearTimeout(this.#osc11TmuxRefreshTimer);
				this.#osc11TmuxRefreshTimer = undefined;
			}
			this.#safeWrite(wrapTmuxPassthrough("\x1b]11;?\x07"));
			this.#osc11TmuxRefreshTimer = setTimeout(() => {
				this.#osc11TmuxRefreshTimer = undefined;
				if (this.#dead || !this.#osc11Pending) return;
				this.#startDirectOsc11Query();
			}, TMUX_OSC11_CACHE_REFRESH_DELAY_MS);
			return;
		}
		this.#startDirectOsc11Query();
	}

	#startDirectOsc11Query(): void {
		this.#da1SentinelOwners.push({ kind: "osc11" });
		this.#safeWrite("\x1b]11;?\x07");
		this.#safeWrite("\x1b[c");
	}

	#shouldQueryOsc99Support(): boolean {
		if (TERMINAL.notifyProtocol !== NotifyProtocol.Osc99) return false;

		if (isInsideTerminalMultiplexer($env)) return false;
		return !isBunTestRuntime() || $env.PI_TUI_OSC99_PROBE === "1";
	}

	#queryOsc99Support(): void {
		setOsc99Supported(false);
		this.#osc99Capabilities.clear();
		this.#osc99PendingId = undefined;
		this.#osc99ResponseBuffer = "";
		if (this.#dead || !this.#shouldQueryOsc99Support()) return;

		const id = `proto-probe-${nextOsc99ProbeId++}`;
		this.#osc99PendingId = id;
		this.#da1SentinelOwners.push({ kind: "osc99Probe", id });

		this.#safeWrite(`\x1b]99;i=${id}:p=?;\x1b\\\x1b[c`);
	}

	#handleOsc99CapabilityResponse(metaRaw: string, payload: string): boolean {
		const pendingId = this.#osc99PendingId;
		if (!pendingId) return false;
		const meta = parseOsc99KeyValues(metaRaw);
		if (meta.get("i") !== pendingId || meta.get("p") !== "?") return false;

		const capabilities = parseOsc99KeyValues(payload);
		this.#osc99Capabilities = capabilities;
		const payloadTypes = capabilities.get("p")?.split(",") ?? [];
		this.#resolveOsc99Support(pendingId, payloadTypes.includes("title"));
		return true;
	}

	#resolveOsc99Support(id: string, supported: boolean): void {
		if (this.#osc99PendingId !== id) return;
		this.#osc99PendingId = undefined;
		this.#osc99ResponseBuffer = "";
		if (!supported) this.#osc99Capabilities.clear();
		setOsc99Supported(supported);
	}

	#handleOsc11Response(rHex: string, gHex: string, bHex: string, requestToken?: TerminalAppearanceRequestToken): void {
		const normalize = (hex: string): number => {
			const value = parseInt(hex, 16);
			if (Number.isNaN(value)) return 0;
			const max = 16 ** hex.length - 1;
			return max > 0 ? value / max : 0;
		};
		const luminance = 0.299 * normalize(rHex) + 0.587 * normalize(gHex) + 0.114 * normalize(bHex);
		const mode: TerminalAppearance = luminance < 0.5 ? "dark" : "light";
		const changed = mode !== this.#appearance;
		this.#appearance = mode;
		for (const cb of [...this.#appearanceReportCallbacks]) {
			try {
				cb(mode, requestToken);
			} catch {}
		}
		if (!changed) return;
		for (const cb of this.#appearanceCallbacks) {
			try {
				cb(mode, requestToken);
			} catch {}
		}
	}

	#enableModifyOtherKeysFallback(): void {
		if (this.#kittyProtocolActive || this.#modifyOtherKeysActive) return;
		if (!shouldEnableModifyOtherKeysFallback()) return;
		this.#safeWrite("\x1b[>4;2m");
		this.#modifyOtherKeysActive = true;
	}

	/**
	 * Ask the host to name itself. Environment variables are advisory — a
	 * multiplexer launched through `env -i` leaves `TMUX`/`STY` unset — while
	 * these two queries reach the process that actually owns the tty. The answer
	 * decides whether resize transactions may trust a saved-cursor anchor
	 * (direct terminals rewrap it with its logical line) or must treat the host
	 * as clipping and re-lay the pane on its own schedule.
	 *
	 * Sent without a DA1 sentinel: terminals that know neither query stay
	 * silent, and silence means "unknown", which keeps the direct-terminal path.
	 */
	#queryTerminalHostIdentity(): void {
		if (this.#dead) return;
		hostIdentityProbedAt = Date.now();
		this.#safeWrite(HOST_IDENTITY_QUERY);
	}

	#handleHostIdentityReport(identity: string): void {
		setReportedTerminalHostIdentity(identity);
	}

	/**
	 * Secondary device attributes for hosts without XTVERSION: the terminal id
	 * is the multiplexer's initial, `S` (83) for screen and `T` (84) for tmux.
	 * Real terminals report DEC model numbers, so these two never collide.
	 */
	#handleSecondaryDeviceAttributes(terminalId: string): void {
		const id = parseInt(terminalId, 10);
		if (id === 83) setReportedTerminalHostIdentity("screen");
		else if (id === 84) setReportedTerminalHostIdentity("tmux");
	}

	#queryAndEnableKittyProtocol(): void {
		this.#setupStdinBuffer();
		process.stdin.on("data", this.#stdinDataHandler!);

		this.#da1SentinelOwners.push({ kind: "keyboard" });
		this.#safeWrite("\x1b[?u\x1b[c");
		this.#modifyOtherKeysTimeout = setTimeout(() => {
			this.#modifyOtherKeysTimeout = undefined;
			this.#enableModifyOtherKeysFallback();
		}, 150);
	}

	queryCursorPosition(): Promise<TerminalCursorPosition | undefined> {
		if (this.#dead || !this.#active || !this.#stdinBuffer) return Promise.resolve(undefined);
		const { promise, resolve } = Promise.withResolvers<TerminalCursorPosition | undefined>();
		this.#da1SentinelOwners.push({ kind: "cursorPosition", resolve });
		this.#safeWrite("\x1b[6n\x1b[c");
		return promise;
	}

	#hasPendingCursorPositionQuery(): boolean {
		return this.#da1SentinelOwners.some(owner => owner.kind === "cursorPosition");
	}

	#resolveCursorPositionQuery(position: TerminalCursorPosition | undefined): void {
		const index = this.#da1SentinelOwners.findIndex(owner => owner.kind === "cursorPosition");
		if (index < 0) return;
		const owner = this.#da1SentinelOwners[index]!;
		if (owner.kind !== "cursorPosition") return;
		// The CPR reply lands before this query's DA1 sentinel; leave the sentinel
		// in the FIFO so its DA1 reply is consumed instead of leaking as input.
		this.#da1SentinelOwners[index] = { kind: "cursorPositionSettled" };
		owner.resolve(position);
	}

	#queryPrivateMode(mode: number): void {
		if (this.#dead) return;
		if (this.#privateModeSupport.has(mode)) return;
		this.#da1SentinelOwners.push({ kind: "privateMode", mode });
		this.#safeWrite(`\x1b[?${mode}$p\x1b[c`);
	}

	#handlePrivateModeReport(mode: number, status: string): void {
		this.#resolvePrivateMode(mode, isPrivateModeSupported(status), true, Number.parseInt(status, 10));
		if (isXtermScrollToBottomMode(mode) && isPrivateModeSet(status)) {
			this.#disableXtermScrollToBottomMode(mode);
		}
	}

	#resolvePrivateMode(mode: number, supported: boolean, confirmed: boolean, status?: number): void {
		if (this.#privateModeSupport.has(mode)) return;
		this.#privateModeSupport.set(mode, supported);
		for (const cb of this.#privateModeCallbacks) {
			try {
				cb(mode, supported, confirmed, status);
			} catch {}
		}
		if (mode === 2048 && supported) this.#enableInBandResize();
		// `supported` is true only after an explicit DECRPM reply (the DA1 sentinel
		// fallback resolves unsupported), so terminals ignoring DECRQM keep the
		// raw-paste heuristic.
		if (mode === 2004 && supported) this.#stdinBuffer?.setRawPasteClassification(false);
	}

	#disableXtermScrollToBottomMode(mode: number): void {
		if (this.#xtermScrollToBottomRestoreModes.has(mode) || this.#dead) return;
		this.#xtermScrollToBottomRestoreModes.add(mode);
		this.#safeWrite(`\x1b[?${mode}l`);
	}

	#enableInBandResize(): void {
		if (this.#inBandResizeActive || this.#dead) return;
		this.#inBandResizeActive = true;
		this.#safeWrite("\x1b[?2048h");
	}

	#clearInBandResizeWatchdog(): void {
		if (!this.#inBandResizeWatchdog) return;
		clearTimeout(this.#inBandResizeWatchdog);
		this.#inBandResizeWatchdog = undefined;
	}

	#releaseInBandResizeSuffix(abandoned: string): void {
		const suffix = abandoned.startsWith(IN_BAND_RESIZE_PREFIX)
			? abandoned.slice(IN_BAND_RESIZE_PREFIX.length)
			: abandoned;
		if (suffix.length > 0) this.#inputHandler?.(suffix);
	}

	#armInBandResizeWatchdog(): void {
		this.#clearInBandResizeWatchdog();
		this.#inBandResizeWatchdog = setTimeout(() => {
			this.#inBandResizeWatchdog = undefined;
			const abandoned = this.#inBandResizeBuffer;
			this.#inBandResizeBuffer = "";
			if (abandoned) this.#releaseInBandResizeSuffix(abandoned);
		}, IN_BAND_RESIZE_WATCHDOG_MS);
	}

	#handleInBandResizeReport(rowsRaw: string, colsRaw: string, yPixelsRaw: string, xPixelsRaw: string): void {
		const previousRows = this.rows;
		const previousColumns = this.columns;
		const rows = parseInt(rowsRaw, 10);
		const cols = parseInt(colsRaw, 10);
		const yPixels = parseInt(yPixelsRaw, 10);
		const xPixels = parseInt(xPixelsRaw, 10);
		if (rows > 0) this.#reportedRows = rows;
		if (cols > 0) this.#reportedColumns = cols;
		if (cols > 0 && xPixels > 0 && rows > 0 && yPixels > 0) {
			setCellDimensions({
				widthPx: Math.max(1, Math.round(xPixels / cols)),
				heightPx: Math.max(1, Math.round(yPixels / rows)),
			});
		}
		if (rows > 0 && cols > 0 && (rows !== previousRows || cols !== previousColumns)) {
			this.#resizeHandler?.();
		}
	}

	#reconcileInBandGeometryOnResize(): void {
		if (!this.#inBandResizeActive) return;
		const osColumns = process.stdout.columns;
		const osRows = process.stdout.rows;
		if (this.#reportedColumns !== undefined && osColumns > 0 && this.#reportedColumns !== osColumns) {
			this.#reportedColumns = undefined;
		}
		if (this.#reportedRows !== undefined && osRows > 0 && this.#reportedRows !== osRows) {
			this.#reportedRows = undefined;
		}
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		if (this.#headless) return;
		if (this.#kittyProtocolActive) {
			this.#safeWrite("\x1b[<u");
			this.#kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this.#modifyOtherKeysTimeout) {
			clearTimeout(this.#modifyOtherKeysTimeout);
			this.#modifyOtherKeysTimeout = undefined;
		}
		if (this.#modifyOtherKeysActive) {
			this.#safeWrite("\x1b[>4;0m");
			this.#modifyOtherKeysActive = false;
		}

		const previousHandler = this.#inputHandler;
		this.#inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await Bun.sleep(Math.min(idleMs, timeLeft));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.#inputHandler = previousHandler;
		}
	}

	stop(): void {
		this.#active = false;
		this.#inputDeferred = false;
		const restoreOsTerminal = !this.#headless;
		const clearProgress = this.#clearProgressTimer();

		try {
			if (restoreOsTerminal) this.#restoreOsTerminal(clearProgress);
		} finally {
			this.#teardownObjectState();
		}

		if (restoreOsTerminal && !this.#dead) terminalCleanlyStopped = true;
	}

	#restoreOsTerminal(clearProgress: boolean): void {
		if (activeTerminal === this) {
			activeTerminal = null;
			setOutboundWriter(null);
		}

		restoreTerminalStderr();

		if (clearProgress) this.#safeWrite(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		this.#safeWrite("\x1b[?2026l\x1b[?7h");
		this.#safeWrite("\x1b[?1l\x1b>");
		this.#safeWrite("\x1b[?2004l");
		this.#safeWrite("\x1b[?1004l");
		this.#safeWrite("\x1b[?5522l");
		this.#safeWrite("\x1b[?1006l\x1b[?1003l\x1b[?1000l");
		this.#safeWrite("\x1b[?2031l");

		for (const mode of this.#xtermScrollToBottomRestoreModes) {
			this.#safeWrite(`\x1b[?${mode}h`);
		}
		if (this.#inBandResizeActive) this.#safeWrite("\x1b[?2048l");
		if (this.#kittyProtocolActive) this.#safeWrite("\x1b[<u");
		if (this.#modifyOtherKeysActive) this.#safeWrite("\x1b[>4;0m");

		process.stdin.pause();
		try {
			process.stdin.setRawMode?.(this.#wasRaw);
		} catch (err) {
			if (!this.#dead) throw err;
		}
	}

	#teardownObjectState(): void {
		clearTerminalFocusTracking();
		this.#xtermScrollToBottomRestoreModes.clear();
		this.#inBandResizeActive = false;
		if (this.#mode2031DebounceTimer) {
			clearTimeout(this.#mode2031DebounceTimer);
			this.#mode2031DebounceTimer = undefined;
		}
		if (this.#osc11TmuxRefreshTimer) {
			clearTimeout(this.#osc11TmuxRefreshTimer);
			this.#osc11TmuxRefreshTimer = undefined;
		}
		this.#appearanceCallbacks = [];
		this.#appearanceReportCallbacks = [];
		this.#osc11Pending = false;
		this.#osc11ActiveToken = undefined;
		this.#osc11QueuedQuery = undefined;
		this.#osc11ResponseBuffer = "";
		this.#osc99PendingId = undefined;
		this.#osc99ResponseBuffer = "";
		this.#osc99Capabilities.clear();
		setOsc99Supported(false);
		this.#privateCsiResponseBuffer = "";
		this.#clearInBandResizeWatchdog();
		this.#inBandResizeBuffer = "";
		this.#cursorPositionResponseBuffer = "";
		for (const owner of this.#da1SentinelOwners) {
			if (owner.kind === "cursorPosition") owner.resolve(undefined);
		}
		this.#da1SentinelOwners.length = 0;
		this.#privateModeCallbacks = [];
		this.#privateModeSupport.clear();
		this.#reportedColumns = undefined;
		this.#reportedRows = undefined;
		// The identity belongs to the tty this terminal was attached to; a
		// restart re-probes whatever host owns the next one.
		setReportedTerminalHostIdentity(null);

		this.#kittyProtocolActive = false;
		this.#kittyEnableSeq = null;
		setKittyProtocolActive(false);
		if (this.#modifyOtherKeysTimeout) {
			clearTimeout(this.#modifyOtherKeysTimeout);
			this.#modifyOtherKeysTimeout = undefined;
		}
		this.#modifyOtherKeysActive = false;

		if (this.#stdinBuffer) {
			this.#stdinBuffer.destroy();
			this.#stdinBuffer = undefined;
		}

		if (this.#stdinDataHandler) {
			process.stdin.removeListener("data", this.#stdinDataHandler);
			this.#stdinDataHandler = undefined;
		}
		process.stdin.removeListener("end", this.#stdinEndHandler);
		process.stdin.removeListener("close", this.#stdinCloseHandler);
		process.stdin.removeListener("error", this.#stdinErrorHandler);
		this.#disconnectHandler = undefined;
		this.#inputHandler = undefined;
		this.#appearance = undefined;
		if (this.#stdoutResizeListener) {
			process.stdout.removeListener("resize", this.#stdoutResizeListener);
			this.#stdoutResizeListener = undefined;
		}
		this.#disarmStdoutStallWatchdog();
		this.#resizeHandler = undefined;

		if (this.#outputPump) {
			this.#outputPump.stop(1000);
			this.#outputPump = undefined;
		}

		this.#stdoutErrorCleanup?.();
		this.#stdoutErrorCleanup = undefined;
		this.#cursorVisible = undefined;
	}

	#ensureStdoutErrorHandler(): void {
		this.#stdoutErrorCleanup ??= registerStdoutErrorHandler(this.#stdoutErrorHandler);
	}

	#markTerminalDisconnected(reason: string, err?: unknown): void {
		if (this.#dead) return;
		this.#dead = true;
		this.#disarmStdoutStallWatchdog();
		logger.warn("terminal disconnected; stopping interactive rendering", { reason, err });

		const disconnectHandler = this.#disconnectHandler;
		this.#disconnectHandler = undefined;
		if (!disconnectHandler) return;

		try {
			disconnectHandler();
		} catch (handlerErr) {
			logger.error("Terminal disconnect handler failed; exiting anyway", { err: handlerErr });
		}

		try {
			process.kill(process.pid, "SIGHUP");
		} catch (signalErr) {
			logger.error("Failed to deliver terminal disconnect signal; exiting directly", { err: signalErr });
			void postmortem.quit(129);
		}
	}

	write(data: string): void {
		this.#safeWrite(data);
		if (this.#writeLogPath) {
			try {
				fs.appendFileSync(this.#writeLogPath, data, { encoding: "utf8" });
			} catch {}
		}
	}

	#safeWrite(data: string): void {
		if (this.#headless) return;
		if (this.#dead) return;

		if (!process.stdout.isTTY) return;
		this.#ensureStdoutErrorHandler();
		this.#trackCursorVisibility(data);
		const pump = this.#outputPump;
		if (pump) {
			if (pump.dead) {
				this.#markTerminalDisconnected("stdout failed; output pump died");
				return;
			}
			try {
				this.#trackStdoutBacklog(pump.write(data));
			} catch (err) {
				this.#markTerminalDisconnected("stdout failed", err);
			}
			return;
		}
		try {
			process.stdout.write(data);
			// A stalled-but-alive consumer never throws: refused writes just queue
			// and writableLength grows. Feed that backlog to the stall watchdog.
			this.#trackStdoutBacklog(process.stdout.writableLength ?? 0);
		} catch (err) {
			this.#markTerminalDisconnected("stdout failed", err);
		}
	}

	get columns(): number {
		if (this.#inBandResizeActive && this.#reportedColumns) return this.#reportedColumns;
		return process.stdout.columns || Number(Bun.env.COLUMNS) || 80;
	}
	get pendingOutputBytes(): number {
		if (this.#outputPump) return this.#outputPump.pending();

		return process.stdout.writableLength ?? 0;
	}

	/**
	 * Reconcile the stdout backlog after a write or a poll. While an episode is
	 * armed a poll keeps running: once the render gate defers frames, no write is
	 * guaranteed to re-sample the backlog, so a consumer that wedges anywhere
	 * above the healthy level would otherwise freeze the session.
	 */
	#trackStdoutBacklog(pending: number): void {
		if (this.#stdoutStall.sample(pending, Date.now())) {
			this.#disarmStdoutStallWatchdog();
			this.#markTerminalDisconnected("stdout backlog stalled without draining; PTY consumer stalled");
			return;
		}
		if (!this.#stdoutStall.armed) {
			this.#disarmStdoutStallWatchdog();
			return;
		}
		if (!this.#stdoutStallTimer) {
			this.#stdoutStallTimer = setInterval(() => this.#pollStdoutStall(), STDOUT_STALL_POLL_MS);
			this.#stdoutStallTimer.unref?.();
		}
	}

	#pollStdoutStall(): void {
		if (this.#dead) {
			this.#disarmStdoutStallWatchdog();
			return;
		}
		this.#trackStdoutBacklog(this.pendingOutputBytes);
	}

	#disarmStdoutStallWatchdog(): void {
		this.#stdoutStall.reset();
		if (this.#stdoutStallTimer) {
			clearInterval(this.#stdoutStallTimer);
			this.#stdoutStallTimer = undefined;
		}
	}

	get rows(): number {
		if (this.#inBandResizeActive && this.#reportedRows) return this.#reportedRows;
		return process.stdout.rows || Number(Bun.env.LINES) || 24;
	}

	refreshSize(): boolean {
		if (this.#headless || this.#dead || !this.#stdoutResizeListener) return false;
		// Node and Bun TTY streams re-read TIOCGWINSZ here and emit "resize"
		// synchronously on a change; the public size getters only update once the
		// SIGWINCH reaches the event loop.
		const stdout: NodeJS.WriteStream & { _refreshSize?: () => void } = process.stdout;
		const { columns, rows } = stdout;
		stdout._refreshSize?.();
		return stdout.columns !== columns || stdout.rows !== rows;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			this.#safeWrite(`\x1b[${lines}B`);
		} else if (lines < 0) {
			this.#safeWrite(`\x1b[${-lines}A`);
		}
	}

	hideCursor(force = false): void {
		if (!force && this.#cursorVisible === false) return;
		this.#safeWrite("\x1b[?25l");
	}

	showCursor(force = false): void {
		if (!force && this.#cursorVisible === true) return;
		this.#safeWrite("\x1b[?25h");
	}

	#trackCursorVisibility(data: string): void {
		let idx = data.lastIndexOf("\x1b[?25");
		while (idx !== -1) {
			const final = data.charCodeAt(idx + 5);
			if (final === 0x68 || final === 0x6c) break;
			idx = idx === 0 ? -1 : data.lastIndexOf("\x1b[?25", idx - 1);
		}
		if (data.lastIndexOf("\x1b[?1049") > idx) {
			this.#cursorVisible = undefined;
			return;
		}
		if (idx !== -1) this.#cursorVisible = data.charCodeAt(idx + 5) === 0x68;
	}

	clearLine(): void {
		this.#safeWrite("\x1b[K");
	}

	clearFromCursor(): void {
		this.#safeWrite("\x1b[J");
	}

	clearScreen(): void {
		this.#safeWrite("\x1b[H\x1b[0J");
	}

	setTitle(title: string): void {
		// A title containing ESC/BEL/C1 could terminate the OSC and inject
		// terminal commands; strip every control byte before interpolating.
		this.#safeWrite(`\x1b]0;${stripControlChars(title)}\x07`);
	}

	setProgress(active: boolean): void {
		if (this.#headless) return;
		if (active) {
			this.#safeWrite(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.#progressTimer) {
				this.#progressTimer = setInterval(() => {
					this.#safeWrite(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
				this.#progressTimer.unref?.();
			}
		} else {
			this.#clearProgressTimer();
			this.#safeWrite(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	#clearProgressTimer(): boolean {
		if (!this.#progressTimer) return false;
		clearInterval(this.#progressTimer);
		this.#progressTimer = undefined;
		return true;
	}
}
