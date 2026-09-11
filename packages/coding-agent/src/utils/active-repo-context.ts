import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { type GitRepository, repo } from "./git";

export interface ActiveRepoContext {
	cwd: string;
	repoRoot: string;
	relativeRepoRoot: string;
	source: "single-direct-child-repo";
}

type ReaderResult<T> = T | Promise<T>;

interface ActiveRepoReader {
	resolveRepository(cwd: string): ReaderResult<GitRepository | null>;
	readDirectory(cwd: string): ReaderResult<fs.Dirent[]>;
	stat(filePath: string): ReaderResult<fs.Stats | null>;
}

function compareEntryNames(left: fs.Dirent, right: fs.Dirent): number {
	if (left.name < right.name) return -1;
	if (left.name > right.name) return 1;
	return 0;
}

function buildContext(cwd: string, repoRoot: string): ActiveRepoContext {
	const resolvedCwd = path.resolve(cwd);
	const resolvedRepoRoot = path.resolve(repoRoot);
	return {
		cwd: resolvedCwd,
		repoRoot: resolvedRepoRoot,
		relativeRepoRoot: path.relative(resolvedCwd, resolvedRepoRoot),
		source: "single-direct-child-repo",
	};
}

const asyncReader: ActiveRepoReader = {
	async resolveRepository(cwd) {
		try {
			return await repo.resolve(cwd);
		} catch {
			return null;
		}
	},
	async readDirectory(cwd) {
		try {
			return await fsPromises.readdir(cwd, { withFileTypes: true });
		} catch {
			return [];
		}
	},
	async stat(filePath) {
		try {
			return await fsPromises.stat(filePath);
		} catch {
			return null;
		}
	},
};

const syncReader: ActiveRepoReader = {
	resolveRepository(cwd) {
		try {
			return repo.resolveSync(cwd);
		} catch {
			return null;
		}
	},
	readDirectory(cwd) {
		try {
			return fs.readdirSync(cwd, { withFileTypes: true });
		} catch {
			return [];
		}
	},
	stat(filePath) {
		try {
			return fs.statSync(filePath);
		} catch {
			return null;
		}
	},
};

function* resolveActiveRepoContextCore(
	cwd: string,
	reader: ActiveRepoReader,
): Generator<ReaderResult<unknown>, ActiveRepoContext | null, unknown> {
	const resolvedCwd = path.resolve(cwd);
	const repository = (yield reader.resolveRepository(resolvedCwd)) as GitRepository | null;
	if (repository) return null;

	const entries = (yield reader.readDirectory(resolvedCwd)) as fs.Dirent[];
	entries.sort(compareEntryNames);

	let context: ActiveRepoContext | null = null;
	for (const entry of entries) {
		const childPath = path.join(resolvedCwd, entry.name);
		let resolvedChildPath: string | null;
		if (entry.isDirectory()) {
			resolvedChildPath = childPath;
		} else if (entry.isSymbolicLink()) {
			const stat = (yield reader.stat(childPath)) as fs.Stats | null;
			resolvedChildPath = stat?.isDirectory() ? childPath : null;
		} else {
			continue;
		}

		if (!resolvedChildPath) continue;
		const gitMarker = (yield reader.stat(path.join(resolvedChildPath, ".git"))) as fs.Stats | null;
		if (!gitMarker || (!gitMarker.isDirectory() && !gitMarker.isFile())) continue;
		if (context) return null;
		context = buildContext(resolvedCwd, resolvedChildPath);
	}

	return context;
}

function runSync<T>(operation: Generator<ReaderResult<unknown>, T, unknown>): T {
	let result = operation.next();
	while (!result.done) {
		result = operation.next(result.value);
	}
	return result.value;
}

async function runAsync<T>(operation: Generator<ReaderResult<unknown>, T, unknown>): Promise<T> {
	let result = operation.next();
	while (!result.done) {
		result = operation.next(await result.value);
	}
	return result.value;
}

export async function resolveActiveRepoContext(cwd: string): Promise<ActiveRepoContext | null> {
	return runAsync(resolveActiveRepoContextCore(cwd, asyncReader));
}

export function resolveActiveRepoContextSync(cwd: string): ActiveRepoContext | null {
	return runSync(resolveActiveRepoContextCore(cwd, syncReader));
}
