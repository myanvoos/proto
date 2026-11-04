import * as path from "node:path";
import { $ } from "bun";
import type { Settings } from "../../config/settings";
import { executeBash } from "../../exec/bash-executor";
import type { ToolSession } from "../../tools";
import { type KernelDisplayOutput, PythonDisplayBudget } from "./display";
import type { PythonResult } from "./executor";
import { registerPythonHarnessRun } from "./harness-bridge";
import type { PythonHarnessRun } from "./harness-types";
import { resolveExplicitPythonRuntime, resolvePythonRuntime } from "./runtime";
import { stagePythonRuntimeAssets } from "./runtime-assets";

interface FreshPythonOptions {
	cwd: string;
	settings: Settings;
	toolSession?: ToolSession;
	signal: AbortSignal;
	onChunk?: (chunk: string) => void;
	onDisplay?: (output: KernelDisplayOutput) => Promise<void> | void;
}

/** User Python submissions are native processes; persistence is explicit in proto_harness. */
export async function executeFreshPython(code: string, options: FreshPythonOptions): Promise<PythonResult> {
	options.signal.throwIfAborted();
	const shellEnvironment = options.settings.getShellConfig().env;
	const interpreter = options.settings.get("python.interpreter")?.trim();
	const runtime = interpreter
		? resolveExplicitPythonRuntime(interpreter, options.cwd, shellEnvironment)
		: resolvePythonRuntime(options.cwd, shellEnvironment);
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(runtime.env)) if (value !== undefined) env[name] = value;
	const displays: KernelDisplayOutput[] = [];
	const pendingDisplays: Promise<void>[] = [];
	const budget = new PythonDisplayBudget();
	let harness: PythonHarnessRun | undefined;
	try {
		if (options.toolSession) {
			harness = await registerPythonHarnessRun(options.toolSession, {
				cwd: options.cwd,
				signal: options.signal,
				env,
				emit: event => {
					if (event.type === "detection") return;
					const output: KernelDisplayOutput =
						event.type === "display" ? event.output : { type: "status", event: event.event };
					for (const admitted of budget.addKernelOutput(output)) {
						displays.push(admitted);
						pendingDisplays.push(Promise.resolve(options.onDisplay?.(admitted)));
					}
				},
			});
		} else {
			const root = await stagePythonRuntimeAssets();
			env.PYTHONPATH = [root, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
		}
		options.signal.throwIfAborted();
		const result = await executeBash(`${$.escape(runtime.pythonPath)} -c ${$.escape(code)}`, {
			cwd: options.cwd,
			env: { ...env, ...harness?.env },
			signal: options.signal,
			onChunk: options.onChunk,
		});
		await Promise.all(pendingDisplays);
		return { ...result, displayOutputs: displays, stdinRequested: false };
	} finally {
		await harness?.dispose();
		budget.release();
	}
}
