import { ExponentialYield } from "@oh-my-pi/pi-agent-core/utils/yield";
import { type FsObservation, type MinimizerOptions, Shell, type ShellRunResult } from "@oh-my-pi/pi-natives";
import { logger, postmortem, untilAborted, withTimeout } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { isExecutable, type ShellConfig } from "@oh-my-pi/pi-utils/procmgr";
import { Settings, type ShellMinimizerSettings } from "../config/settings";
import type { ExecutionMetadata } from "../session/execution-metadata";
import { type ExecutionTimeoutMetadata, executionMetadataForResult } from "../session/execution-metadata";
import { OutputSink } from "../session/streaming-output";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";
import { loadDirenvEnv } from "./direnv";
import { buildNonInteractiveEnv } from "./non-interactive-env";

interface BashExecutorOptions {
	cwd?: string;

	timeout?: number;
	onChunk?: (chunk: string) => void;
	chunkThrottleMs?: number;
	signal?: AbortSignal;

	sessionKey?: string;
	lane?: string;
	/** Lane slot reserved at call issue; omitted → reserved when executeBash is called. */
	laneReservation?: BashLaneReservation;
	/** Called once the lane admits the command, just before it starts executing. */
	onStart?: () => void;
	/** The lane is never reused (an anonymous async lane): discard its shell afterward unless background children live. */
	ephemeral?: boolean;
	sessionOwner?: BashSessionOwner;

	env?: Record<string, string>;

	useUserShell?: boolean;

	protolens?: {
		callId?: string;
		createDispatcher: (signal?: AbortSignal) => (request: string) => Promise<string>;
	};

	artifactPath?: string;
	artifactId?: string;

	onMinimizedSave?: (
		originalText: string,
		info: { filter: string; inputBytes: number; outputBytes: number },
	) => Promise<string | undefined>;
}

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;

	timedOut?: boolean;
	signal?: string | number;
	execution?: ExecutionMetadata;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	artifactId?: string;
	workingDir?: string;
	fsObservations?: FsObservation[];
	protolensDispatches?: string[];
	stageRecords?: string[];
	collector?: { state: "running" | "complete" | "failed" | "unavailable"; error?: string };
	outputDisposition?: "complete" | "truncated" | "summarized" | "unavailable";
	summarized?: boolean;
	actionableDiagnostics?: string[];
	/** Set when an earlier call discarded this lane's persistent shell, so this call ran in a fresh one. */
	shellStateLost?: string;
}

const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface DirenvPreflightOptions {
	callerEnv?: Record<string, string>;
	signal?: AbortSignal;

	timeoutMs?: number;

	callerTimeoutMs?: number;

	direnvSetting: "auto" | "off";

	commandPrefix?: string | undefined;
}

export async function applyDirenvPreflight(
	command: string,
	cwd: string,
	opts: DirenvPreflightOptions,
): Promise<{ command: string; env: Record<string, string> | undefined }> {
	const withPrefix = (line: string): string => (opts.commandPrefix ? `${opts.commandPrefix} ${line}` : line);

	const loadTimeoutMs =
		opts.callerTimeoutMs !== undefined && opts.callerTimeoutMs > 0
			? Math.min(opts.timeoutMs ?? opts.callerTimeoutMs, opts.callerTimeoutMs)
			: opts.timeoutMs;
	const direnvDiff =
		opts.direnvSetting === "off" ? null : await loadDirenvEnv(cwd, { timeoutMs: loadTimeoutMs, signal: opts.signal });
	if (!direnvDiff) {
		return { command: withPrefix(command), env: opts.callerEnv };
	}

	const mergedEnv = { ...direnvDiff.set, ...opts.callerEnv };

	const direnvUnsets = direnvDiff.unset.filter(
		name => !(opts.callerEnv && name in opts.callerEnv) && SAFE_ENV_NAME.test(name),
	);
	const unsetPrefix = direnvUnsets.length > 0 ? `unset -v ${direnvUnsets.join(" ")}; ` : "";
	return { command: `${unsetPrefix}${withPrefix(command)}`, env: mergedEnv };
}

export interface BashSessionOwner {
	readonly sessionId: string;
	disposed: boolean;
}

const shellSessions = new Map<string, Shell>();
const brokenShellSessions = new Set<string>();
const activeBashSessionOwners = new Map<string, BashSessionOwner>();

interface QuarantinedShellSession {
	shell: Shell;
	cleanup: Promise<unknown>;
}

const shellSessionQuarantines = new Map<string, QuarantinedShellSession>();

/** Why a lane cancelled reservations it had accepted. */
export type BashLaneCancelCause = "reset" | "close" | "dispose";

export class LaneCancelledError extends Error {
	override readonly name = "LaneCancelledError";
	constructor(
		readonly lane: string,
		readonly trigger: BashLaneCancelCause,
	) {
		super(
			trigger === "dispose"
				? `Command cancelled: lane ${lane} belongs to a disposed session`
				: `Command cancelled: lane ${lane} was ${trigger === "reset" ? "reset" : "closed"} by context control`,
		);
	}
}

interface LaneSlot {
	readonly admission: PromiseWithResolvers<void>;
	/** Settles once the slot leaves the lane, by release or by cancellation before admission. */
	readonly released: PromiseWithResolvers<void>;
	readonly abort: AbortController;
	readonly queuedAt: number;
	admittedAt?: number;
}

interface ShellLane {
	readonly key: string;
	readonly sessionKey: string | undefined;
	readonly lane: string;
	/** FIFO; only the head may be admitted. */
	readonly slots: LaneSlot[];
	/** Destructive controls in progress; nothing is admitted while any is up. */
	barriers: number;
}

const shellLanes = new Map<string, ShellLane>();

function laneKey(sessionKey: string | undefined, lane: string): string {
	return JSON.stringify([sessionKey ?? "", lane]);
}

function admitNextSlot(record: ShellLane): void {
	if (record.barriers > 0) return;
	const head = record.slots[0];
	if (!head) {
		if (shellLanes.get(record.key) === record) shellLanes.delete(record.key);
		return;
	}
	if (head.admittedAt !== undefined) return;
	head.admittedAt = Date.now();
	head.admission.resolve();
}

function removeSlot(record: ShellLane, slot: LaneSlot): void {
	const index = record.slots.indexOf(slot);
	if (index === -1) return;
	record.slots.splice(index, 1);
	slot.released.resolve();
	admitNextSlot(record);
}

/** Aborts accepted reservations; queued ones reject and never run, the admitted one observes its signal. */
function cancelSlots(
	record: ShellLane,
	slots: readonly LaneSlot[],
	cause: BashLaneCancelCause,
): { active: number; queued: number } {
	const cancelled = { active: 0, queued: 0 };
	for (const slot of slots) {
		if (!record.slots.includes(slot) || slot.abort.signal.aborted) continue;
		if (slot.admittedAt === undefined) cancelled.queued++;
		else cancelled.active++;
		const error = new LaneCancelledError(record.lane, cause);
		slot.abort.abort(error);
		if (slot.admittedAt === undefined) {
			slot.admission.reject(error);
			record.slots.splice(record.slots.indexOf(slot), 1);
			slot.released.resolve();
		}
	}
	admitNextSlot(record);
	return cancelled;
}
/**
 * Why a lane's persistent shell was discarded (`exit`, timeout, cancellation,
 * crash), keyed by shell session key. The next call on the lane reports it once,
 * like the kernel's generation-change notice.
 */
const lostShellStates = new LRUCache<string, string>({ max: 256 });

interface RetainedShell {
	shell: Shell;
	sessionKey: string;
	reapTimer?: NodeJS.Timeout;
	forceReapTimer?: NodeJS.Timeout;
	disposeRequested: boolean;
}

const retainedShells = new Map<Shell, RetainedShell>();

interface ActiveShell {
	sessionKey: string;
	abortController: AbortController;
}

const activeShells = new Map<Shell, ActiveShell>();
const shellClosePromises = new Map<Shell, Promise<void>>();
const RETAIN_REAP_INTERVAL_MS = 5_000;
const RETAIN_MAX_AGE_MS = 60_000;
const RETAIN_PROBE_TIMEOUT_MS = 1_000;
const SHELL_CLOSE_TIMEOUT_MS = 3_000;

const NATIVE_TIMEOUT_FALLBACK_GRACE_MS = 5_000;

function makeCommandTimeoutMetadata(timeoutMs: number | undefined): ExecutionTimeoutMetadata {
	return {
		cause: "deadline",
		scope: "command",
		effectiveMs: timeoutMs,
	};
}

function shellOwnerId(sessionKey: string): string | undefined {
	const separator = sessionKey.indexOf("\n");
	const owner = separator === -1 ? sessionKey : sessionKey.slice(0, separator);
	if (!owner) return undefined;
	return owner.split(/:async:|:lane:/, 1)[0];
}

function belongsToSession(sessionKey: string, sessionId: string): boolean {
	return shellOwnerId(sessionKey) === sessionId;
}

function getOrCreateBashSessionOwner(sessionId: string): BashSessionOwner {
	const existing = activeBashSessionOwners.get(sessionId);
	if (existing) return existing;
	const owner: BashSessionOwner = { sessionId, disposed: false };
	activeBashSessionOwners.set(sessionId, owner);
	return owner;
}

function isDisposedSessionKey(sessionKey: string, ownerToken?: BashSessionOwner): boolean {
	const owner = shellOwnerId(sessionKey);
	if (!owner) return false;
	const token = ownerToken?.sessionId === owner ? ownerToken : activeBashSessionOwners.get(owner);
	return token?.disposed === true;
}

export function registerBashSessionOwner(sessionId: string): BashSessionOwner {
	const owner = { sessionId, disposed: false };
	activeBashSessionOwners.set(sessionId, owner);
	return owner;
}

function forceCloseShell(shell: Shell): void {
	try {
		const forceClose = shell.forceClose;
		if (typeof forceClose === "function") {
			forceClose.call(shell);
			return;
		}
	} catch (error) {
		logger.debug("Failed to force close shell", { error: String(error) });
	}
	void shell.abort().catch(() => undefined);
}

function startShellClose(shell: Shell): Promise<void> {
	try {
		const close = shell.close;
		if (typeof close === "function") return close.call(shell);
	} catch (error) {
		return Promise.reject(error);
	}
	return shell.abort();
}

function closeShell(shell: Shell): Promise<void> {
	const existing = shellClosePromises.get(shell);
	if (existing) return existing;

	const closing = (async () => {
		let close: Promise<void>;
		try {
			close = startShellClose(shell);
		} catch {
			forceCloseShell(shell);
			return;
		}
		void close.catch(() => undefined);
		try {
			await withTimeout(close, SHELL_CLOSE_TIMEOUT_MS, "Timed out closing shell session");
		} catch {
			forceCloseShell(shell);
		}
	})();
	shellClosePromises.set(shell, closing);
	void closing.finally(() => {
		if (shellClosePromises.get(shell) === closing) shellClosePromises.delete(shell);
	});
	return closing;
}

function removeRetainedShell(record: RetainedShell): void {
	if (retainedShells.get(record.shell) !== record) return;
	if (record.reapTimer) clearInterval(record.reapTimer);
	if (record.forceReapTimer) clearTimeout(record.forceReapTimer);
	retainedShells.delete(record.shell);
}

function scheduleRetainedForceReap(record: RetainedShell): void {
	if (record.forceReapTimer) return;
	record.forceReapTimer = setTimeout(() => {
		void reapRetainedShell(record, true);
	}, RETAIN_MAX_AGE_MS);
	record.forceReapTimer.unref?.();
}

async function reapRetainedShell(record: RetainedShell, force = false): Promise<void> {
	if (retainedShells.get(record.shell) !== record) return;
	if (force) {
		removeRetainedShell(record);
		forceCloseShell(record.shell);
		return;
	}

	let live: number;
	try {
		live = await withTimeout(
			record.shell.liveBackgroundJobCount(),
			RETAIN_PROBE_TIMEOUT_MS,
			"Timed out checking retained shell background jobs",
		);
	} catch {
		scheduleRetainedForceReap(record);
		return;
	}
	if (live > 0) return;
	removeRetainedShell(record);
	await closeShell(record.shell);
}

async function retainShellWithLiveBackgroundJobs(
	shell: Shell,
	sessionKey: string,
	sessionOwner: BashSessionOwner | undefined,
): Promise<void> {
	let live: number;
	try {
		live = await shell.liveBackgroundJobCount();
	} catch {
		return;
	}
	if (live <= 0 || retainedShells.has(shell)) return;
	if (isDisposedSessionKey(sessionKey, sessionOwner)) {
		await closeShell(shell);
		return;
	}

	const record: RetainedShell = { shell, sessionKey, disposeRequested: false };
	record.reapTimer = setInterval(() => {
		void reapRetainedShell(record);
	}, RETAIN_REAP_INTERVAL_MS);
	record.reapTimer.unref?.();
	retainedShells.set(shell, record);
}

function quarantineShellSession(
	sessionKey: string,
	shell: Shell,
	runPromise: Promise<ShellRunResult>,
	abortCleanupPromise: Promise<void> | undefined,
	sessionOwner: BashSessionOwner | undefined,
): void {
	brokenShellSessions.add(sessionKey);
	const cleanup = abortCleanupPromise
		? Promise.allSettled([runPromise, abortCleanupPromise])
		: Promise.allSettled([runPromise]);
	if (isDisposedSessionKey(sessionKey, sessionOwner)) {
		void cleanup.catch(() => undefined);
		return;
	}
	const record: QuarantinedShellSession = { shell, cleanup };
	shellSessionQuarantines.set(sessionKey, record);
	void cleanup
		.finally(async () => {
			if (shellSessionQuarantines.get(sessionKey) === record) {
				shellSessionQuarantines.delete(sessionKey);
				brokenShellSessions.delete(sessionKey);
			}
			// An interrupted shell is never reused. Abort stops the current run,
			// while close releases the native session and any process-group state.
			await closeShell(shell);
		})
		.catch(() => undefined);
}

function collectShellsForSession(sessionId: string): Set<Shell> {
	const shells = new Set<Shell>();
	for (const [sessionKey, shell] of shellSessions) {
		if (!belongsToSession(sessionKey, sessionId)) continue;
		shellSessions.delete(sessionKey);
		shells.add(shell);
	}
	for (const [sessionKey, record] of shellSessionQuarantines) {
		if (!belongsToSession(sessionKey, sessionId)) continue;
		shellSessionQuarantines.delete(sessionKey);
		brokenShellSessions.delete(sessionKey);
		shells.add(record.shell);
	}
	for (const [shell, active] of activeShells) {
		if (!belongsToSession(active.sessionKey, sessionId)) continue;
		active.abortController.abort();
		activeShells.delete(shell);
		shells.add(shell);
	}
	for (const sessionKey of brokenShellSessions) {
		if (belongsToSession(sessionKey, sessionId)) brokenShellSessions.delete(sessionKey);
	}
	for (const sessionKey of [...lostShellStates.keys()]) {
		if (belongsToSession(sessionKey, sessionId)) lostShellStates.delete(sessionKey);
	}
	for (const record of [...shellLanes.values()]) {
		if (record.sessionKey === sessionId) cancelSlots(record, [...record.slots], "dispose");
	}
	return shells;
}

export async function disposeBashSessions(sessionId: string, owner?: BashSessionOwner): Promise<void> {
	if (!sessionId) return;
	const activeOwner = activeBashSessionOwners.get(sessionId);
	const sessionOwner = owner ?? activeOwner ?? getOrCreateBashSessionOwner(sessionId);
	if (owner && activeOwner && activeOwner !== owner) return;
	sessionOwner.disposed = true;
	const shells = collectShellsForSession(sessionId);
	const retainedReaps: Promise<void>[] = [];
	for (const record of retainedShells.values()) {
		if (!belongsToSession(record.sessionKey, sessionId)) continue;
		if (!record.disposeRequested) {
			record.disposeRequested = true;
			scheduleRetainedForceReap(record);
		}
		retainedReaps.push(reapRetainedShell(record));
	}
	await Promise.all([...retainedReaps, ...[...shells].map(shell => closeShell(shell))]);
	if (owner !== undefined && activeBashSessionOwners.get(sessionId) === sessionOwner) {
		activeBashSessionOwners.delete(sessionId);
	}
}

export async function disposeAllBashSessions(): Promise<void> {
	const shells = new Set<Shell>(shellSessions.values());
	for (const record of shellSessionQuarantines.values()) shells.add(record.shell);
	for (const shell of activeShells.keys()) shells.add(shell);
	for (const shell of retainedShells.keys()) shells.add(shell);
	for (const shell of shellClosePromises.keys()) shells.add(shell);
	shellSessions.clear();
	lostShellStates.clear();
	for (const owner of activeBashSessionOwners.values()) owner.disposed = true;
	activeBashSessionOwners.clear();
	for (const active of activeShells.values()) active.abortController.abort();
	activeShells.clear();
	brokenShellSessions.clear();
	shellSessionQuarantines.clear();
	for (const record of retainedShells.values()) removeRetainedShell(record);
	for (const record of shellLanes.values()) cancelSlots(record, [...record.slots], "dispose");
	shellLanes.clear();
	await Promise.all([...shells].map(shell => closeShell(shell)));
}

function forceDisposeAllBashSessions(): void {
	const shells = new Set<Shell>(shellSessions.values());
	for (const record of shellSessionQuarantines.values()) shells.add(record.shell);
	for (const shell of activeShells.keys()) shells.add(shell);
	for (const shell of retainedShells.keys()) shells.add(shell);
	for (const shell of shellClosePromises.keys()) shells.add(shell);
	shellSessions.clear();
	for (const owner of activeBashSessionOwners.values()) owner.disposed = true;
	activeBashSessionOwners.clear();
	for (const active of activeShells.values()) active.abortController.abort();
	activeShells.clear();
	brokenShellSessions.clear();
	shellSessionQuarantines.clear();
	for (const record of retainedShells.values()) removeRetainedShell(record);
	for (const record of shellLanes.values()) cancelSlots(record, [...record.slots], "dispose");
	shellLanes.clear();
	for (const shell of shells) forceCloseShell(shell);
}

postmortem.register("bash-shell-sessions", reason => {
	if (reason === postmortem.Reason.EXIT) {
		forceDisposeAllBashSessions();
		return;
	}
	return disposeAllBashSessions();
});

function resolveShellCwd(cwd: string | undefined): string | undefined {
	return cwd;
}

export function buildMinimizerOptions(group: ShellMinimizerSettings): MinimizerOptions | undefined {
	if (!group.enabled) return undefined;
	return {
		enabled: true,
		settingsPath: group.settingsPath || undefined,
		only: group.only.length > 0 ? group.only : undefined,
		except: group.except.length > 0 ? group.except : undefined,
		maxCaptureBytes: group.maxCaptureBytes,
		sourceOutlineLevel: group.sourceOutlineLevel === "default" ? undefined : group.sourceOutlineLevel,
		legacyFilters: group.legacyFilters,
	};
}

function shellBasename(shell: string): string {
	return shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

function isBashShell(shell: string): boolean {
	const basename = shellBasename(shell);
	return basename.includes("bash");
}

const UNSUPPORTED_UNQUOTED_CD_CHARS = "\\$`;&|<>(){}*?[]!#\"'";

function hasUnsupportedUnquotedCdSyntax(value: string): boolean {
	for (const char of value) {
		if (/\s/.test(char) || UNSUPPORTED_UNQUOTED_CD_CHARS.includes(char)) return true;
	}
	return false;
}

export function isPersistentShellCdCommand(command: string): boolean {
	if (/[\r\n]/.test(command)) return false;

	const trimmed = command.trim();
	if (trimmed === "cd") return true;
	if (!trimmed.startsWith("cd") || !/[ \t]/.test(trimmed[2] ?? "")) return false;

	let rest = trimmed.slice(2).trim();
	if (rest === "" || rest === "--") return true;

	let hasOptionTerminator = false;
	if (/^--[ \t]/.test(rest)) {
		hasOptionTerminator = true;
		rest = rest.slice(2).trimStart();
	}
	if (rest === "") return true;

	const quote = rest[0];
	let target: string;
	let quoted = false;
	if (quote === `"` || quote === "'") {
		if (rest.length < 2 || rest[rest.length - 1] !== quote) return false;
		target = rest.slice(1, -1);
		if (target.includes(quote)) return false;
		if (quote === `"` && /[\\$`\r\n]/.test(target)) return false;
		quoted = true;
	} else {
		if (hasUnsupportedUnquotedCdSyntax(rest)) return false;
		target = rest;
	}

	if (target === "") return false;
	if (/^[+-]\d+$/.test(target)) return false;
	if (!hasOptionTerminator && target.startsWith("-") && target !== "-") return false;
	if (!quoted && target.startsWith("~") && target !== "~" && !target.startsWith("~/")) return false;
	return true;
}

function needsInteractiveShellArg(shell: string): boolean {
	const basename = shellBasename(shell);
	return basename.includes("zsh") || basename.includes("fish");
}

function supportsAutoUserShell(shell: string): boolean {
	const basename = shellBasename(shell);
	return basename.includes("bash") || basename.includes("zsh") || basename.includes("fish");
}

function hasInteractiveShellArg(args: string[]): boolean {
	return args.some(arg => arg === "--interactive" || /^-[^-]*i/.test(arg));
}

function ensureInteractiveShellArgs(shell: string, args: string[]): string[] {
	if (!needsInteractiveShellArg(shell)) return args;

	const effectiveArgs = shellBasename(shell).includes("fish")
		? args.filter(arg => arg !== "-l" && arg !== "--login")
		: args;

	if (hasInteractiveShellArg(effectiveArgs)) return effectiveArgs;

	const commandIndex = effectiveArgs.findIndex(arg => arg === "-c" || arg === "--command");
	if (commandIndex !== -1) {
		return [...effectiveArgs.slice(0, commandIndex), "-i", ...effectiveArgs.slice(commandIndex)];
	}

	const compactCommandIndex = effectiveArgs.findIndex(arg => /^-[^-]*c[^-]*$/.test(arg));
	if (compactCommandIndex !== -1) {
		return effectiveArgs.map((arg, index) => (index === compactCommandIndex ? arg.replace("c", "ic") : arg));
	}

	return [...effectiveArgs, "-i"];
}

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildUserShellCommand(shell: string, args: string[], command: string): string {
	return [shell, ...ensureInteractiveShellArgs(shell, args), command].map(quoteShellArg).join(" ");
}

function resolveUserShellConfig(settings: Settings, baseConfig: ShellConfig): ShellConfig {
	const customShellPath = settings.get("shellPath");
	const envShell = Bun.env.SHELL;
	if (customShellPath || !envShell || envShell === baseConfig.shell) {
		return baseConfig;
	}
	if (!supportsAutoUserShell(envShell) || !isExecutable(envShell)) {
		return baseConfig;
	}

	return {
		...baseConfig,
		shell: envShell,
		env: {
			...baseConfig.env,
			SHELL: envShell,
		},
	};
}

export interface BashLaneReservation {
	readonly sessionKey: string | undefined;
	readonly lane: string;
	/**
	 * Resolves once every earlier reservation on the same lane has been released
	 * and no lane control is in progress. Rejects with {@link LaneCancelledError}
	 * when a lane reset/close/disposal cancels the reservation before admission.
	 */
	readonly ready: Promise<void>;
	/** Aborted (reason: {@link LaneCancelledError}) when lane control cancels this reservation, queued or admitted. */
	readonly signal: AbortSignal;
	/** Idempotent; admits the next reservation on the lane. */
	release(): void;
}

function validateLane(lane: string | undefined): string {
	if (lane !== undefined && (lane.length === 0 || lane.length > 128)) {
		throw new Error("lane must contain 1–128 characters");
	}
	return lane ?? "main";
}

/**
 * Join a lane's FIFO synchronously. Callers that do async preparation before
 * {@link executeBash} reserve at issue time so same-lane calls run in the order
 * they were issued, not the order their preparation finished.
 */
export function reserveBashLane(options: { sessionKey?: string; lane?: string }): BashLaneReservation {
	const lane = validateLane(options.lane);
	const key = laneKey(options.sessionKey, lane);
	let record = shellLanes.get(key);
	if (!record) {
		record = { key, sessionKey: options.sessionKey, lane, slots: [], barriers: 0 };
		shellLanes.set(key, record);
	}
	const slot: LaneSlot = {
		admission: Promise.withResolvers<void>(),
		released: Promise.withResolvers<void>(),
		abort: new AbortController(),
		queuedAt: Date.now(),
	};
	// A cancelled reservation whose holder never awaits `ready` must not surface as an unhandled rejection.
	slot.admission.promise.catch(() => undefined);
	record.slots.push(slot);
	admitNextSlot(record);
	const owner = record;
	let released = false;
	return {
		sessionKey: options.sessionKey,
		lane,
		ready: slot.admission.promise,
		signal: slot.abort.signal,
		release: () => {
			if (released) return;
			released = true;
			removeSlot(owner, slot);
		},
	};
}

export async function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	const reservation =
		options?.laneReservation ?? reserveBashLane({ sessionKey: options?.sessionKey, lane: options?.lane });
	const signal = options?.signal ? AbortSignal.any([options.signal, reservation.signal]) : reservation.signal;
	try {
		if (reservation.sessionKey !== options?.sessionKey || reservation.lane !== (options?.lane ?? "main")) {
			throw new Error("Lane reservation does not match the command's session and lane");
		}
		await untilAborted(signal, () => reservation.ready);
		signal.throwIfAborted();
		options?.onStart?.();
		return await executeBashInLane(command, { ...options, signal });
	} catch (error) {
		if (!signal.aborted) throw error;
		const result: BashResult = {
			exitCode: undefined,
			cancelled: true,
			...(await new OutputSink({}).dump(cancelledAnnotation(signal))),
		};
		return { ...result, execution: executionMetadataForResult(result, { summary: result }) };
	} finally {
		reservation.release();
	}
}

/** Queue and shell state of one lane; never heap values, environment, or command text. */
export interface BashLaneSnapshot {
	lane: string;
	/** Epoch ms the admitted command left the queue; absent when nothing runs. */
	activeSince?: number;
	/** Reservations waiting behind the active command or a lane control. */
	queued: number;
	/** A reset/close is tearing the lane down; new work waits for it. */
	controlling: boolean;
	/**
	 * `live`: a persistent shell holds lane state; `quarantined`: an interrupted
	 * shell is still being cleaned up; `retained`: a discarded shell is kept only
	 * for its background children; `none`: the next command starts a fresh shell.
	 */
	shell: "live" | "quarantined" | "retained" | "none";
	/** A discarded shell's loss is reported to the next command on this lane. */
	stateLossPending: boolean;
}

/** The lane a shell session key belongs to, when it belongs to `sessionKey`. */
function shellLaneOf(shellSessionKey: string, sessionKey: string): string | undefined {
	const separator = shellSessionKey.indexOf("\n");
	const head = separator === -1 ? shellSessionKey : shellSessionKey.slice(0, separator);
	if (head === sessionKey) return "main";
	const prefix = `${sessionKey}:lane:`;
	if (!head.startsWith(prefix)) return undefined;
	try {
		return decodeURIComponent(head.slice(prefix.length));
	} catch {
		return undefined;
	}
}

function requireLaneOwner(sessionKey: string): void {
	if (!sessionKey) throw new Error("Lane control requires a session id");
}

/** Every lane `sessionKey` owns that has queued work, a shell, or a pending loss notice. */
export function listBashLanes(sessionKey: string): BashLaneSnapshot[] {
	requireLaneOwner(sessionKey);
	const lanes = new Map<string, BashLaneSnapshot>();
	const entry = (lane: string): BashLaneSnapshot => {
		let snapshot = lanes.get(lane);
		if (!snapshot) {
			snapshot = { lane, queued: 0, controlling: false, shell: "none", stateLossPending: false };
			lanes.set(lane, snapshot);
		}
		return snapshot;
	};
	for (const record of shellLanes.values()) {
		if (record.sessionKey !== sessionKey) continue;
		const snapshot = entry(record.lane);
		const head = record.slots[0];
		if (head?.admittedAt !== undefined) snapshot.activeSince = head.admittedAt;
		snapshot.queued = record.slots.filter(slot => slot.admittedAt === undefined).length;
		snapshot.controlling = record.barriers > 0;
	}
	const shellStates: [string, BashLaneSnapshot["shell"]][] = [
		...[...retainedShells.values()].map(record => [record.sessionKey, "retained"] as [string, "retained"]),
		...[...shellSessionQuarantines.keys()].map(key => [key, "quarantined"] as [string, "quarantined"]),
		...[...shellSessions.keys()].map(key => [key, "live"] as [string, "live"]),
	];
	for (const [key, state] of shellStates) {
		const lane = shellLaneOf(key, sessionKey);
		if (lane !== undefined) entry(lane).shell = state;
	}
	for (const key of lostShellStates.keys()) {
		const lane = shellLaneOf(key, sessionKey);
		if (lane !== undefined) entry(lane).stateLossPending = true;
	}
	return [...lanes.values()].sort((a, b) => a.lane.localeCompare(b.lane));
}

/** How long lane teardown waits for a cancelled command to hand back its slot before discarding its shell anyway. */
const LANE_CONTROL_DRAIN_MS = 5_000;

/**
 * A destructive lane control in progress. Created synchronously: from then on no
 * reservation is admitted until {@link BashLaneControl.finish}. Only reservations
 * accepted before the barrier are cancelled; later ones run on the replacement.
 */
export interface BashLaneControl {
	readonly lane: string;
	/** Reservations accepted before the barrier that have not been released. */
	pending(): { active: number; queued: number };
	/** Cancels every pre-barrier reservation; queued ones never run. */
	cancel(cause: Exclude<BashLaneCancelCause, "dispose">): { active: number; queued: number };
	/** Waits (bounded) until the cancelled admitted command released its slot. */
	drain(): Promise<void>;
	/**
	 * Discards the lane's shells (live, quarantined, retained with background
	 * children). `notice` is reported once to the next command; undefined forgets
	 * any pending loss notice. Returns the number of shells closed.
	 */
	discardShells(notice: string | undefined): Promise<number>;
	/** Lifts the barrier and admits later reservations. Idempotent. */
	finish(): void;
}

export function beginBashLaneControl(sessionKey: string, lane: string): BashLaneControl {
	requireLaneOwner(sessionKey);
	validateLane(lane);
	const key = laneKey(sessionKey, lane);
	let record = shellLanes.get(key);
	if (!record) {
		record = { key, sessionKey, lane, slots: [], barriers: 0 };
		shellLanes.set(key, record);
	}
	const owner = record;
	owner.barriers++;
	const before = [...owner.slots];
	let finished = false;
	const live = () => before.filter(slot => owner.slots.includes(slot));
	return {
		lane,
		pending: () => {
			const slots = live();
			const active = slots.filter(slot => slot.admittedAt !== undefined).length;
			return { active, queued: slots.length - active };
		},
		cancel: cause => cancelSlots(owner, before, cause),
		drain: async () => {
			const released = Promise.all(before.map(slot => slot.released.promise));
			// A command that ignores its abort must not wedge the control; its shell is discarded next anyway.
			await withTimeout(released, LANE_CONTROL_DRAIN_MS, "Timed out draining lane").catch(() => undefined);
		},
		discardShells: async notice => {
			const shells = new Set<Shell>();
			const inLane = (shellSessionKey: string) => shellLaneOf(shellSessionKey, sessionKey) === lane;
			const touched = new Set<string>();
			for (const [shellSessionKey, shell] of shellSessions) {
				if (!inLane(shellSessionKey)) continue;
				shellSessions.delete(shellSessionKey);
				shells.add(shell);
				touched.add(shellSessionKey);
			}
			for (const [shellSessionKey, quarantined] of shellSessionQuarantines) {
				if (!inLane(shellSessionKey)) continue;
				shellSessionQuarantines.delete(shellSessionKey);
				shells.add(quarantined.shell);
				touched.add(shellSessionKey);
			}
			for (const shellSessionKey of [...brokenShellSessions]) {
				if (!inLane(shellSessionKey)) continue;
				brokenShellSessions.delete(shellSessionKey);
				touched.add(shellSessionKey);
			}
			for (const [shell, active] of activeShells) {
				if (!inLane(active.sessionKey)) continue;
				active.abortController.abort();
				// The lane owns teardown now. Do not keep the abort controller and
				// session key reachable while a stubborn native run drains.
				activeShells.delete(shell);
				shells.add(shell);
			}
			for (const retained of [...retainedShells.values()]) {
				if (!inLane(retained.sessionKey)) continue;
				removeRetainedShell(retained);
				shells.add(retained.shell);
			}
			for (const shellSessionKey of [...lostShellStates.keys()]) {
				if (!inLane(shellSessionKey)) continue;
				lostShellStates.delete(shellSessionKey);
				touched.add(shellSessionKey);
			}
			if (notice !== undefined) for (const shellSessionKey of touched) lostShellStates.set(shellSessionKey, notice);
			await Promise.all([...shells].map(shell => closeShell(shell)));
			return shells.size;
		},
		finish: () => {
			if (finished) return;
			finished = true;
			owner.barriers--;
			admitNextSlot(owner);
		},
	};
}

/** Names the lane control that cancelled a command instead of a bare cancellation. */
function cancelledAnnotation(signal: AbortSignal | undefined): string {
	return signal?.reason instanceof LaneCancelledError ? signal.reason.message : "Command cancelled";
}

async function executeBashInLane(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	const executionStartedAt = performance.now();
	const withExecutionMetadata = (result: BashResult): BashResult => ({
		...result,
		execution: executionMetadataForResult(result, {
			elapsedMs: performance.now() - executionStartedAt,
			timeout: result.timedOut ? makeCommandTimeoutMetadata(options?.timeout) : undefined,
			summary: result,
		}),
	});

	const settings = await Settings.init();
	const baseShellConfig = settings.getShellConfig();
	const shellConfig =
		options?.useUserShell === true ? resolveUserShellConfig(settings, baseShellConfig) : baseShellConfig;
	const { shell, args, env: shellEnv, prefix } = shellConfig;
	const bashShell = isBashShell(shell);
	const snapshotPath = bashShell ? await getOrCreateSnapshot(shell, shellEnv) : null;

	const minimizer = buildMinimizerOptions(settings.getGroup("shellMinimizer"));

	const commandCwd = resolveShellCwd(options?.cwd);

	const preflight = await applyDirenvPreflight(command, commandCwd ?? process.cwd(), {
		callerEnv: options?.env,
		signal: options?.signal,
		timeoutMs: settings.get("bash.direnvLoadTimeoutMs"),
		callerTimeoutMs: options?.timeout,
		direnvSetting: settings.get("bash.direnv"),
		commandPrefix: prefix,
	});
	const commandEnv = buildNonInteractiveEnv(preflight.env);
	const runCdInPersistentShell = options?.useUserShell === true && !prefix && isPersistentShellCdCommand(command);

	const finalCommand =
		options?.useUserShell === true && !bashShell && !runCdInPersistentShell
			? buildUserShellCommand(shell, args, preflight.command)
			: preflight.command;

	const sink = new OutputSink({
		onChunk: options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
		chunkThrottleMs: options?.onChunk ? (options.chunkThrottleMs ?? 50) : 0,
	});

	let acceptingChunks = true;
	const enqueueChunk = (chunk: string) => {
		if (acceptingChunks) sink.push(chunk);
	};

	if (options?.signal?.aborted) {
		return withExecutionMetadata({
			exitCode: undefined,
			cancelled: true,
			...(await sink.dump(cancelledAnnotation(options?.signal))),
		});
	}

	const shellOptions = {
		sessionEnv: shellEnv,
		snapshotPath: snapshotPath ?? undefined,
		minimizer,
	};
	const laneSessionKey =
		options?.lane && options.lane !== "main"
			? `${options.sessionKey ?? ""}:lane:${encodeURIComponent(options.lane)}`
			: options?.sessionKey;
	const sessionKey = buildSessionKey(shell, prefix, snapshotPath, shellEnv, laneSessionKey, minimizer);
	const sessionOwnerId = shellOwnerId(sessionKey);
	const sessionOwner =
		options?.sessionOwner ??
		(sessionOwnerId
			? options?.ephemeral === true
				? activeBashSessionOwners.get(sessionOwnerId)
				: getOrCreateBashSessionOwner(sessionOwnerId)
			: undefined);
	const sessionDisposed = isDisposedSessionKey(sessionKey, sessionOwner);
	if (sessionDisposed) {
		await sink.dispose();
		throw new Error("Bash session is disposed");
	}
	const persistentSessionBroken = brokenShellSessions.has(sessionKey);
	if (persistentSessionBroken) {
		shellSessions.delete(sessionKey);
	}

	let shellSession = persistentSessionBroken || sessionDisposed ? undefined : shellSessions.get(sessionKey);
	if (!shellSession && !persistentSessionBroken && !sessionDisposed) {
		shellSession = new Shell(shellOptions);
		shellSessions.set(sessionKey, shellSession);
	}
	const executionShell = shellSession ?? new Shell(shellOptions);
	const ownsPersistentSession = shellSession !== undefined;
	const userSignal = options?.signal;
	const runAbortController = new AbortController();
	activeShells.set(executionShell, { sessionKey, abortController: runAbortController });
	let abortCleanupPromise: Promise<void> | undefined;
	const abortShell = (): Promise<void> => {
		abortCleanupPromise ??= executionShell.abort().catch(() => undefined);
		return abortCleanupPromise;
	};
	const abortCurrentExecution = () => {
		if (!runAbortController.signal.aborted) {
			runAbortController.abort();
		}
		void abortShell();
	};
	const abortDeferred = Promise.withResolvers<"abort">();
	const abortHandler = () => {
		abortCurrentExecution();
		abortDeferred.resolve("abort");
	};
	if (userSignal) {
		userSignal.addEventListener("abort", abortHandler, { once: true });
	}

	let timeoutTimer: NodeJS.Timeout | undefined;
	const timeoutDeferred = Promise.withResolvers<"timeout">();
	const requestedTimeoutMs = options?.timeout;
	const deadlineTimeoutMs = requestedTimeoutMs === 0 ? undefined : Math.max(1_000, requestedTimeoutMs ?? 300_000);
	const nativeTimeoutMs = requestedTimeoutMs !== undefined && requestedTimeoutMs > 0 ? requestedTimeoutMs : undefined;
	const nativeOwnsTimeout = nativeTimeoutMs !== undefined;
	if (deadlineTimeoutMs !== undefined) {
		const fallbackTimeoutMs = nativeOwnsTimeout
			? deadlineTimeoutMs + NATIVE_TIMEOUT_FALLBACK_GRACE_MS
			: deadlineTimeoutMs;
		timeoutTimer = setTimeout(() => {
			if (!nativeOwnsTimeout) {
				abortCurrentExecution();
			}
			timeoutDeferred.resolve("timeout");
		}, fallbackTimeoutMs);
	}

	let resetSession = false;
	// Why this call discarded the lane's persistent shell; reported by the next call.
	let lostShell: string | undefined;
	const protolensDispatcher = options?.protolens?.createDispatcher(runAbortController.signal);
	const lostState = lostShellStates.get(sessionKey);
	lostShellStates.delete(sessionKey);
	const shellStateLost = lostState
		? `<shell> state lost: lane ${options?.lane ?? "main"} ${lostState}; this call ran in a fresh shell. Earlier exports, shell variables, functions and aliases are gone.`
		: undefined;

	try {
		const runPromise = executionShell.run(
			{
				command: finalCommand,
				cwd: commandCwd,
				env: commandEnv,
				timeoutMs: nativeTimeoutMs,
				protolensCallId: options?.protolens?.callId,
				signal: runAbortController.signal,
			},
			(err, chunk) => {
				if (!err) {
					enqueueChunk(chunk);
				}
			},
			protolensDispatcher,
		);

		const ey = new ExponentialYield();
		const winner = await ey.race<
			{ kind: "result"; result: ShellRunResult } | { kind: "timeout" } | { kind: "abort" }
		>([
			runPromise.then(result => ({ kind: "result" as const, result })),
			timeoutDeferred.promise.then(kind => ({ kind })),
			abortDeferred.promise.then(kind => ({ kind })),
		]);

		if (winner.kind === "timeout" || winner.kind === "abort") {
			acceptingChunks = false;
			const cleanupPromise = abortShell();
			if (shellSession) {
				resetSession = true;
				lostShell =
					winner.kind === "timeout" ? "shell was killed by a timeout" : "shell was killed by a cancellation";
				quarantineShellSession(sessionKey, executionShell, runPromise, cleanupPromise, sessionOwner);
			} else {
				void Promise.allSettled([runPromise, cleanupPromise]);
			}
			const interrupted = await withTimeout(runPromise, 250, "Timed out collecting interrupted shell records").catch(
				() => undefined,
			);
			return withExecutionMetadata({
				exitCode: undefined,
				cancelled: true,
				shellStateLost,
				stageRecords: interrupted?.stageRecords,
				protolensDispatches: interrupted?.protolensDispatches,
				...(winner.kind === "timeout" ? { timedOut: true } : {}),
				...(await sink.dump(
					winner.kind === "timeout" && deadlineTimeoutMs !== undefined
						? `Command timed out after ${Math.round(deadlineTimeoutMs / 1000)} seconds`
						: cancelledAnnotation(options?.signal),
				)),
			});
		}
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
			timeoutTimer = undefined;
		}

		if (winner.result.timedOut) {
			const annotation = options?.timeout
				? `Command timed out after ${Math.round(options.timeout / 1000)} seconds`
				: "Command timed out";
			resetSession = true;
			if (shellSession) {
				lostShell = "shell was killed by a timeout";
				quarantineShellSession(sessionKey, executionShell, runPromise, abortCleanupPromise, sessionOwner);
			}
			return withExecutionMetadata({
				exitCode: undefined,
				cancelled: true,
				timedOut: true,
				shellStateLost,
				stageRecords: winner.result.stageRecords,
				protolensDispatches: winner.result.protolensDispatches,
				...(await sink.dump(annotation)),
			});
		}

		if (winner.result.cancelled) {
			resetSession = true;
			if (shellSession) {
				lostShell = "shell was killed by a cancellation";
				quarantineShellSession(sessionKey, executionShell, runPromise, abortCleanupPromise, sessionOwner);
			}
			return withExecutionMetadata({
				exitCode: undefined,
				cancelled: true,
				shellStateLost,
				stageRecords: winner.result.stageRecords,
				protolensDispatches: winner.result.protolensDispatches,
				...(await sink.dump(cancelledAnnotation(options?.signal))),
			});
		}

		const minimized = winner.result.minimized;
		if (minimized && minimized.text !== minimized.originalText) {
			const artifactId = options?.onMinimizedSave
				? await options.onMinimizedSave(minimized.originalText, {
						filter: minimized.filter,
						inputBytes: minimized.inputBytes,
						outputBytes: minimized.outputBytes,
					})
				: undefined;
			if (artifactId) {
				sink.replace(minimized.text, { summarized: true });
				const sep = minimized.text.endsWith("\n") ? "" : "\n";
				sink.push(`${sep}[raw output: artifact://${artifactId}]\n`);
			}
		}

		// `exit` ends the native session; the Shell handle starts a fresh one on its next run.
		if (winner.result.sessionEnded) lostShell = `shell exited with code ${winner.result.exitCode ?? "unknown"}`;
		return withExecutionMetadata({
			exitCode: winner.result.exitCode,
			cancelled: false,
			shellStateLost,
			workingDir: winner.result.workingDir,
			fsObservations: winner.result.fsObservations,
			protolensDispatches: winner.result.protolensDispatches,
			stageRecords: winner.result.stageRecords,
			...(await sink.dump()),
		});
	} catch (err) {
		resetSession = true;
		lostShell = "shell was discarded after an error";
		throw err;
	} finally {
		activeShells.delete(executionShell);
		await sink.dispose();
		// The result owns the materialized output. Drop the sink's head/tail
		// windows even if a persistent native shell keeps callback closures alive.
		sink.release();
		if (!ownsPersistentSession) {
			await retainShellWithLiveBackgroundJobs(executionShell, sessionKey, sessionOwner);
			if (!retainedShells.has(executionShell)) await closeShell(executionShell);
		}
		if (!runAbortController.signal.aborted) {
			runAbortController.abort();
		}
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
		}
		if (userSignal) {
			userSignal.removeEventListener("abort", abortHandler);
		}
		if (ownsPersistentSession) {
			const disposed = isDisposedSessionKey(sessionKey, sessionOwner);
			const ephemeral = options?.ephemeral === true;
			// Without a session id every caller shares one shell, so the loss has no owner to report it to.
			if (lostShell && options?.sessionKey && !ephemeral && !disposed) lostShellStates.set(sessionKey, lostShell);
			if (resetSession || ephemeral || disposed) {
				if (shellSessions.get(sessionKey) === executionShell) shellSessions.delete(sessionKey);

				if (!resetSession && !disposed && shellSession) {
					await retainShellWithLiveBackgroundJobs(shellSession, sessionKey, sessionOwner);
					if (!retainedShells.has(shellSession)) await closeShell(shellSession);
				} else if (disposed) {
					await closeShell(executionShell);
				}
			}
		}
	}
}

function buildSessionKey(
	shell: string,
	prefix: string | undefined,
	snapshotPath: string | null,
	env: Record<string, string>,
	agentSessionKey?: string,
	minimizer?: MinimizerOptions,
): string {
	const entries = Object.entries(env);
	entries.sort(([a], [b]) => a.localeCompare(b));
	const envSerialized = entries.map(([key, value]) => `${key}=${value}`).join("\n");
	const minimizerSerialized = minimizer ? JSON.stringify(minimizer) : "";
	return [agentSessionKey ?? "", shell, prefix ?? "", snapshotPath ?? "", envSerialized, minimizerSerialized].join(
		"\n",
	);
}
