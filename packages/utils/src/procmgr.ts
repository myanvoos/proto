import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, MAIN_CONFIG_FILENAMES } from "./dirs";
import { $env, filterChildShellEnv } from "./env";
import { $which } from "./which";

export interface ShellConfig {
	shell: string;
	args: string[];
	env: Record<string, string>;
	prefix: string | undefined;
}

/** Identifies the settings source users should edit when shell resolution fails. */
export interface ShellConfigOptions {
	/** File path or runtime layer that supplied the active shell setting. */
	configSource?: string;
}
let cachedShellConfig: ShellConfig | null = null;

/**
 * Check if a shell binary is executable.
 */
export function isExecutable(path: string): boolean {
	try {
		fs.accessSync(path, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Build the spawn environment (cached).
 */
function buildSpawnEnv(shell: string): Record<string, string> {
	const noCI = $env.PI_BASH_NO_CI || $env.CLAUDE_BASH_NO_CI;
	return {
		...filterChildShellEnv(Bun.env),
		SHELL: shell,
		GIT_EDITOR: "true",
		GPG_TTY: "not a tty",
		OMPCODE: "1",
		CLAUDECODE: "1",
		...(noCI ? {} : { CI: "true" }),
	} as Record<string, string>;
}

/**
 * Get shell args for the resolved shell.
 * PowerShell Core (pwsh) takes `-NoLogo -Command`, with `-NoProfile` when
 * PI_BASH_NO_LOGIN / CLAUDE_BASH_NO_LOGIN is set (profile scripts are
 * PowerShell's login-shell analog); POSIX shells take `-c`, with `-l` unless
 * the same env is set.
 *
 * Exported for tests; `env` overrides the process env gate.
 */
export function getShellArgs(shell: string, env: Record<string, string | undefined> = $env): string[] {
	const noLogin = env.PI_BASH_NO_LOGIN || env.CLAUDE_BASH_NO_LOGIN;
	if (isPowerShell(shell)) {
		return noLogin ? ["-NoLogo", "-NoProfile", "-Command"] : ["-NoLogo", "-Command"];
	}
	return noLogin ? ["-c"] : ["-l", "-c"];
}

/**
 * Whether the shell is PowerShell Core (pwsh, legitimate user config on any
 * platform). Spawn paths must use `-Command`: passing the POSIX `-l -c` pair
 * makes PowerShell parse `-l` as the command and fail with
 * `The term '-l' is not recognized`.
 */
export function isPowerShell(shell: string): boolean {
	const basename = shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	return basename === "pwsh";
}

/**
 * Get shell prefix for wrapping commands (profilers, strace, etc.).
 */
function getShellPrefix(): string | undefined {
	return $env.PI_SHELL_PREFIX || $env.CLAUDE_CODE_SHELL_PREFIX;
}

/**
 * Build full shell config from a shell path.
 */
function buildConfig(shell: string): ShellConfig {
	return {
		shell,
		args: getShellArgs(shell),
		env: buildSpawnEnv(shell),
		prefix: getShellPrefix(),
	};
}

/**
 * Resolve a basic shell (bash or sh) as fallback.
 */
export function resolveBasicShell(): string | undefined {
	for (const name of ["bash", "sh"]) {
		const resolved = $which(name);
		if (resolved) return resolved;
	}

	const searchPaths = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
	for (const name of ["bash", "sh"]) {
		for (const dir of searchPaths) {
			const fullPath = path.join(dir, name);
			if (fs.existsSync(fullPath)) return fullPath;
		}
	}

	return undefined;
}

/**
 * Get shell configuration based on platform.
 * Resolution order:
 * 1. User-specified shellPath from the active settings source
 * 2. $SHELL if bash/zsh, then fallback paths
 * 3. Fallback: sh
 */
export function getShellConfig(customShellPath?: string, options: ShellConfigOptions = {}): ShellConfig {
	const configSource = options.configSource ?? path.join(getAgentDir(), MAIN_CONFIG_FILENAMES[0]);
	// 1. Check user-specified shell path. Validated even on the cached path so a
	// broken shellPath surfaces its guidance error instead of being masked by an
	// earlier successful resolution in the same process.
	if (customShellPath) {
		if (!fs.existsSync(customShellPath)) {
			throw new Error(`Custom shell path not found: ${customShellPath}\nPlease update shellPath in ${configSource}`);
		}
		if (cachedShellConfig?.shell !== customShellPath) {
			cachedShellConfig = buildConfig(customShellPath);
		}
		return cachedShellConfig;
	}
	if (cachedShellConfig) {
		return cachedShellConfig;
	}

	// Prefer user's shell from $SHELL if it's bash/zsh and executable
	const userShell = Bun.env.SHELL;
	const isValidShell = userShell && (userShell.includes("bash") || userShell.includes("zsh"));
	if (isValidShell && isExecutable(userShell)) {
		cachedShellConfig = buildConfig(userShell);
		return cachedShellConfig;
	}

	// Fallback: use basic shell
	const basicShell = resolveBasicShell();
	if (basicShell) {
		cachedShellConfig = buildConfig(basicShell);
		return cachedShellConfig;
	}
	cachedShellConfig = buildConfig("sh");
	return cachedShellConfig;
}
