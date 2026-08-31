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

export interface ShellConfigOptions {
	configSource?: string;
}
let cachedShellConfig: ShellConfig | null = null;

export function isExecutable(path: string): boolean {
	try {
		fs.accessSync(path, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

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

export function getShellArgs(env: Record<string, string | undefined> = $env): string[] {
	const noLogin = env.PI_BASH_NO_LOGIN || env.CLAUDE_BASH_NO_LOGIN;
	return noLogin ? ["-c"] : ["-l", "-c"];
}

function getShellPrefix(): string | undefined {
	return $env.PI_SHELL_PREFIX || $env.CLAUDE_CODE_SHELL_PREFIX;
}

function buildConfig(shell: string): ShellConfig {
	return {
		shell,
		args: getShellArgs(),
		env: buildSpawnEnv(shell),
		prefix: getShellPrefix(),
	};
}

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

export function getShellConfig(customShellPath?: string, options: ShellConfigOptions = {}): ShellConfig {
	const configSource = options.configSource ?? path.join(getAgentDir(), MAIN_CONFIG_FILENAMES[0]);

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

	const userShell = Bun.env.SHELL;
	const isValidShell = userShell && (userShell.includes("bash") || userShell.includes("zsh"));
	if (isValidShell && isExecutable(userShell)) {
		cachedShellConfig = buildConfig(userShell);
		return cachedShellConfig;
	}

	const basicShell = resolveBasicShell();
	if (basicShell) {
		cachedShellConfig = buildConfig(basicShell);
		return cachedShellConfig;
	}
	cachedShellConfig = buildConfig("sh");
	return cachedShellConfig;
}
