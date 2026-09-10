import { ExponentialYield } from "@oh-my-pi/pi-agent-core/utils/yield";
import { type FsObservation, type MinimizerOptions, Shell, type ShellRunResult } from "@oh-my-pi/pi-natives";
import { logger, postmortem, withTimeout } from "@oh-my-pi/pi-utils";
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
	sessionOwner?: BashSessionOwner;

	env?: Record<string, string>;

	useUserShell?: boolean;

	xd?: {
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
	xdDispatches?: string[];
	collector?: { state: "running" | "complete" | "failed" | "unavailable"; error?: string };
	outputDisposition?: "complete" | "truncated" | "summarized" | "unavailable";
	summarized?: boolean;
	actionableDiagnostics?: string[];
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
const shellSessionsInUse = new Set<string>();

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
	const asyncSeparator = owner.indexOf(":async:");
	return asyncSeparator === -1 ? owner : owner.slice(0, asyncSeparator);
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
		.finally(() => {
			if (shellSessionQuarantines.get(sessionKey) === record) {
				shellSessionQuarantines.delete(sessionKey);
				brokenShellSessions.delete(sessionKey);
			}
		})
		.catch(() => undefined);
}

function collectShellsForSession(sessionId: string): Set<Shell> {
	const shells = new Set<Shell>();
	for (const [sessionKey, shell] of shellSessions) {
		if (!belongsToSession(sessionKey, sessionId)) continue;
		shellSessions.delete(sessionKey);
		shellSessionsInUse.delete(sessionKey);
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
	return shells;
}

export function hasBashSessions(sessionId: string): boolean {
	if (!sessionId) return false;
	for (const sessionKey of shellSessions.keys()) {
		if (belongsToSession(sessionKey, sessionId)) return true;
	}
	for (const sessionKey of shellSessionQuarantines.keys()) {
		if (belongsToSession(sessionKey, sessionId)) return true;
	}
	for (const active of activeShells.values()) {
		if (belongsToSession(active.sessionKey, sessionId)) return true;
	}
	for (const record of retainedShells.values()) {
		if (belongsToSession(record.sessionKey, sessionId)) return true;
	}
	for (const sessionKey of brokenShellSessions) {
		if (belongsToSession(sessionKey, sessionId)) return true;
	}
	return false;
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
}

export async function disposeAllBashSessions(): Promise<void> {
	const shells = new Set<Shell>(shellSessions.values());
	for (const record of shellSessionQuarantines.values()) shells.add(record.shell);
	for (const shell of activeShells.keys()) shells.add(shell);
	for (const shell of retainedShells.keys()) shells.add(shell);
	for (const shell of shellClosePromises.keys()) shells.add(shell);
	shellSessions.clear();
	for (const active of activeShells.values()) active.abortController.abort();
	activeShells.clear();
	shellSessionsInUse.clear();
	brokenShellSessions.clear();
	shellSessionQuarantines.clear();
	for (const record of retainedShells.values()) removeRetainedShell(record);
	await Promise.all([...shells].map(shell => closeShell(shell)));
}

function forceDisposeAllBashSessions(): void {
	const shells = new Set<Shell>(shellSessions.values());
	for (const record of shellSessionQuarantines.values()) shells.add(record.shell);
	for (const shell of activeShells.keys()) shells.add(shell);
	for (const shell of retainedShells.keys()) shells.add(shell);
	for (const shell of shellClosePromises.keys()) shells.add(shell);
	shellSessions.clear();
	for (const active of activeShells.values()) active.abortController.abort();
	activeShells.clear();
	shellSessionsInUse.clear();
	brokenShellSessions.clear();
	shellSessionQuarantines.clear();
	for (const record of retainedShells.values()) removeRetainedShell(record);
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

export async function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
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
			...(await sink.dump("Command cancelled")),
		});
	}

	const shellOptions = {
		sessionEnv: shellEnv,
		snapshotPath: snapshotPath ?? undefined,
		minimizer,
	};
	const sessionKey = buildSessionKey(shell, prefix, snapshotPath, shellEnv, options?.sessionKey, minimizer);
	const sessionOwnerId = shellOwnerId(sessionKey);
	const sessionOwner =
		options?.sessionOwner ?? (sessionOwnerId ? getOrCreateBashSessionOwner(sessionOwnerId) : undefined);
	const sessionDisposed = isDisposedSessionKey(sessionKey, sessionOwner);
	if (sessionDisposed) {
		await sink.dispose();
		throw new Error("Bash session is disposed");
	}
	const persistentSessionBroken = brokenShellSessions.has(sessionKey);
	if (persistentSessionBroken) {
		shellSessions.delete(sessionKey);
	}

	const sessionBusy = shellSessionsInUse.has(sessionKey);
	let shellSession =
		persistentSessionBroken || sessionBusy || sessionDisposed ? undefined : shellSessions.get(sessionKey);
	if (!shellSession && !persistentSessionBroken && !sessionBusy && !sessionDisposed) {
		shellSession = new Shell(shellOptions);
		shellSessions.set(sessionKey, shellSession);
	}
	const executionShell = shellSession ?? new Shell(shellOptions);
	const ownsPersistentSession = shellSession !== undefined;
	if (ownsPersistentSession) {
		shellSessionsInUse.add(sessionKey);
	}
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
	const xdDispatcher = options?.xd?.createDispatcher(runAbortController.signal);

	try {
		const runPromise = executionShell.run(
			{
				command: finalCommand,
				cwd: commandCwd,
				env: commandEnv,
				timeoutMs: nativeTimeoutMs,
				xdCallId: options?.xd?.callId,
				signal: runAbortController.signal,
			},
			(err, chunk) => {
				if (!err) {
					enqueueChunk(chunk);
				}
			},
			xdDispatcher,
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
				quarantineShellSession(sessionKey, executionShell, runPromise, cleanupPromise, sessionOwner);
			} else {
				void Promise.allSettled([runPromise, cleanupPromise]);
			}
			return withExecutionMetadata({
				exitCode: undefined,
				cancelled: true,
				...(winner.kind === "timeout" ? { timedOut: true } : {}),
				...(await sink.dump(
					winner.kind === "timeout" && deadlineTimeoutMs !== undefined
						? `Command timed out after ${Math.round(deadlineTimeoutMs / 1000)} seconds`
						: "Command cancelled",
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
				quarantineShellSession(sessionKey, executionShell, runPromise, abortCleanupPromise, sessionOwner);
			}
			return withExecutionMetadata({
				exitCode: undefined,
				cancelled: true,
				timedOut: true,
				...(await sink.dump(annotation)),
			});
		}

		if (winner.result.cancelled) {
			resetSession = true;
			if (shellSession) {
				quarantineShellSession(sessionKey, executionShell, runPromise, abortCleanupPromise, sessionOwner);
			}
			return withExecutionMetadata({
				exitCode: undefined,
				cancelled: true,
				...(await sink.dump("Command cancelled")),
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

		return withExecutionMetadata({
			exitCode: winner.result.exitCode,
			cancelled: false,
			workingDir: winner.result.workingDir,
			fsObservations: winner.result.fsObservations,
			xdDispatches: winner.result.xdDispatches,
			...(await sink.dump()),
		});
	} catch (err) {
		resetSession = true;
		throw err;
	} finally {
		activeShells.delete(executionShell);
		await sink.dispose();
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
			if (shellSessions.get(sessionKey) === executionShell) shellSessionsInUse.delete(sessionKey);
			const disposed = isDisposedSessionKey(sessionKey, sessionOwner);
			const asynchronous = options?.sessionKey?.includes(":async:") === true;
			if (resetSession || asynchronous || disposed) {
				if (shellSessions.get(sessionKey) === executionShell) shellSessions.delete(sessionKey);

				if (!resetSession && !disposed && shellSession) {
					await retainShellWithLiveBackgroundJobs(shellSession, sessionKey, sessionOwner);
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
