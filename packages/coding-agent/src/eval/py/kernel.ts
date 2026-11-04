import * as path from "node:path";
import { $flag, isRecord, logger, Snowflake } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { Settings } from "../../config/settings";
import { KernelStartupCleanupError } from "../kernel-admission";
import {
	BaseKernel,
	getRemainingTimeMs,
	type KernelExecuteOptions,
	type KernelExecuteResult,
	type KernelStartOptions,
	type KernelToolRequestCallback,
	terminateDetachedProcessTree,
	throwIfAborted,
} from "../kernel-base";
import { captureKernelChildCleanup } from "../kernel-process-ownership";
import {
	type KernelTarget,
	kernelTargetCwd,
	parseKernelTarget,
	remoteKernelEnv,
	spawnKernelTarget,
} from "../kernel-target";
import { stageRunnerScript } from "../runner-cache";
import { type ForkserverProcess, ForkserverUnsupportedError, forkPythonKernel } from "./forkserver";
import { PYTHON_REMOTE_RUNNER_SOURCE, PYTHON_RUNNER_SOURCE as RUNNER_SCRIPT } from "./runner-source";
import {
	enumeratePythonRuntimes,
	filterEnv,
	type PythonRuntime,
	resolveExplicitPythonRuntime,
	resolvePythonRuntime,
} from "./runtime";
import { stagePythonRuntimeAssets } from "./runtime-assets";

export type {
	KernelExecuteOptions,
	KernelExecuteResult,
	KernelRuntimeEnv,
	KernelShutdownOptions,
	KernelShutdownResult,
} from "../kernel-base";

export type { KernelDisplayOutput, PythonStatusEvent } from "./display";
export { renderKernelDisplay } from "./display";

const TRACE_IPC = $flag("PI_PYTHON_IPC_TRACE");

const SHUTDOWN_GRACE_MS = 1_000;
const STARTUP_TIMEOUT_MS = 10_000;

const INTERRUPT_ESCALATION_MS = 5_000;
/** Bounds escalation and shutdown before callers abandon a cancelled Python cell. */
export const PYTHON_KERNEL_CANCEL_BUDGET_MS = INTERRUPT_ESCALATION_MS + 3 * SHUTDOWN_GRACE_MS;
const AVAILABILITY_PROBE_TIMEOUT_MS = 1_000;
const AVAILABILITY_PROBE_KILL_GRACE_MS = 250;

/** The runner (and so every kernel cell) needs this Python or newer; keep PROBE_SOURCE in step. */
export const MIN_KERNEL_PYTHON = "3.10";
const TOO_OLD_EXIT_CODE = 3;
const PROBE_SOURCE = "import sys;sys.exit(0 if sys.version_info >= (3, 10) else 3)";

interface PythonKernelAvailability {
	ok: boolean;
	pythonPath?: string;
	reason?: string;
	/** Every interpreter tried runs, but is older than {@link MIN_KERNEL_PYTHON}. */
	tooOld?: boolean;

	runtime?: PythonRuntime;
}

interface AvailabilityProbeResult {
	availability: PythonKernelAvailability;
	timedOut: boolean;
}

interface AvailabilityProbeEntry {
	controller: AbortController;
	promise: Promise<AvailabilityProbeResult>;
}

const MAX_AVAILABILITY_CACHE_ENTRIES = 32;
const availabilityCache = new LRUCache<string, AvailabilityProbeEntry>({
	max: MAX_AVAILABILITY_CACHE_ENTRIES,
});

export async function checkPythonKernelAvailability(
	cwd: string,
	interpreter?: string,
	options?: { forceProbe?: boolean; signal?: AbortSignal },
): Promise<PythonKernelAvailability> {
	throwIfAborted(options?.signal, "Python availability check aborted");
	if (!options?.forceProbe && $flag("PI_PYTHON_SKIP_CHECK")) {
		return { ok: true };
	}
	const resolvedCwd = path.resolve(cwd);
	const key = `${resolvedCwd}\0${interpreter ?? ""}`;
	let entry = availabilityCache.get(key);
	if (!entry) {
		const controller = new AbortController();
		const promise = probePythonKernelAvailability(resolvedCwd, interpreter, controller.signal);
		entry = { controller, promise };
		availabilityCache.set(key, entry);
		void promise.then(
			result => {
				// A version never changes under the same path; other failures may be transient.
				const settled = result.availability.ok || result.availability.tooOld;
				if ((result.timedOut || !settled) && availabilityCache.get(key) === entry) {
					availabilityCache.delete(key);
				}
			},
			() => {
				if (availabilityCache.get(key) === entry) availabilityCache.delete(key);
			},
		);
	}

	const onAbort = (): void => {
		if (availabilityCache.get(key) === entry) availabilityCache.delete(key);
		entry.controller.abort(options?.signal?.reason);
	};
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		const result = await entry.promise;
		throwIfAborted(options?.signal, "Python availability check aborted");
		return result.availability;
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
	}
}

async function probePythonKernelAvailability(
	cwd: string,
	interpreter: string | undefined,
	signal: AbortSignal,
): Promise<AvailabilityProbeResult> {
	let timedOut = false;
	try {
		throwIfAborted(signal, "Python availability check aborted");
		const settings = await Settings.init();
		throwIfAborted(signal, "Python availability check aborted");
		const { env } = settings.getShellConfig();
		const baseEnv = filterEnv(env);
		const runtimes = interpreter
			? [resolveExplicitPythonRuntime(interpreter, cwd, baseEnv)]
			: enumeratePythonRuntimes(cwd, baseEnv);
		if (runtimes.length === 0) {
			return { availability: { ok: false, reason: "Python executable not found on PATH" }, timedOut };
		}

		const failures: string[] = [];
		let tooOld = 0;
		for (const runtime of runtimes) {
			throwIfAborted(signal, "Python availability check aborted");
			try {
				const outcome = await probePythonRuntime(runtime, cwd, signal);
				if (outcome.timedOut) {
					timedOut = true;
					failures.push(`${runtime.pythonPath} (timed out after ${AVAILABILITY_PROBE_TIMEOUT_MS}ms)`);
					continue;
				}
				if (outcome.exitCode === 0) {
					return { availability: { ok: true, pythonPath: runtime.pythonPath, runtime }, timedOut };
				}
				if (outcome.exitCode === TOO_OLD_EXIT_CODE) {
					tooOld++;
					failures.push(`${runtime.pythonPath} (older than Python ${MIN_KERNEL_PYTHON})`);
					continue;
				}
				failures.push(`${runtime.pythonPath} (exit code ${outcome.exitCode})`);
			} catch (error) {
				throwIfAborted(signal, "Python availability check aborted");
				failures.push(`${runtime.pythonPath} (${error instanceof Error ? error.message : String(error)})`);
			}
		}
		return {
			availability: {
				ok: false,
				pythonPath: runtimes[0].pythonPath,
				reason: `No working Python interpreter found. Tried: ${failures.join("; ")}`,
				tooOld: tooOld === runtimes.length,
			},
			timedOut,
		};
	} catch (error) {
		throwIfAborted(signal, "Python availability check aborted");
		return {
			availability: { ok: false, reason: error instanceof Error ? error.message : String(error) },
			timedOut,
		};
	}
}

async function probePythonRuntime(
	runtime: PythonRuntime,
	cwd: string,
	callerSignal: AbortSignal,
): Promise<{ exitCode: number; timedOut: boolean }> {
	throwIfAborted(callerSignal, "Python availability check aborted");
	const timeoutSignal = AbortSignal.timeout(AVAILABILITY_PROBE_TIMEOUT_MS);
	const stopSignal = AbortSignal.any([callerSignal, timeoutSignal]);
	const proc = Bun.spawn([runtime.pythonPath, "-c", PROBE_SOURCE], {
		cwd,
		detached: true,
		env: runtime.env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	let termination: Promise<boolean> | undefined;
	const terminate = (): void => {
		termination ??= terminateDetachedProcessTree(proc, AVAILABILITY_PROBE_KILL_GRACE_MS);
	};
	stopSignal.addEventListener("abort", terminate, { once: true });
	if (stopSignal.aborted) terminate();
	let exitCode: number;
	try {
		exitCode = await proc.exited;
	} finally {
		stopSignal.removeEventListener("abort", terminate);
	}
	await termination;
	throwIfAborted(callerSignal, "Python availability check aborted");
	return { exitCode, timedOut: timeoutSignal.aborted };
}

export class PythonKernel extends BaseKernel {
	readonly target: KernelTarget;
	#interpreter?: string;
	launchMode: "forkserver" | "spawn" | "remote-stdio" = "spawn";
	launchReason?: string;
	forkserverPid?: number;
	startupMs?: number;

	get interpreter(): string | undefined {
		return this.#interpreter;
	}

	#toolRequests = new Map<
		string,
		{
			callback: KernelToolRequestCallback;
			signal: AbortSignal;
			pending: Set<Promise<void>>;
		}
	>();

	constructor(id: string, target: KernelTarget = { kind: "local" }, interpreter?: string) {
		let pendingCallbacks = 0;
		super(id, {
			languageName: "Python",
			traceIpc: TRACE_IPC,
			exitPayload: JSON.stringify({ type: "exit" }),
			interruptEscalationMs: INTERRUPT_ESCALATION_MS,
			shutdownGraceMs: SHUTDOWN_GRACE_MS,
			detachedProcessTree: true,
			buildPayload: (code, msgId, opts) => {
				return JSON.stringify({
					id: msgId,
					code,
					cwd: target.kind === "local" ? opts?.cwd : (target.cwd ?? opts?.cwd),
					env:
						target.kind === "local"
							? opts?.env
							: remoteKernelEnv(
									Object.fromEntries(
										Object.entries(opts?.env ?? {}).filter(
											(entry): entry is [string, string] => typeof entry[1] === "string",
										),
									),
								),
					shellEnv: target.kind === "local" ? opts?.shellEnv : undefined,
					stdin: Boolean(opts?.stdin),
					invocation: opts?.invocation,
					fsObservations: opts?.fsObservations,
				});
			},
			buildCancelPayload: msgId => JSON.stringify({ type: "cancel", id: msgId }),
			captureCancellationCleanup: target.kind === "local" ? () => captureKernelChildCleanup(this.pid) : undefined,
			onFrame: frame => {
				if (frame.type !== "tool_request") return false;
				const run = frame.id ? this.#toolRequests.get(frame.id) : undefined;
				const reply = async (): Promise<void> => {
					try {
						if (
							!run ||
							run.signal.aborted ||
							!frame.id ||
							!frame.requestId ||
							!frame.payload ||
							typeof frame.payload.name !== "string" ||
							!isRecord(frame.payload.args) ||
							(frame.payload.cwd !== undefined && typeof frame.payload.cwd !== "string")
						)
							throw new Error("No active parent-owned Python harness run");
						if (pendingCallbacks >= 64) throw new Error("Kernel tool callback concurrency limit exceeded");
						pendingCallbacks++;
						let value: unknown;
						try {
							value = await run.callback(
								{
									name: frame.payload.name,
									args: frame.payload.args,
									cwd: frame.payload.cwd,
								},
								run.signal,
							);
						} finally {
							pendingCallbacks--;
						}
						await this.writeControl({
							type: "tool_response",
							requestId: frame.requestId,
							name: frame.payload.name,
							reply: { ok: true, value },
						});
					} catch (error) {
						await this.writeControl({
							type: "tool_response",
							requestId: frame.requestId,
							reply: { ok: false, error: { message: error instanceof Error ? error.message : String(error) } },
						});
					}
				};
				const task = reply().catch(error =>
					logger.debug("Kernel target callback transport closed", { error: String(error) }),
				);
				run?.pending.add(task);
				void task.finally(() => run?.pending.delete(task));
				return true;
			},
		});
		this.target = target;
		this.#interpreter = interpreter;
	}

	override async execute(code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		const id = Snowflake.next();
		const abort = new AbortController();
		const pending = new Set<Promise<void>>();
		if (options?.onToolRequest)
			this.#toolRequests.set(id, {
				callback: options.onToolRequest,
				signal: AbortSignal.any([abort.signal, ...(options.signal ? [options.signal] : [])]),
				pending,
			});
		try {
			return await super.execute(code, { ...options, id });
		} finally {
			this.#toolRequests.delete(id);
			abort.abort(new Error("Python harness execution settled"));
			await Promise.allSettled([...pending]);
		}
	}

	static async start(options: KernelStartOptions): Promise<PythonKernel> {
		const target = parseKernelTarget(options.target);
		if (target.kind !== "local") return await PythonKernel.#startTarget(options, target);
		const availability = await logger.time(
			"PythonKernel.start:availabilityCheck",
			checkPythonKernelAvailability,
			options.cwd,
			options.interpreter,
			{ signal: options.signal },
		);
		if (!availability.ok) {
			throw new Error(availability.reason ?? "Python kernel unavailable");
		}

		let runtime = availability.runtime;
		if (!runtime) {
			const { env: shellEnv } = (await Settings.init()).getShellConfig();
			runtime = options.interpreter
				? resolveExplicitPythonRuntime(options.interpreter, options.cwd, filterEnv(shellEnv))
				: resolvePythonRuntime(options.cwd, filterEnv(shellEnv));
		}
		const spawnEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(runtime.env)) {
			if (typeof value === "string") spawnEnv[key] = value;
		}
		for (const [key, value] of Object.entries(options.env ?? {})) {
			if (typeof value === "string") spawnEnv[key] = value;
		}
		spawnEnv.PYTHONUNBUFFERED = "1";
		spawnEnv.PYTHONIOENCODING = "utf-8";
		const packageRoot = await stagePythonRuntimeAssets();
		spawnEnv.PYTHONPATH = [packageRoot, spawnEnv.PYTHONPATH].filter(Boolean).join(path.delimiter);

		const scriptPath = await stageRunnerScript("proto-python-runner", "py", RUNNER_SCRIPT);
		const kernel = new PythonKernel(Snowflake.next(), target, runtime.pythonPath);
		spawnEnv.PI_KERNEL_GENERATION = kernel.id;
		spawnEnv.PI_KERNEL_TARGET = JSON.stringify(target);

		let forked: ForkserverProcess | undefined;
		if (process.platform === "darwin" || process.platform === "linux") {
			try {
				forked = await forkPythonKernel({
					interpreter: runtime.pythonPath,
					runnerPath: scriptPath,
					cwd: options.cwd,
					env: spawnEnv,
					signal: options.signal,
				});
			} catch (error) {
				if (!(error instanceof ForkserverUnsupportedError)) throw error;
				kernel.launchReason = error.message;
			}
		} else kernel.launchReason = "Local forkserver requires a supported POSIX CPython runtime";
		if (forked) {
			kernel.launchMode = "forkserver";
			kernel.forkserverPid = forked.serverPid;
			kernel.startupMs = forked.startupMs;
			kernel.setProcess(forked.process);
		} else {
			const proc = Bun.spawn([runtime.pythonPath, "-u", scriptPath], {
				cwd: options.cwd,
				detached: true,
				env: spawnEnv,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			kernel.setProcess(proc);
		}

		const startup = { signal: options.signal, deadlineMs: options.deadlineMs };
		const phaseBudget = (): number =>
			Math.min(getRemainingTimeMs(startup.deadlineMs) ?? STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_MS);

		try {
			throwIfAborted(startup.signal, "Python kernel startup aborted");
			const ready = await kernel.requestStatus(phaseBudget());
			throwIfAborted(startup.signal, "Python kernel startup aborted");
			if (!ready) throw new Error("Python kernel did not acknowledge startup readiness");
			kernel.#interpreter = ready.interpreter ?? runtime.pythonPath;
			return kernel;
		} catch (err) {
			const shutdown = await kernel.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
			if (!shutdown?.confirmed) {
				throw new KernelStartupCleanupError(err, () => kernel.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS }));
			}
			throw err;
		}
	}

	static async #startTarget(
		options: KernelStartOptions,
		target: Exclude<KernelTarget, { kind: "local" }>,
	): Promise<PythonKernel> {
		throwIfAborted(options.signal, "Python target startup aborted");
		const cwd = kernelTargetCwd(target, options.cwd);
		const interpreter = options.interpreter ?? target.interpreter ?? "python3";
		const env: Record<string, string> = {
			...remoteKernelEnv(options.env),
			PYTHONUNBUFFERED: "1",
			PYTHONIOENCODING: "utf-8",
			PI_KERNEL_STDIO_BRIDGE: "1",
			PI_KERNEL_REMOTE: "1",
			PI_KERNEL_TARGET: JSON.stringify(target),
		};
		// Remote runners carry the explicit package; compressed source avoids argv limits.
		const source = Buffer.from(Bun.gzipSync(PYTHON_REMOTE_RUNNER_SOURCE)).toString("base64");
		const bootstrap = `import base64,gzip;__file__="<proto-python-runner>";exec(compile(gzip.decompress(base64.b64decode("${source}")),__file__,"exec"))`;
		const kernel = new PythonKernel(Snowflake.next(), target, interpreter);
		env.PI_KERNEL_GENERATION = kernel.id;
		kernel.launchMode = "remote-stdio";
		const spawned = await spawnKernelTarget(target, [interpreter, "-u", "-c", bootstrap], {
			cwd,
			discoveryCwd: options.discoveryCwd ?? options.cwd,
			env,
		});
		kernel.setProcess(spawned.proc, spawned.terminate, spawned.interrupt);
		const budget = (): number =>
			Math.min(getRemainingTimeMs(options.deadlineMs) ?? STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_MS);
		try {
			throwIfAborted(options.signal, "Python target startup aborted");
			const ready = await kernel.requestStatus(budget());
			throwIfAborted(options.signal, "Python target startup aborted");
			if (!ready) throw new Error("Python target did not acknowledge startup readiness");
			kernel.#interpreter = ready.interpreter ?? interpreter;
			return kernel;
		} catch (error) {
			const result = await kernel.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS });
			if (!result.confirmed)
				throw new KernelStartupCleanupError(error, () => kernel.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS }));
			throw error;
		}
	}
}
