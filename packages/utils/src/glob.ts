import * as path from "node:path";
import { Glob } from "bun";
import { getProjectDir } from "./dirs";

export interface GlobPathsOptions {
	cwd?: string;

	exclude?: string[];

	signal?: AbortSignal;

	timeoutMs?: number;

	dot?: boolean;

	onlyFiles?: boolean;

	gitignore?: boolean;
}

const ALWAYS_IGNORED = ["**/.git", "**/.git/**"];

const NODE_MODULES_IGNORED = ["**/node_modules", "**/node_modules/**"];

function parseGitignorePatterns(content: string, gitignoreDir: string, baseDir: string): string[] {
	const patterns: string[] = [];

	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();

		if (!line || line.startsWith("#")) {
			continue;
		}

		if (line.startsWith("!")) {
			continue;
		}

		let pattern = line;

		const isDirectoryOnly = pattern.endsWith("/");
		if (isDirectoryOnly) {
			pattern = pattern.slice(0, -1);
		}

		if (pattern.startsWith("/")) {
			const absolutePattern = path.join(gitignoreDir, pattern.slice(1));
			const relativeToBase = path.relative(baseDir, absolutePattern);
			if (relativeToBase.startsWith("..")) {
				continue;
			}
			pattern = relativeToBase.replace(/\\/g, "/");
			if (isDirectoryOnly) {
				patterns.push(pattern);
				patterns.push(`${pattern}/**`);
			} else {
				patterns.push(pattern);
			}
		} else {
			if (pattern.includes("/")) {
				patterns.push(`**/${pattern}`);
				if (isDirectoryOnly) {
					patterns.push(`**/${pattern}/**`);
				}
			} else {
				patterns.push(`**/${pattern}`);
				if (isDirectoryOnly) {
					patterns.push(`**/${pattern}/**`);
				}
			}
		}
	}

	return patterns;
}

export async function loadGitignorePatterns(baseDir: string): Promise<string[]> {
	const patterns: string[] = [];
	const absoluteBase = path.resolve(baseDir);

	let current = absoluteBase;
	const maxDepth = 50;

	for (let i = 0; i < maxDepth; i++) {
		const gitignorePath = path.join(current, ".gitignore");

		try {
			const content = await Bun.file(gitignorePath).text();
			const filePatterns = parseGitignorePatterns(content, current, absoluteBase);
			patterns.push(...filePatterns);
		} catch {}

		const parent = path.dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}

	return patterns;
}

export async function globPaths(patterns: string | string[], options: GlobPathsOptions = {}): Promise<string[]> {
	const { cwd, exclude, signal, timeoutMs, dot, onlyFiles = true, gitignore } = options;

	const patternArray = Array.isArray(patterns) ? patterns : [patterns];
	const mentionsNodeModules = patternArray.some(p => p.includes("node_modules"));

	const baseExclude = mentionsNodeModules ? [...ALWAYS_IGNORED] : [...ALWAYS_IGNORED, ...NODE_MODULES_IGNORED];
	let effectiveExclude = exclude ? [...baseExclude, ...exclude] : baseExclude;

	if (gitignore) {
		const gitignorePatterns = await loadGitignorePatterns(cwd ?? getProjectDir());
		effectiveExclude = [...effectiveExclude, ...gitignorePatterns];
	}

	const base = cwd ?? getProjectDir();
	const allResults: string[] = [];

	const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
	const combinedSignal =
		signal && timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : (signal ?? timeoutSignal);

	for (const pattern of patternArray) {
		const glob = new Glob(pattern);
		const scanOptions = {
			cwd: base,
			dot,
			onlyFiles,
			throwErrorOnBrokenSymlink: false,
		};

		for await (const entry of glob.scan(scanOptions)) {
			if (combinedSignal?.aborted) {
				const reason = combinedSignal.reason;
				if (reason instanceof Error) throw reason;
				throw new DOMException("Aborted", "AbortError");
			}

			const normalized = entry.replace(/\\/g, "/");
			let excluded = false;
			for (const excludePattern of effectiveExclude) {
				const excludeGlob = new Glob(excludePattern);
				if (excludeGlob.match(normalized)) {
					excluded = true;
					break;
				}
			}
			if (!excluded) {
				allResults.push(normalized);
			}
		}
	}

	return allResults;
}
