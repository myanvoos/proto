/**
 * Generic interpreter environment-filtering and runtime-resolution helpers
 * shared by the per-language eval runtime modules (jl/runtime, rb/runtime).
 */
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";

// Secret-shaped names that must never leak into eval cells even when they fall
// under a broad allow-prefix.
const SECRET_KEY_PATTERN = /API[_-]?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|ACCESS[_-]?KEY|PRIVATE[_-]?KEY/i;

interface EnvFilterOptions {
	allowList: string[];
	denyList: string[];
	allowPrefixes: string[];
}

/**
 * Creates an environment filter function based on the provided allowlists, denylists, and prefixes.
 */
export function createEnvFilter(
	options: EnvFilterOptions,
): (env: Record<string, string | undefined>) => Record<string, string | undefined> {
	const normalizedAllowList = new Set(options.allowList);
	const normalizedDenyList = new Set(options.denyList);

	return (env: Record<string, string | undefined>): Record<string, string | undefined> => {
		const filtered: Record<string, string | undefined> = {};
		for (const key in env) {
			const value = env[key];
			if (value === undefined) continue;
			if (normalizedDenyList.has(key)) continue;
			if (normalizedAllowList.has(key)) {
				filtered[key] = value;
				continue;
			}
			if (SECRET_KEY_PATTERN.test(key)) continue;
			if (options.allowPrefixes.some(prefix => key.startsWith(prefix))) {
				filtered[key] = value;
			}
		}
		return filtered;
	};
}

/**
 * Resolve an explicitly configured interpreter path, expanding `~` to the home directory.
 */
export function resolveExplicitPath(interpreter: string, cwd: string): string {
	const expanded =
		interpreter === "~"
			? os.homedir()
			: interpreter.startsWith("~/")
				? path.join(os.homedir(), interpreter.slice(2))
				: interpreter;
	return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

/**
 * Enumerates candidate runtimes in priority order.
 */
export function enumerateRuntimes<T>(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	binaryName: string,
	createRuntime: (executablePath: string, env: Record<string, string | undefined>) => T,
	interpreter?: string,
): T[] {
	if (interpreter) {
		const executablePath = resolveExplicitPath(interpreter, cwd);
		return [createRuntime(executablePath, baseEnv)];
	}
	const systemPath = $which(binaryName);
	return systemPath ? [createRuntime(systemPath, baseEnv)] : [];
}

/**
 * Resolves the highest-priority runtime. Throws when none exists.
 */
export function resolveRuntime<T>(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	binaryName: string,
	createRuntime: (executablePath: string, env: Record<string, string | undefined>) => T,
	interpreter?: string,
): T {
	const [runtime] = enumerateRuntimes(cwd, baseEnv, binaryName, createRuntime, interpreter);
	if (!runtime) {
		const displayName = binaryName.charAt(0).toUpperCase() + binaryName.slice(1);
		throw new Error(`${displayName} executable not found on PATH`);
	}
	return runtime;
}
