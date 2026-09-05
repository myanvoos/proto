import { ExponentialYield } from "@oh-my-pi/pi-agent-core/utils/yield";
import { type FsObservation, type MinimizerOptions, Shell, type ShellRunResult } from "@oh-my-pi/pi-natives";
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

const shellSessions = new Map<string, Shell>();
const brokenShellSessions = new Set<string>();
const shellSessionQuarantines = new Map<string, Promise<unknown>>();

const shellSessionsInUse = new Set<string>();

const retainedShells = new Set<Shell>();
const RETAIN_REAP_INTERVAL_MS = 5_000;

const NATIVE_TIMEOUT_FALLBACK_GRACE_MS = 5_000;

function makeCommandTimeoutMetadata(timeoutMs: number | undefined): ExecutionTimeoutMetadata {
	return {
		cause: "deadline",
		scope: "command",
		effectiveMs: timeoutMs,
	};
}

async function retainShellWithLiveBackgroundJobs(shell: Shell): Promise<void> {
	let live: number;
	try {
		live = await shell.liveBackgroundJobCount();
	} catch {
		return;
	}
	if (live <= 0) return;
	retainedShells.add(shell);
	const interval = setInterval(() => {
		void shell
			.liveBackgroundJobCount()
			.then(remaining => {
				if (remaining > 0) return;
				clearInterval(interval);
				retainedShells.delete(shell);
			})
			.catch(() => {
				clearInterval(interval);
				retainedShells.delete(shell);
			});
	}, RETAIN_REAP_INTERVAL_MS);
	interval.unref?.();
}

function quarantineShellSession(
	sessionKey: string,
	runPromise: Promise<ShellRunResult>,
	abortCleanupPromise: Promise<void> | undefined,
): void {
	brokenShellSessions.add(sessionKey);
	const cleanup = abortCleanupPromise
		? Promise.allSettled([runPromise, abortCleanupPromise])
		: Promise.allSettled([runPromise]);
	shellSessionQuarantines.set(sessionKey, cleanup);
	void cleanup
		.finally(() => {
			if (shellSessionQuarantines.get(sessionKey) === cleanup) {
				shellSessionQuarantines.delete(sessionKey);
				brokenShellSessions.delete(sessionKey);
			}
		})
		.catch(() => undefined);
}

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
	const persistentSessionBroken = brokenShellSessions.has(sessionKey);
	if (persistentSessionBroken) {
		shellSessions.delete(sessionKey);
	}

	const sessionBusy = shellSessionsInUse.has(sessionKey);
	let shellSession = persistentSessionBroken || sessionBusy ? undefined : shellSessions.get(sessionKey);
	if (!shellSession && !persistentSessionBroken && !sessionBusy) {
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
				quarantineShellSession(sessionKey, runPromise, cleanupPromise);
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
				quarantineShellSession(sessionKey, runPromise, abortCleanupPromise);
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
				quarantineShellSession(sessionKey, runPromise, abortCleanupPromise);
			}
			return withExecutionMetadata({
				exitCode: undefined,
				cancelled: true,
				...(await sink.dump("Command cancelled")),
			});
		}

		const minimized = winner.result.minimized;
		if (minimized && minimized.text !== minimized.originalText) {
			sink.replace(minimized.text, { summarized: true });
			if (options?.onMinimizedSave) {
				const artifactId = await options.onMinimizedSave(minimized.originalText, {
					filter: minimized.filter,
					inputBytes: minimized.inputBytes,
					outputBytes: minimized.outputBytes,
				});
				if (artifactId) {
					const sep = minimized.text.endsWith("\n") ? "" : "\n";
					sink.push(`${sep}[raw output: artifact://${artifactId}]\n`);
				}
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
		await sink.dispose();
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
		}
		if (userSignal) {
			userSignal.removeEventListener("abort", abortHandler);
		}
		if (ownsPersistentSession) {
			shellSessionsInUse.delete(sessionKey);
			if (resetSession || options?.sessionKey?.includes(":async:")) {
				shellSessions.delete(sessionKey);

				if (!resetSession && shellSession) {
					await retainShellWithLiveBackgroundJobs(shellSession);
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
