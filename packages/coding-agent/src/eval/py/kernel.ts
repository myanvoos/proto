import * as path from "node:path";
import { $flag, isBunTestRuntime, logger, Snowflake } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { Settings } from "../../config/settings";
import {
	BaseKernel,
	getRemainingTimeMs,
	type KernelStartOptions,
	terminateDetachedProcessTree,
	throwIfAborted,
} from "../kernel-base";
import { stageRunnerScript } from "../runner-cache";
import { PYTHON_PRELUDE } from "./prelude";
import RUNNER_SCRIPT from "./runner.py" with { type: "text" };
import {
	enumeratePythonRuntimes,
	filterEnv,
	type PythonRuntime,
	resolveExplicitPythonRuntime,
	resolvePythonRuntime,
} from "./runtime";

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
const AVAILABILITY_PROBE_TIMEOUT_MS = 1_000;
const AVAILABILITY_PROBE_KILL_GRACE_MS = 250;

interface PythonKernelAvailability {
	ok: boolean;
	pythonPath?: string;
	reason?: string;

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
	if (!options?.forceProbe && (isBunTestRuntime() || $flag("PI_PYTHON_SKIP_CHECK"))) {
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
				if ((result.timedOut || !result.availability.ok) && availabilityCache.get(key) === entry) {
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
	const proc = Bun.spawn([runtime.pythonPath, "-c", "import sys;sys.exit(0)"], {
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
	constructor(id: string) {
		super(id, {
			languageName: "Python",
			traceIpc: TRACE_IPC,
			exitPayload: JSON.stringify({ type: "exit" }),
			interruptEscalationMs: INTERRUPT_ESCALATION_MS,
			shutdownGraceMs: SHUTDOWN_GRACE_MS,
			detachedProcessTree: true,
			buildPayload: (code, msgId, opts) =>
				JSON.stringify({
					id: msgId,
					code,
					cwd: opts?.cwd,
					env: opts?.env,
					fsObservations: opts?.fsObservations,
					silent: opts?.silent ?? false,
					storeHistory: opts?.storeHistory ?? !(opts?.silent ?? false),
					...(opts?.prelude ? { prelude: true } : {}),
				}),
			buildCancelPayload: msgId => JSON.stringify({ type: "cancel", id: msgId }),
		});
	}

	static async start(options: KernelStartOptions): Promise<PythonKernel> {
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

		const scriptPath = await stageRunnerScript("proto-python-runner", "py", RUNNER_SCRIPT);
		const kernel = new PythonKernel(Snowflake.next());

		const proc = Bun.spawn([runtime.pythonPath, "-u", scriptPath], {
			cwd: options.cwd,
			detached: true,
			env: spawnEnv,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		kernel.setProcess(proc);

		const startup = { signal: options.signal, deadlineMs: options.deadlineMs };
		const phaseBudget = (): number =>
			Math.min(getRemainingTimeMs(startup.deadlineMs) ?? STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_MS);

		try {
			const initScript = buildInitScript(options.cwd, options.env);
			await kernel.executeWithBudget(initScript, startup.signal, phaseBudget(), "Python kernel init");
			await kernel.executeWithBudget(PYTHON_PRELUDE, startup.signal, phaseBudget(), "Python kernel prelude", {
				prelude: true,
			});
			return kernel;
		} catch (err) {
			await kernel.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS }).catch(() => {});
			throw err;
		}
	}
}
function buildInitScript(cwd: string, env?: Record<string, string | undefined>): string {
	const envEntries = Object.entries(env ?? {}).filter(([, value]) => value !== undefined);
	const envPayload = Object.fromEntries(envEntries);
	return [
		"import os, sys",
		`__proto_cwd = ${JSON.stringify(cwd)}`,
		"os.chdir(__proto_cwd)",
		`__proto_env = ${JSON.stringify(envPayload)}`,
		"for __proto_key, __proto_val in __proto_env.items():\n    os.environ[__proto_key] = __proto_val",
		"if __proto_cwd not in sys.path:\n    sys.path.insert(0, __proto_cwd)",
	].join("\n");
}
