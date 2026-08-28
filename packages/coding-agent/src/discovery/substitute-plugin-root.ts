import * as path from "node:path";

const CLAUDE_VAR = "$" + "{CLAUDE_PLUGIN_ROOT}";
const PROTO_VAR = "$" + "{PROTO_PLUGIN_ROOT}";

export function substitutePluginRoot<T>(value: T, rootPath: string): T {
	if (typeof value === "string") {
		return value.replaceAll(CLAUDE_VAR, rootPath).replaceAll(PROTO_VAR, rootPath) as T;
	}
	if (Array.isArray(value)) {
		return value.map(v => substitutePluginRoot(v, rootPath)) as T;
	}
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = Object.create(null);
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			Object.defineProperty(result, k, {
				value: substitutePluginRoot(v, rootPath),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return result as T;
	}
	return value;
}

type StdioCommandBase = "config-dir" | "cwd";

export function resolvePluginStdioPaths(
	config: { command?: string; cwd?: string },
	configDir: string,
	commandBase: StdioCommandBase = "config-dir",
): { command?: string; cwd?: string } {
	const resolved: { command?: string; cwd?: string } = {};
	if (typeof config.cwd === "string") {
		resolved.cwd = path.isAbsolute(config.cwd) ? config.cwd : path.resolve(configDir, config.cwd);
	}
	if (config.command !== undefined) {
		const isPathLike = /^\.\.?[/\\]/.test(config.command);
		const base = commandBase === "cwd" ? (resolved.cwd ?? configDir) : configDir;
		resolved.command = isPathLike ? path.resolve(base, config.command) : config.command;
	}
	return resolved;
}
