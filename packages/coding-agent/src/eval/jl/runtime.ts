import { createEnvFilter, enumerateRuntimes, resolveExplicitPath, resolveRuntime } from "../runtime-env";

const DEFAULT_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USER",
	"USERNAME",
	"LOGNAME",
	"SHELL",
	"TERM",
	"LANG",
	"TEMP",
	"TMP",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"SSH_CONNECTION",
	"SSH_CLIENT",
	"SSH_TTY",
	"DISPLAY",
	"XAUTHORITY",
	"TZ",
	"LD_LIBRARY_PATH",
	"DYLD_LIBRARY_PATH",
];

const DEFAULT_ENV_DENYLIST = ["PI_API_KEY", "PI_TOKEN", "PI_PASSWORD", "PI_SESSION", "PI_TOOL_BRIDGE_TOKEN"];

const DEFAULT_ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "PI_", "JULIA_", "OPENBLAS_", "MKL_"];

export interface JuliaRuntime {
	juliaPath: string;

	env: Record<string, string | undefined>;
}

export const filterEnv = createEnvFilter({
	allowList: DEFAULT_ENV_ALLOWLIST,
	denyList: DEFAULT_ENV_DENYLIST,
	allowPrefixes: DEFAULT_ENV_ALLOW_PREFIXES,
});

export function resolveExplicitJuliaRuntime(
	interpreter: string,
	cwd: string,
	baseEnv: Record<string, string | undefined>,
): JuliaRuntime {
	const juliaPath = resolveExplicitPath(interpreter, cwd);
	return { juliaPath, env: { ...baseEnv } };
}

export function enumerateJuliaRuntimes(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	interpreter?: string,
): JuliaRuntime[] {
	return enumerateRuntimes(cwd, baseEnv, "julia", (juliaPath, env) => ({ juliaPath, env }), interpreter);
}

export function resolveJuliaRuntime(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	interpreter?: string,
): JuliaRuntime {
	return resolveRuntime(cwd, baseEnv, "julia", (juliaPath, env) => ({ juliaPath, env }), interpreter);
}
