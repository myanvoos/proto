import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getConfigAgentDirName, getProjectDir } from "@oh-my-pi/pi-utils";
import { resolveClaudePaths } from "./config/claude-paths";
import { expandTilde } from "./tools/path-utils";

export * from "./config/config-file";

const priorityList = [
	{ dir: CONFIG_DIR_NAME, globalAgentDir: getConfigAgentDirName },

	{ dir: ".pi", globalAgentDir: () => ".pi/agent" },
	{ dir: ".claude" },
	{ dir: ".codex" },
	{ dir: ".gemini" },
];

function walkUpForPackageDir(startDir: string): string | undefined {
	let dir = startDir;
	while (dir !== path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, "package.json"))) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

export function getPackageDir(): string | undefined {
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		return expandTilde(envDir);
	}
	return walkUpForPackageDir(import.meta.dir);
}

export function getChangelogPath(): string | undefined {
	const packageDir = getPackageDir();
	return packageDir ? path.resolve(packageDir, "CHANGELOG.md") : undefined;
}

const USER_CONFIG_BASES = priorityList.map(({ dir, globalAgentDir }) => ({
	base: () =>
		dir === ".claude" ? resolveClaudePaths().configDir : path.join(os.homedir(), globalAgentDir?.() ?? dir),
	name: dir,
}));

const PROJECT_CONFIG_BASES = priorityList.map(({ dir }) => ({
	base: dir,
	name: dir,
}));

interface ConfigDirEntry {
	path: string;
	source: string;
	level: "user" | "project";
}

interface GetConfigDirsOptions {
	user?: boolean;

	project?: boolean;

	cwd?: string;

	existingOnly?: boolean;
}

export function getConfigDirs(subpath: string, options: GetConfigDirsOptions = {}): ConfigDirEntry[] {
	const { user = true, project = true, cwd = getProjectDir(), existingOnly = false } = options;
	const results: ConfigDirEntry[] = [];

	if (user) {
		for (const { base, name } of USER_CONFIG_BASES) {
			const resolvedPath = path.resolve(base(), subpath);
			if (!existingOnly || fs.existsSync(resolvedPath)) {
				results.push({ path: resolvedPath, source: name, level: "user" });
			}
		}
	}

	if (project) {
		for (const { base, name } of PROJECT_CONFIG_BASES) {
			const resolvedPath = path.resolve(cwd, base, subpath);
			if (!existingOnly || fs.existsSync(resolvedPath)) {
				results.push({ path: resolvedPath, source: name, level: "project" });
			}
		}
	}

	return results;
}

export function getConfigDirPaths(subpath: string, options: GetConfigDirsOptions = {}): string[] {
	return getConfigDirs(subpath, options).map(e => e.path);
}

interface ConfigFileResult<T> {
	path: string;
	source: string;
	level: "user" | "project";
	content: T;
}

export function findConfigFile(subpath: string, options: GetConfigDirsOptions = {}): string | undefined {
	const dirs = getConfigDirs("", { ...options, existingOnly: false });

	for (const { path: base } of dirs) {
		const filePath = path.join(base, subpath);
		if (fs.existsSync(filePath)) {
			return filePath;
		}
	}

	return undefined;
}

export function findConfigFileWithMeta(
	subpath: string,
	options: GetConfigDirsOptions = {},
): Omit<ConfigFileResult<never>, "content"> | undefined {
	const dirs = getConfigDirs("", { ...options, existingOnly: false });

	for (const { path: base, source, level } of dirs) {
		const filePath = path.join(base, subpath);
		if (fs.existsSync(filePath)) {
			return { path: filePath, source, level };
		}
	}

	return undefined;
}

export function findAllNearestProjectConfigDirs(subpath: string, cwd: string = getProjectDir()): ConfigDirEntry[] {
	const results: ConfigDirEntry[] = [];
	const foundBases = new Set<string>();

	let currentDir = cwd;

	while (foundBases.size < PROJECT_CONFIG_BASES.length) {
		for (const { base, name } of PROJECT_CONFIG_BASES) {
			if (foundBases.has(name)) continue;

			const candidate = path.join(currentDir, base, subpath);
			try {
				if (fs.statSync(candidate).isDirectory()) {
					results.push({ path: candidate, source: name, level: "project" });
					foundBases.add(name);
				}
			} catch {}
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	const order = PROJECT_CONFIG_BASES.map(b => b.name);
	results.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));

	return results;
}
