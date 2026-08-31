import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { generateDiffString } from "../edit/diff";
import * as git from "../utils/git";
import type { EvalStatusEvent } from "./types";

const SHA_LENGTH = 16;
const MAX_WALK_FILES = 20000;
const MAX_DIFF_CHARS = 32000;
const MAX_EVENTS_PER_CELL = 50;
const MAX_CACHE_ENTRIES = 512;
const MAX_CACHE_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURE_CONTENT_BYTES = 16 * 1024 * 1024;
const PRUNED_DIRS = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"__pycache__",
	".venv",
	"venv",
	".tox",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".cache",
	".cargo",
	".rustup",
	".bun",
	".npm",
	".local",
	"target",
	"build",
	"dist",
	".next",
	".nuxt",
	".output",
	".turbo",
	".parcel-cache",
	"coverage",
]);

interface StatEntry {
	mtimeMs: number;
	size: number;
}

interface ContentEntry {
	sha: string;
	content?: string;
}

interface IgnoredPaths {
	dirs: Set<string>;
	files: Set<string>;
}

export interface FsSnapshot {
	root: string;
	stats: Map<string, StatEntry>;
	dirty?: Set<string>;
	repoRoot?: string;
	ignored?: IgnoredPaths;
	truncated: boolean;
}

export function sha256Prefix(bytes: Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(bytes);
	return hasher.digest("hex").slice(0, SHA_LENGTH);
}

function looksBinaryText(text: string): boolean {
	return text.slice(0, 8192).includes("\u0000");
}

export function capEventDiff(before: string, after: string): { diff: string; diffTruncated?: true } | undefined {
	const rows = generateDiffString(before, after, 2)
		.diff.split("\n")
		.filter(row => row.length > 0);
	if (rows.length === 0) return undefined;
	const kept: string[] = [];
	let used = 0;
	for (const row of rows) {
		if (used + row.length + 1 > MAX_DIFF_CHARS) break;
		kept.push(row);
		used += row.length + 1;
	}
	return kept.length < rows.length ? { diff: kept.join("\n"), diffTruncated: true } : { diff: kept.join("\n") };
}

function alreadyReported(
	events: readonly EvalStatusEvent[] | undefined,
	absPath: string,
	afterSha: string,
	root: string,
): boolean {
	if (!events) return false;
	return events.some(
		event =>
			(event.op === "write" || event.op === "edit") &&
			typeof event.path === "string" &&
			path.resolve(root, event.path) === absPath &&
			typeof event.sha === "string" &&
			event.sha === afterSha,
	);
}

function parsePorcelainZ(stdout: string, repoRoot: string): Set<string> {
	const dirty = new Set<string>();
	const fields = stdout.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (field.length < 4) continue;
		const x = field[0];
		const y = field[1];
		if (field[2] !== " ") continue;
		if ((x === " " || x === "!") && (y === " " || y === "!")) continue;
		const relPath = field.slice(3);
		dirty.add(path.isAbsolute(relPath) ? relPath : path.join(repoRoot, relPath));
		if (x === "R" || x === "C" || y === "R" || y === "C") i++;
	}
	return dirty;
}

export class CellFsTracker {
	readonly #content = new Map<string, ContentEntry & { mtimeMs: number; size: number }>();
	#cacheContentBytes = 0;
	#repoRoots = new Map<string, string>();

	noteWrite(absPath: string, content: string): void {
		void fs
			.stat(absPath)
			.then(st => {
				this.#remember(absPath, st.mtimeMs, st.size, {
					sha: sha256Prefix(new TextEncoder().encode(content)),
					content,
				});
			})
			.catch(() => {});
	}

	async #resolveRepoRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
		const known = this.#repoRoots.get(cwd);
		if (known !== undefined) return known;
		try {
			const result = await git.runUnchecked(cwd, ["rev-parse", "--show-toplevel"], { signal });
			if (result.exitCode !== 0) return undefined;
			const root = result.stdout.trim();
			this.#repoRoots.set(cwd, root);
			return root;
		} catch {
			return undefined;
		}
	}

	async #indexEntry(repoRoot: string, relPath: string, signal?: AbortSignal): Promise<ContentEntry | undefined> {
		try {
			const result = await git.runUnchecked(repoRoot, ["cat-file", "blob", `:${relPath}`], { signal });
			if (result.exitCode !== 0) return undefined;
			const bytes = new TextEncoder().encode(result.stdout);
			const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
			if (looksBinaryText(text)) return undefined;
			return { sha: sha256Prefix(bytes), content: text };
		} catch {
			return undefined;
		}
	}

	async #ignoredPaths(repoRoot: string, signal?: AbortSignal): Promise<IgnoredPaths> {
		const dirs = new Set<string>();
		const files = new Set<string>();
		try {
			const result = await git.runUnchecked(
				repoRoot,
				["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
				{ signal },
			);
			if (result.exitCode !== 0) return { dirs, files };
			for (const field of result.stdout.split("\0")) {
				if (!field) continue;
				if (field.endsWith("/")) dirs.add(path.join(repoRoot, field));
				else files.add(path.join(repoRoot, field));
			}
		} catch {
			return { dirs, files };
		}
		return { dirs, files };
	}

	async capture(root: string, signal?: AbortSignal): Promise<FsSnapshot> {
		const repoRoot = await this.#resolveRepoRoot(root, signal);
		const ignored = repoRoot ? await this.#ignoredPaths(repoRoot, signal) : undefined;
		const walked = await this.#walk(root, ignored, signal);
		let dirty: Set<string> | undefined;
		if (repoRoot) {
			try {
				dirty = parsePorcelainZ(await git.status(repoRoot, { z: true, untrackedFiles: "all" }), repoRoot);
			} catch {
				dirty = undefined;
			}
		}
		if (dirty) {
			const dirtyPaths = [...walked.stats.keys()].filter(abs => dirty.has(abs)).sort();
			let budget = MAX_CAPTURE_CONTENT_BYTES;
			for (const abs of dirtyPaths) {
				if (budget <= 0) break;
				const stat = walked.stats.get(abs);
				if (!stat || this.#content.has(abs)) continue;
				const entry = await this.#readAfter(abs);
				if (entry.content !== undefined && entry.content.length <= budget) {
					budget -= entry.content.length;
					this.#remember(abs, stat.mtimeMs, stat.size, entry);
				}
			}
		}
		return { ...walked, dirty, repoRoot, ignored };
	}

	async #walk(root: string, ignored?: IgnoredPaths, signal?: AbortSignal): Promise<FsSnapshot> {
		const stats = new Map<string, StatEntry>();
		const truncated = false;
		const stack: string[] = [root];
		while (stack.length > 0) {
			if (signal?.aborted) break;
			const dir = stack.pop()!;
			let dirents: Dirent[];
			try {
				dirents = await fs.readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const dirent of dirents) {
				if (stats.size >= MAX_WALK_FILES) {
					return { root, stats, truncated: true };
				}
				const abs = path.join(dir, dirent.name);
				if (dirent.isDirectory()) {
					if (!PRUNED_DIRS.has(dirent.name) && !ignored?.dirs.has(abs)) stack.push(abs);
					continue;
				}
				if (!dirent.isFile() || ignored?.files.has(abs)) continue;
				try {
					const st = await fs.stat(abs);
					stats.set(abs, { mtimeMs: st.mtimeMs, size: st.size });
				} catch {}
			}
		}
		return { root, stats, truncated };
	}

	async #readAfter(absPath: string): Promise<ContentEntry> {
		const bytes = new Uint8Array(await Bun.file(absPath).arrayBuffer());
		const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
		const sha = sha256Prefix(bytes);
		if (looksBinaryText(text)) {
			return { sha };
		}
		return { sha, content: text };
	}

	#remember(absPath: string, mtimeMs: number, size: number, entry: ContentEntry): void {
		const existing = this.#content.get(absPath);
		if (existing) this.#cacheContentBytes -= existing.content?.length ?? 0;
		this.#content.set(absPath, { ...entry, mtimeMs, size });
		this.#cacheContentBytes += entry.content?.length ?? 0;
		while (this.#content.size > MAX_CACHE_ENTRIES || this.#cacheContentBytes > MAX_CACHE_CONTENT_BYTES) {
			const oldest = this.#content.keys().next().value;
			if (oldest === undefined) break;
			this.#cacheContentBytes -= this.#content.get(oldest)?.content?.length ?? 0;
			this.#content.delete(oldest);
		}
	}

	#validCachedBefore(
		absPath: string,
		beforeStat: StatEntry | undefined,
	): (ContentEntry & { mtimeMs: number; size: number }) | undefined {
		const cached = this.#content.get(absPath);
		if (!cached || !beforeStat) return undefined;
		return cached.mtimeMs === beforeStat.mtimeMs && cached.size === beforeStat.size ? cached : undefined;
	}

	async emitDiffs(
		before: FsSnapshot,
		onStatus: (event: EvalStatusEvent) => void,
		options: { reportedEvents?: readonly EvalStatusEvent[]; signal?: AbortSignal } = {},
	): Promise<void> {
		const afterIgnored = before.repoRoot ? await this.#ignoredPaths(before.repoRoot, options.signal) : undefined;
		const after = await this.#walk(before.root, afterIgnored, options.signal);
		const candidates: string[] = [];
		const deleted: string[] = [];
		for (const [absPath, stat] of after.stats) {
			const prev = before.stats.get(absPath);
			if (!prev || prev.mtimeMs !== stat.mtimeMs || prev.size !== stat.size) candidates.push(absPath);
		}
		for (const absPath of before.stats.keys()) {
			if (!after.stats.has(absPath)) deleted.push(absPath);
		}
		candidates.sort();
		deleted.sort();

		let emitted = 0;
		const pending = [...deleted, ...candidates];
		for (const absPath of pending) {
			if (emitted >= MAX_EVENTS_PER_CELL) {
				onStatus({ op: "files", count: pending.length - emitted, action: "truncated" });
				break;
			}
			const beforeStat = before.stats.get(absPath);
			const cachedBefore = this.#validCachedBefore(absPath, beforeStat);
			if (deleted.includes(absPath)) {
				this.#content.delete(absPath);
				if (cachedBefore && alreadyReported(options.reportedEvents, absPath, cachedBefore.sha, before.root))
					continue;
				let beforeText = cachedBefore?.content;
				if (
					beforeText === undefined &&
					before.repoRoot &&
					before.dirty &&
					!before.dirty.has(absPath) &&
					beforeStat
				) {
					const baseline = await this.#indexEntry(
						before.repoRoot,
						path.relative(before.repoRoot, absPath),
						options.signal,
					);
					beforeText = baseline?.content;
				}
				const event: EvalStatusEvent = { op: "delete", path: absPath };
				if (beforeText !== undefined) {
					const capped = capEventDiff(beforeText, "");
					if (capped) {
						event.diff = capped.diff;
						if (capped.diffTruncated) event.diffTruncated = true;
					}
				}
				onStatus(event);
				emitted += 1;
				continue;
			}
			const afterStat = after.stats.get(absPath)!;
			const afterEntry = await this.#readAfter(absPath);
			this.#remember(absPath, afterStat.mtimeMs, afterStat.size, afterEntry);
			if (
				cachedBefore?.sha === afterEntry.sha ||
				alreadyReported(options.reportedEvents, absPath, afterEntry.sha, before.root)
			) {
				continue;
			}
			if (afterEntry.content === undefined) {
				onStatus({ op: "write", path: absPath, bytes: afterStat.size, sha: afterEntry.sha });
				emitted += 1;
				continue;
			}
			let beforeText = cachedBefore?.content;
			if (beforeText === undefined && beforeStat === undefined) {
				beforeText = "";
			} else if (beforeText === undefined && before.repoRoot && before.dirty && !before.dirty.has(absPath)) {
				const baseline = await this.#indexEntry(
					before.repoRoot,
					path.relative(before.repoRoot, absPath),
					options.signal,
				);
				if (baseline && baseline.sha === afterEntry.sha) continue;
				beforeText = baseline?.content;
			}
			const event: EvalStatusEvent = {
				op: "write",
				path: absPath,
				chars: afterEntry.content.length,
				sha: afterEntry.sha,
			};
			if (beforeText !== undefined) {
				const capped = capEventDiff(beforeText, afterEntry.content);
				if (capped) {
					event.diff = capped.diff;
					if (capped.diffTruncated) event.diffTruncated = true;
				}
			}
			onStatus(event);
			emitted += 1;
		}
		if (before.truncated || after.truncated) {
			onStatus({ op: "files", action: "truncated" });
		}
	}
}
