import * as path from "node:path";
import { $flag, isBunTestRuntime, logger, Snowflake } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { Settings } from "../../config/settings";
import { BaseKernel, getRemainingTimeMs, type KernelStartOptions } from "../kernel-base";
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

interface PythonKernelAvailability {
	ok: boolean;
	pythonPath?: string;
	reason?: string;

	runtime?: PythonRuntime;
}

const availabilityCache = new Map<string, Promise<PythonKernelAvailability>>();

export async function checkPythonKernelAvailability(
	cwd: string,
	interpreter?: string,
	options?: { forceProbe?: boolean },
): Promise<PythonKernelAvailability> {
	if (!options?.forceProbe && (isBunTestRuntime() || $flag("PI_PYTHON_SKIP_CHECK"))) {
		return { ok: true };
	}
	const resolvedCwd = path.resolve(cwd);
	const key = `${resolvedCwd}\0${interpreter ?? ""}`;
	const cached = availabilityCache.get(key);
	if (cached) return await cached;
	const probe = probePythonKernelAvailability(resolvedCwd, interpreter);
	availabilityCache.set(key, probe);
	const result = await probe;
	if (!result.ok && availabilityCache.get(key) === probe) {
		availabilityCache.delete(key);
	}
	return result;
}

async function probePythonKernelAvailability(cwd: string, interpreter?: string): Promise<PythonKernelAvailability> {
	try {
		const settings = await Settings.init();
		const { env } = settings.getShellConfig();
		const baseEnv = filterEnv(env);
		const runtimes = interpreter
			? [resolveExplicitPythonRuntime(interpreter, cwd, baseEnv)]
			: enumeratePythonRuntimes(cwd, baseEnv);
		if (runtimes.length === 0) {
			return { ok: false, reason: "Python executable not found on PATH" };
		}

		const failures: string[] = [];
		for (const runtime of runtimes) {
			try {
				const probe = await $`${runtime.pythonPath} -c "import sys;sys.exit(0)"`
					.quiet()
					.nothrow()
					.cwd(cwd)
					.env(runtime.env);
				if (probe.exitCode === 0) {
					return { ok: true, pythonPath: runtime.pythonPath, runtime };
				}
				failures.push(`${runtime.pythonPath} (exit code ${probe.exitCode})`);
			} catch (err) {
				failures.push(`${runtime.pythonPath} (${err instanceof Error ? err.message : String(err)})`);
			}
		}
		return {
			ok: false,
			pythonPath: runtimes[0].pythonPath,
			reason: `No working Python interpreter found. Tried: ${failures.join("; ")}`,
		};
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
}

export class PythonKernel extends BaseKernel {
	private constructor(id: string) {
		super(id, {
			languageName: "Python",
			traceIpc: TRACE_IPC,
			exitPayload: JSON.stringify({ type: "exit" }),
			interruptEscalationMs: INTERRUPT_ESCALATION_MS,
			shutdownGraceMs: SHUTDOWN_GRACE_MS,
			buildPayload: (code, msgId, opts) =>
				JSON.stringify({
					id: msgId,
					code,
					cwd: opts?.cwd,
					env: opts?.env,
					silent: opts?.silent ?? false,
					storeHistory: opts?.storeHistory ?? !(opts?.silent ?? false),
					...(opts?.prelude ? { prelude: true } : {}),
				}),
		});
	}

	static async start(options: KernelStartOptions): Promise<PythonKernel> {
		const availability = await logger.time(
			"PythonKernel.start:availabilityCheck",
			checkPythonKernelAvailability,
			options.cwd,
			options.interpreter,
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
