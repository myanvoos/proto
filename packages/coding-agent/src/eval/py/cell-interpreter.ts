import { $which } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import { checkPythonKernelAvailability } from "./kernel";
import { filterEnv, pythonEnvironmentIdentity, resolveExplicitPythonRuntime, resolvePythonRuntime } from "./runtime";

/** A shell `python` command as the Brush builtin reports it. */
export interface PythonCellCommand {
	/** The command word as typed: `python`, `python3.13`, `.venv/bin/python`. */
	program?: string;
	/** The executable the shell resolves that word to; absent when nothing matches. */
	interpreter?: string;
}

/**
 * Where a shell `python` command runs: a cell on the lane's default kernel,
 * a cell on a kernel for a specific interpreter, or — when no kernel can run
 * there — the plain process the shell would have started.
 */
export type PythonCellRoute = { kind: "kernel"; interpreter?: string } | { kind: "external"; tooOld: boolean };

export interface PythonCellRouteOptions {
	/** Directory default-interpreter discovery runs from (project `.venv`). */
	cwd: string;
	/** Interpreter pinned by context kernel start/reset for this lane; bare names use it. */
	laneInterpreter?: string;
	/** The `python.interpreter` setting. */
	settingInterpreter?: string;
	signal?: AbortSignal;
}

/**
 * Choose the interpreter the way the shell itself would:
 * - a command naming an interpreter (`.venv/bin/python`, `python3.13`) runs on it;
 * - bare `python`/`python3` follows the cell's own PATH (an activated venv, an
 *   exported PATH) when that selects a different interpreter than the host's
 *   PATH does. An untouched shell, or a lane pinned by context kernel start/reset, keeps the
 *   default: pinned or configured interpreter, project `.venv`, managed env.
 * The default kernel's own interpreter maps back to the default, so a lane
 * holds one kernel per interpreter.
 */
export async function routePythonCell(
	command: PythonCellCommand,
	options: PythonCellRouteOptions,
): Promise<PythonCellRoute> {
	const defaultInterpreter = options.laneInterpreter ?? options.settingInterpreter;
	const defaultAvailability = await checkPythonKernelAvailability(options.cwd, defaultInterpreter, {
		signal: options.signal,
	});
	const onDefault = (): PythonCellRoute =>
		defaultAvailability.ok ? { kind: "kernel" } : { kind: "external", tooOld: defaultAvailability.tooOld === true };

	const { program, interpreter } = command;
	if (!program || !interpreter) return onDefault();
	if (program === "python" || program === "python3") {
		if (options.laneInterpreter) return onDefault();
		const hostChoice = $which(program) ?? $which(program === "python" ? "python3" : "python");
		if (hostChoice && sameEnvironment(hostChoice, interpreter)) return onDefault();
	}
	const defaultPath = defaultAvailability.pythonPath ?? (await discoverDefaultPath(options.cwd, defaultInterpreter));
	if (defaultPath && sameEnvironment(defaultPath, interpreter)) return onDefault();

	const availability = await checkPythonKernelAvailability(options.cwd, interpreter, {
		forceProbe: true,
		signal: options.signal,
	});
	return availability.ok
		? { kind: "kernel", interpreter }
		: { kind: "external", tooOld: availability.tooOld === true };
}

function sameEnvironment(a: string, b: string): boolean {
	return pythonEnvironmentIdentity(a) === pythonEnvironmentIdentity(b);
}

/** The interpreter a default kernel starts on when availability probing is skipped. */
async function discoverDefaultPath(cwd: string, configured: string | undefined): Promise<string | undefined> {
	const env = filterEnv((await Settings.init()).getShellConfig().env);
	if (configured) return resolveExplicitPythonRuntime(configured, cwd, env).pythonPath;
	try {
		return resolvePythonRuntime(cwd, env).pythonPath;
	} catch {
		return undefined;
	}
}
