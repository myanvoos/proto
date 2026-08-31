import * as fs from "node:fs";
import { TtyWriter } from "@oh-my-pi/pi-natives";
import {
	$env,
	isBunTestRuntime,
	isTerminalHeadless,
	logger,
	postmortem,
	restoreTerminalStderr,
	suppressTerminalStderr,
} from "@oh-my-pi/pi-utils";
import { setKittyProtocolActive } from "./keys";
import { StdinBuffer } from "./stdin-buffer";
import {
	isInsideTerminalMultiplexer,
	NotifyProtocol,
	setCellDimensions,
	setOsc99Supported,
	TERMINAL,
} from "./terminal-capabilities";
import { isInsideTmux, wrapTmuxPassthrough } from "./tmux";
import { setHangulCompatibilityJamoWidth } from "./utils";

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0;\x07";
function shouldEnableModifyOtherKeysFallback(env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (!env.SSH_CONNECTION && !env.SSH_TTY && !env.SSH_CLIENT) return true;
	return TERMINAL.id !== "base" && TERMINAL.id !== "trueColor";
}

const MAX_STDOUT_BACKLOG_BYTES = 64 * 1024 * 1024;

export class OutputBacklogGuard {
	#bytes = 0;
	#tracking = false;

	constructor(private readonly capBytes: number = MAX_STDOUT_BACKLOG_BYTES) {}

	get tracking(): boolean {
		return this.#tracking;
	}

	record(accepted: boolean, bytes: number): boolean {
		if (!this.#tracking) {
			if (accepted) return false;

			this.#tracking = true;
		}
		this.#bytes += bytes;
		return this.#bytes > this.capBytes;
	}

	reset(): void {
		this.#bytes = 0;
		this.#tracking = false;
	}
}

let activeTerminal: ProcessTerminal | null = null;

let terminalEverStarted = false;

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
		} else if (terminalEverStarted && !isTerminalHeadless()) {
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

	onPrivateModeReport?(callback: (mode: number, supported: boolean, confirmed?: boolean) => void): void;
}

type Da1SentinelOwner =
	| { kind: "keyboard" }
	| { kind: "osc11" }
	| { kind: "privateMode"; mode: number }
	| { kind: "osc99Probe"; id: string };

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

	#stdoutBacklog = new OutputBacklogGuard();

	#outputPump?: TtyWriter;
	#stdoutDrainArmed = false;
	#stdoutDrainHandler = () => {
		this.#stdoutDrainArmed = false;
		this.#stdoutBacklog.reset();
	};

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
	#osc11TmuxRefreshTimer?: Timer;
	#osc99PendingId: string | undefined;
	#osc99ResponseBuffer = "";
	#osc99Capabilities = new Map<string, string>();
	#privateCsiResponseBuffer = "";
	#da1SentinelOwners: Da1SentinelOwner[] = [];

	#privateModeSupport = new Map<number, boolean>();
	#privateModeCallbacks: Array<(mode: number, supported: boolean, confirmed: boolean) => void> = [];

	#inBandResizeActive = false;

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

	onPrivateModeReport(callback: (mode: number, supported: boolean, confirmed?: boolean) => void): void {
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
		registerPostmortemTerminalRestore();

		activeTerminal = this;
		terminalEverStarted = true;

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

		this.#safeWrite("\x1b[?1l\x1b>");

		this.#queryAndEnableKittyProtocol();

		this.#active = true;

		this.#queryBackgroundColor();

		this.#queryOsc99Support();

		this.#safeWrite("\x1b[?2031h");

		this.#queryPrivateMode(2026);
		this.#queryPrivateMode(2048);
		this.#queryPrivateMode(2031);
		for (const mode of XTERM_SCROLL_TO_BOTTOM_MODES) {
			this.#queryPrivateMode(mode);
		}
	}

	#setupStdinBuffer(): void {
		this.#stdinBuffer = new StdinBuffer({ timeout: 50 });

		const kittyResponsePattern = /^\x1b\[\?(\d+)u$/;

		const appearanceDsrPattern = /^\x1b\[\?997;([12])n$/;

		const osc11ResponsePattern =
			/^\x1b\]11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\x07|\x1b\\)$/;

		const da1ResponsePattern = /^\x1b\[\?[\d;]*c$/;

		const privateCsiPartialPattern = /^\x1b\[\?[\d;]*[\x20-\x2f]*$/;

		const decrpmResponsePattern = /^\x1b\[\?(\d+);(\d+)\$y$/;

		const inBandResizePattern = /^\x1b\[48;(\d+)(?::[\d:]*)?;(\d+)(?::[\d:]*)?;(\d+)(?::[\d:]*)?;(\d+)(?::[\d:]*)?t$/;

		this.#stdinBuffer.on("data", (sequence: string) => {
			if (
				(sequence.length === 0 || sequence.charCodeAt(0) !== 0x1b) &&
				this.#privateCsiResponseBuffer.length === 0 &&
				this.#inBandResizeBuffer.length === 0 &&
				this.#osc11ResponseBuffer.length === 0 &&
				this.#osc99ResponseBuffer.length === 0
			) {
				if (this.#inputHandler) {
					this.#inputHandler(sequence);
				}
				return;
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
			if (this.#inBandResizeBuffer && sequence.startsWith("\x1b")) {
				this.#inBandResizeBuffer = isInBandResizePartial ? sequence : "";
				if (isInBandResizePartial) return;
			} else if (this.#inBandResizeBuffer || isInBandResizePartial) {
				this.#inBandResizeBuffer += sequence;
				if (this.#inBandResizeBuffer.length > 256) {
					this.#inBandResizeBuffer = "";
					return;
				}
				const lastCode = this.#inBandResizeBuffer.charCodeAt(this.#inBandResizeBuffer.length - 1);
				if (lastCode >= 0x40 && lastCode <= 0x7e) {
					sequence = this.#inBandResizeBuffer;
					this.#inBandResizeBuffer = "";
				} else if (!inBandResizePartialPattern.test(this.#inBandResizeBuffer)) {
					this.#inBandResizeBuffer = "";
					return;
				} else {
					return;
				}
			}

			const resizeMatch = sequence.match(inBandResizePattern);
			if (resizeMatch) {
				this.#handleInBandResizeReport(resizeMatch[1]!, resizeMatch[2]!, resizeMatch[3]!, resizeMatch[4]!);
				return;
			}

			const decrpmMatch = sequence.match(decrpmResponsePattern);
			if (decrpmMatch) {
				this.#handlePrivateModeReport(parseInt(decrpmMatch[1]!, 10), decrpmMatch[2]!);
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
				if (this.#osc11ResponseBuffer && sequence.startsWith("\x1b") && sequence !== "\x1b\\") {
					this.#osc11ResponseBuffer = "";
				} else {
					this.#osc11ResponseBuffer += sequence;
					const osc11Match = this.#osc11ResponseBuffer.match(osc11ResponsePattern);
					if (!osc11Match) return;
					const [, rHex, gHex, bHex] = osc11Match;
					this.#osc11Pending = false;
					const requestToken = this.#osc11ActiveToken;
					this.#osc11ActiveToken = undefined;
					this.#osc11ResponseBuffer = "";
					this.#handleOsc11Response(rHex!, gHex!, bHex!, requestToken);
					return;
				}
			}

			if (this.#osc99PendingId && (this.#osc99ResponseBuffer || sequence.startsWith("\x1b]99;"))) {
				if (this.#osc99ResponseBuffer && sequence.startsWith("\x1b") && sequence !== "\x1b\\") {
					this.#osc99ResponseBuffer = "";
				} else {
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

	#queryPrivateMode(mode: number): void {
		if (this.#dead) return;
		if (this.#privateModeSupport.has(mode)) return;
		this.#da1SentinelOwners.push({ kind: "privateMode", mode });
		this.#safeWrite(`\x1b[?${mode}$p\x1b[c`);
	}

	#handlePrivateModeReport(mode: number, status: string): void {
		this.#resolvePrivateMode(mode, isPrivateModeSupported(status), true);
		if (isXtermScrollToBottomMode(mode) && isPrivateModeSet(status)) {
			this.#disableXtermScrollToBottomMode(mode);
		}
	}

	#resolvePrivateMode(mode: number, supported: boolean, confirmed: boolean): void {
		if (this.#privateModeSupport.has(mode)) return;
		this.#privateModeSupport.set(mode, supported);
		for (const cb of this.#privateModeCallbacks) {
			try {
				cb(mode, supported, confirmed);
			} catch {}
		}
		if (mode === 2048 && supported) this.#enableInBandResize();
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
				await new Promise(resolve => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.#inputHandler = previousHandler;
		}
	}

	stop(): void {
		this.#active = false;
		this.#inputDeferred = false;
		if (this.#headless) return;

		if (activeTerminal === this) {
			activeTerminal = null;
		}

		restoreTerminalStderr();

		if (this.#clearProgressTimer()) {
			this.#safeWrite(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}

		this.#safeWrite("\x1b[?2026l\x1b[?7h");

		this.#safeWrite("\x1b[?1l\x1b>");

		this.#safeWrite("\x1b[?2004l");
		this.#safeWrite("\x1b[?5522l");

		this.#safeWrite("\x1b[?1006l\x1b[?1003l\x1b[?1000l");

		this.#safeWrite("\x1b[?2031l");

		for (const mode of this.#xtermScrollToBottomRestoreModes) {
			this.#safeWrite(`\x1b[?${mode}h`);
		}
		this.#xtermScrollToBottomRestoreModes.clear();

		if (this.#inBandResizeActive) {
			this.#safeWrite("\x1b[?2048l");
			this.#inBandResizeActive = false;
		}
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
		this.#inBandResizeBuffer = "";
		this.#da1SentinelOwners.length = 0;
		this.#privateModeCallbacks = [];
		this.#privateModeSupport.clear();
		this.#xtermScrollToBottomRestoreModes.clear();
		this.#reportedColumns = undefined;
		this.#reportedRows = undefined;

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
		if (this.#stdoutDrainArmed) {
			process.stdout.removeListener("drain", this.#stdoutDrainHandler);
			this.#stdoutDrainArmed = false;
		}
		this.#stdoutBacklog.reset();
		this.#resizeHandler = undefined;

		if (this.#outputPump) {
			this.#outputPump.stop(1000);
			this.#outputPump = undefined;
		}

		process.stdin.pause();

		try {
			process.stdin.setRawMode?.(this.#wasRaw);
		} catch (err) {
			if (!this.#dead) throw err;
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
				if (pump.write(data) > MAX_STDOUT_BACKLOG_BYTES) {
					this.#markTerminalDisconnected("stdout backlog exceeded cap; PTY consumer stalled");
				}
			} catch (err) {
				this.#markTerminalDisconnected("stdout failed", err);
			}
			return;
		}
		try {
			const bytes = Buffer.byteLength(data, "utf8");
			const accepted = process.stdout.write(data);

			if (this.#stdoutBacklog.record(accepted, bytes)) {
				this.#markTerminalDisconnected("stdout backlog exceeded cap; PTY consumer stalled");
			} else if (this.#stdoutBacklog.tracking && !this.#stdoutDrainArmed) {
				this.#stdoutDrainArmed = true;
				process.stdout.once("drain", this.#stdoutDrainHandler);
			}
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

	get rows(): number {
		if (this.#inBandResizeActive && this.#reportedRows) return this.#reportedRows;
		return process.stdout.rows || Number(Bun.env.LINES) || 24;
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
		this.#safeWrite(`\x1b]0;${title}\x07`);
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
