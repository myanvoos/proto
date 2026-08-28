import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { formatBytes, getWorktreeDir, logger, Snowflake } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import * as jj from "../utils/jj";
import { writeIsolationOwner } from "./isolation-ownership";
import { mapWithConcurrencyLimit } from "./parallel";

const { IsoBackendKind } = natives;

const WORKER_ISOLATION_DIR_PREFIX = "t";
const WORKER_ISOLATION_DIR_DIGEST_CHARS = 9;
const WORKER_ISOLATION_MOUNT_DIR = "m";
type IsoBackendKind = natives.IsoBackendKind;

interface RepoBaseline {
	repoRoot: string;
	headCommit: string;
	staged: string;
	unstaged: string;
	untracked: string[];
	untrackedPatch: string;
}

export interface WorktreeBaseline {
	root: RepoBaseline;

	nested: Array<{ relativePath: string; baseline: RepoBaseline }>;
}

export async function getRepoRoot(cwd: string): Promise<string> {
	if (await jj.isPureJjRepo(cwd)) {
		throw new Error(
			"Isolated worker execution requires a Git checkout, but this workspace is pure Jujutsu (`.jj/` without a colocated `.git/`). Run `jj git init --colocate` to add a Git checkout, or set `orchestrator.isolation.mode: none` to disable worker isolation.",
		);
	}

	const repoRoot = await git.repo.root(cwd);
	if (repoRoot) return repoRoot;

	throw new Error("Git repository not found for isolated worker execution.");
}

const GIT_NO_INDEX_NULL_PATH = "/dev/null";

export function getGitNoIndexNullPath(): string {
	return GIT_NO_INDEX_NULL_PATH;
}

async function discoverNestedRepos(repoRoot: string): Promise<string[]> {
	const submodulePaths = new Set(await git.ls.submodules(repoRoot));

	const result: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			if (!entry.isDirectory()) continue;
			const full = path.join(dir, entry.name);
			const rel = path.relative(repoRoot, full);

			const gitDir = path.join(full, ".git");
			let hasGit = false;
			try {
				await fs.access(gitDir);
				hasGit = true;
			} catch {}
			if (hasGit && !submodulePaths.has(rel)) {
				result.push(rel);

				continue;
			}
			await walk(full);
		}
	}
	await walk(repoRoot);
	return result;
}

export const ISOLATION_BASELINE_MAX_CONTENT_BYTES = 1024 * 1024 * 1024;

export class IsolationBaselineTooLargeError extends Error {
	constructor(
		readonly repoRoot: string,
		readonly contentBytes: number,
	) {
		super(
			`Working tree at ${repoRoot} carries ${formatBytes(contentBytes)} of uncommitted content, ` +
				`over the ${formatBytes(ISOLATION_BASELINE_MAX_CONTENT_BYTES)} isolation-snapshot budget. ` +
				`Isolated task snapshots buffer this content in memory, so proceeding would exhaust the host. ` +
				`Commit or gitignore the bulk (untracked files that aren't ignored are the usual culprit), ` +
				`or set \`orchestrator.isolation.mode: none\` to run tasks without isolation.`,
		);
		this.name = "IsolationBaselineTooLargeError";
	}
}

async function sumUntrackedBytes(repoRoot: string, untracked: readonly string[]): Promise<number> {
	if (untracked.length === 0) return 0;
	const { results } = await mapWithConcurrencyLimit([...untracked], 16, async entry => {
		try {
			const stat = await fs.lstat(path.join(repoRoot, entry));
			return stat.isFile() ? stat.size : 0;
		} catch {
			return 0;
		}
	});
	return results.reduce((total: number, size) => total + (size ?? 0), 0);
}

async function captureUntrackedPatch(repoRoot: string, untracked: readonly string[]): Promise<string> {
	if (untracked.length === 0) return "";
	const nullPath = getGitNoIndexNullPath();

	const { results: untrackedDiffs } = await mapWithConcurrencyLimit([...untracked], 8, entry =>
		git.diff(repoRoot, {
			allowFailure: true,
			binary: true,
			noIndex: { left: nullPath, right: entry },
		}),
	);
	return untrackedDiffs.filter((diff): diff is string => !!diff?.trim()).join("\n");
}

async function captureRepoBaseline(repoRoot: string): Promise<RepoBaseline> {
	const headCommit = (await git.head.sha(repoRoot)) ?? "";
	const staged = await git.diff(repoRoot, { binary: true, cached: true });
	const unstaged = await git.diff(repoRoot, { binary: true });
	const untracked = await git.ls.untracked(repoRoot);

	const untrackedBytes = await sumUntrackedBytes(repoRoot, untracked);
	const contentBytes = untrackedBytes + staged.length + unstaged.length;
	if (contentBytes > ISOLATION_BASELINE_MAX_CONTENT_BYTES) {
		throw new IsolationBaselineTooLargeError(repoRoot, contentBytes);
	}
	const untrackedPatch = await captureUntrackedPatch(repoRoot, untracked);
	return { repoRoot, headCommit, staged, unstaged, untracked, untrackedPatch };
}

interface SyntheticTreeOptions {
	readonly threeWay?: boolean;
}

async function writeSyntheticTree(
	repoDir: string,
	baseTreeish: string,
	patches: readonly string[],
	options: SyntheticTreeOptions = {},
): Promise<string> {
	const tempIndex = path.join(os.tmpdir(), `proto-task-index-${Snowflake.next()}`);
	try {
		await git.readTree(repoDir, baseTreeish, {
			env: { GIT_INDEX_FILE: tempIndex },
		});
		for (const patch of patches) {
			if (!patch.trim()) continue;
			await git.patch.applyText(repoDir, patch, {
				cached: true,
				env: { GIT_INDEX_FILE: tempIndex },
				threeWay: options.threeWay,
			});
		}
		return await git.writeTree(repoDir, {
			env: { GIT_INDEX_FILE: tempIndex },
		});
	} finally {
		await fs.rm(tempIndex, { force: true });
	}
}

export async function captureBaseline(repoRoot: string): Promise<WorktreeBaseline> {
	const [root, nestedPaths] = await Promise.all([captureRepoBaseline(repoRoot), discoverNestedRepos(repoRoot)]);
	const nested = await Promise.all(
		nestedPaths.map(async relativePath => ({
			relativePath,
			baseline: await captureRepoBaseline(path.join(repoRoot, relativePath)),
		})),
	);
	return { root, nested };
}

async function captureRepoDeltaPatch(repoDir: string, rb: RepoBaseline, objectRepoDir = repoDir): Promise<string> {
	const currentHead = (await git.head.sha(repoDir)) ?? "";
	const currentStaged = await git.diff(repoDir, { binary: true, cached: true });
	const currentUnstaged = await git.diff(repoDir, { binary: true });
	const currentUntracked = await git.ls.untracked(repoDir);
	const currentUntrackedPatch = await captureUntrackedPatch(repoDir, currentUntracked);
	const committedPatch =
		currentHead && currentHead !== rb.headCommit
			? await git.diff.tree(repoDir, rb.headCommit, currentHead, {
					allowFailure: true,
					binary: true,
				})
			: "";

	const baselineTree = await writeSyntheticTree(objectRepoDir, rb.headCommit, [
		rb.staged,
		rb.unstaged,
		rb.untrackedPatch,
	]);
	const currentTree = await writeSyntheticTree(objectRepoDir, rb.headCommit, [
		committedPatch,
		currentStaged,
		currentUnstaged,
		currentUntrackedPatch,
	]);

	return git.diff.tree(objectRepoDir, baselineTree, currentTree, {
		allowFailure: true,
		binary: true,
	});
}

export interface NestedRepoPatch {
	relativePath: string;
	patch: string;
}

function unquoteGitDiffPath(rawPath: string): string {
	let value = rawPath;
	if (value.startsWith('"') && value.endsWith('"')) {
		try {
			value = JSON.parse(value) as string;
		} catch {
			value = value.slice(1, -1);
		}
	}
	return value.replace(/^[ab]\//, "");
}

function parseDiffGitLinePaths(line: string): string[] {
	if (!line.startsWith("diff --git ")) return [];
	const rest = line.slice("diff --git ".length);
	const quoted = rest.match(/^("(?:\\.|[^"])+"|\/dev\/null) ("(?:\\.|[^"])+"|\/dev\/null)$/);
	const parts = quoted ? [quoted[1], quoted[2]] : rest.split(" ");
	if (parts.length < 2) return [];
	const paths = parts
		.slice(0, 2)
		.map(unquoteGitDiffPath)
		.filter(file => file && file !== "/dev/null");
	return [...new Set(paths)];
}

function patchTouchedFiles(patch: string): string[] {
	const files = new Set<string>();
	for (const line of patch.split("\n")) {
		for (const file of parseDiffGitLinePaths(line)) files.add(file);
	}
	return [...files];
}

interface DeltaPatchResult {
	rootPatch: string;
	nestedPatches: NestedRepoPatch[];
}

export async function captureDeltaPatch(isolationDir: string, baseline: WorktreeBaseline): Promise<DeltaPatchResult> {
	const rootPatch = await captureRepoDeltaPatch(isolationDir, baseline.root, baseline.root.repoRoot);
	const nestedPatches: NestedRepoPatch[] = [];

	for (const { relativePath, baseline: nb } of baseline.nested) {
		const nestedDir = path.join(isolationDir, relativePath);
		try {
			await fs.access(path.join(nestedDir, ".git"));
		} catch {
			continue;
		}
		const patch = await captureRepoDeltaPatch(nestedDir, nb, nb.repoRoot);
		if (patch.trim()) nestedPatches.push({ relativePath, patch });
	}

	return { rootPatch, nestedPatches };
}

export async function applyNestedPatches(
	repoRoot: string,
	patches: NestedRepoPatch[],
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<string[]> {
	const warnings: string[] = [];

	const byRepo = new Map<string, NestedRepoPatch[]>();
	for (const p of patches) {
		if (!p.patch.trim()) continue;
		const group = byRepo.get(p.relativePath) ?? [];
		group.push(p);
		byRepo.set(p.relativePath, group);
	}

	for (const [relativePath, repoPatches] of byRepo) {
		const nestedDir = path.join(repoRoot, relativePath);
		try {
			await fs.access(path.join(nestedDir, ".git"));
		} catch {
			continue;
		}

		const combinedDiff = repoPatches.map(p => p.patch).join("\n");
		const touchedFiles = [...new Set(repoPatches.flatMap(p => patchTouchedFiles(p.patch)))];

		const stashed =
			(await git.status(nestedDir)).trim().length > 0
				? await git.stash.push(nestedDir, `proto-isolation-${Snowflake.next()}`)
				: false;
		try {
			for (const { patch } of repoPatches) {
				await git.patch.applyText(nestedDir, patch);
			}
			if ((await git.status(nestedDir)).trim().length > 0) {
				if (touchedFiles.length === 0) {
					throw new Error(`Nested repo patch for ${relativePath} did not include stageable file paths.`);
				}
				const msg = (await commitMessage?.(combinedDiff)) ?? "changes from isolated worker(s)";
				await git.stage.files(nestedDir, touchedFiles);
				await git.commit(nestedDir, msg);
			}
		} finally {
			if (stashed) {
				const restored = await git.stash.tryPop(nestedDir, { index: true });
				if (!restored) {
					logger.warn("Pre-existing nested-repo dirty state could not be auto-restored", {
						nestedDir,
					});
					warnings.push(
						`Pre-existing dirty state in nested repo \`${relativePath}\` could not be auto-restored after the agent commit; stash entry preserved.`,
					);
				}
			}
		}
	}
	return warnings;
}

type WorkerIsolationMode =
	| "none"
	| "auto"
	| "apfs"
	| "btrfs"
	| "zfs"
	| "reflink"
	| "overlayfs"
	| "rcopy"
	| "worktree"
	| "fuse-overlay";

export function parseIsolationMode(mode: WorkerIsolationMode): IsoBackendKind | undefined {
	switch (mode) {
		case "none":
		case "auto":
			return undefined;
		case "apfs":
			return IsoBackendKind.Apfs;
		case "btrfs":
			return IsoBackendKind.Btrfs;
		case "zfs":
			return IsoBackendKind.Zfs;
		case "reflink":
			return IsoBackendKind.LinuxReflink;
		case "overlayfs":
		case "fuse-overlay":
			return IsoBackendKind.Overlayfs;
		case "rcopy":
		case "worktree":
			return IsoBackendKind.Rcopy;
	}
}

export interface IsolationHandle {
	mergedDir: string;

	backend: IsoBackendKind;

	fellBack: boolean;

	fallbackReason: string | null;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function getTaskIsolationSegment(repoRoot: string, id: string): string {
	const key = `${path.resolve(repoRoot)}\0${id}`;
	const digest = Bun.hash(key).toString(16).padStart(16, "0").slice(-WORKER_ISOLATION_DIR_DIGEST_CHARS);
	return `${WORKER_ISOLATION_DIR_PREFIX}${digest}`;
}

export async function ensureIsolation(
	baseCwd: string,
	id: string,
	preferred?: IsoBackendKind,
): Promise<IsolationHandle> {
	const repoRoot = await getRepoRoot(baseCwd);
	const repository = await git.repo.resolve(repoRoot);
	const sourceCommonDir = repository?.commonDir ?? path.join(repoRoot, ".git");
	const baseDir = getWorktreeDir(getTaskIsolationSegment(repoRoot, id));
	const mergedDir = path.join(baseDir, WORKER_ISOLATION_MOUNT_DIR);
	const resolution = natives.isoResolve(preferred ?? null);
	const candidates = resolution.candidates.length > 0 ? resolution.candidates : [resolution.kind];
	let fallbackReason = resolution.reason ?? null;

	for (const candidate of candidates) {
		await fs.rm(baseDir, { recursive: true, force: true });

		await fs.mkdir(baseDir, { recursive: true });
		await writeIsolationOwner(baseDir, id);
		try {
			await natives.isoStart(candidate, repoRoot, mergedDir);

			await git.detachGitDir(mergedDir, sourceCommonDir);
			return {
				mergedDir,
				backend: candidate,
				fellBack: candidate !== resolution.kind || resolution.fellBack,
				fallbackReason,
			};
		} catch (err) {
			await fs.rm(baseDir, { recursive: true, force: true });
			const message = errorMessage(err);
			if (!natives.isoIsUnavailableError(message)) {
				throw err;
			}
			fallbackReason ??= message;
		}
	}

	throw new Error(fallbackReason ?? "No isolation backend is available.");
}

export async function cleanupIsolation(handle: IsolationHandle): Promise<void> {
	try {
		try {
			await natives.isoStop(handle.backend, handle.mergedDir);
		} catch (err) {
			logger.warn("isolation backend stop failed during cleanup", {
				backend: handle.backend,
				mergedDir: handle.mergedDir,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	} finally {
		const baseDir = path.dirname(handle.mergedDir);
		await fs.rm(baseDir, { recursive: true, force: true });
	}
}

interface CommitToBranchResult {
	branchName?: string;
	nestedPatches: NestedRepoPatch[];

	baseSha?: string;
}

function baselineHasRootWip(baseline: RepoBaseline): boolean {
	return !!(baseline.staged.trim() || baseline.unstaged.trim() || baseline.untrackedPatch.trim());
}

interface BaselineWipContext {
	readonly staged: string;
	readonly unstaged: string;
	readonly untrackedPatch: string;

	readonly untracked: readonly string[];
}

function collectWipPatches(wip: BaselineWipContext | undefined): string[] {
	if (!wip) return [];
	return [wip.staged, wip.unstaged, wip.untrackedPatch].filter(p => p.trim());
}

async function commitPatchToBranchWorktree(
	tmpDir: string,
	taskId: string,
	patchText: string,
	message: string,
	author?: git.CommitAuthor,
	baselineWip?: BaselineWipContext,
): Promise<void> {
	let plainErr: git.GitCommandError | undefined;
	try {
		await git.patch.applyText(tmpDir, patchText);
	} catch (err) {
		if (!(err instanceof git.GitCommandError)) throw err;
		plainErr = err;
	}
	if (plainErr) {
		let threeWayErr: git.GitCommandError | undefined;
		try {
			await git.patch.applyText(tmpDir, patchText, { threeWay: true });
		} catch (err) {
			if (!(err instanceof git.GitCommandError)) throw err;
			threeWayErr = err;
		}
		if (threeWayErr) {
			const wipPatches = collectWipPatches(baselineWip);
			if (wipPatches.length === 0 || !baselineWip) {
				const stderr = threeWayErr.result.stderr.slice(0, 2000);
				logger.error("commitToBranch: git apply --3way failed", {
					taskId,
					exitCode: threeWayErr.result.exitCode,
					stderr,
					initialStderr: plainErr.result.stderr.slice(0, 2000),
					patchSize: patchText.length,
					patchHead: patchText.slice(0, 500),
				});
				throw new Error(`git apply --3way failed for task ${taskId}: ${stderr}`);
			}
			try {
				await git.reset(tmpDir, { hard: true, target: "HEAD" });
				await applyDeltaOverBaselineWip(tmpDir, taskId, patchText, wipPatches, baselineWip);
			} catch (wipErr) {
				if (!(wipErr instanceof git.GitCommandError)) throw wipErr;
				const stderr = wipErr.result.stderr.slice(0, 2000);
				logger.error("commitToBranch: git apply with baseline WIP failed", {
					taskId,
					exitCode: wipErr.result.exitCode,
					stderr,
					threeWayStderr: threeWayErr.result.stderr.slice(0, 2000),
					initialStderr: plainErr.result.stderr.slice(0, 2000),
					patchSize: patchText.length,
					patchHead: patchText.slice(0, 500),
				});
				throw new Error(`git apply with baseline WIP failed for task ${taskId}: ${stderr}`);
			}
		}
	}

	await git.stage.files(tmpDir);
	await git.commit(tmpDir, message, author ? { author } : {});
}

async function applyDeltaOverBaselineWip(
	tmpDir: string,
	_taskId: string,
	patchText: string,
	wipPatches: readonly string[],
	baselineWip: BaselineWipContext,
): Promise<void> {
	for (const wip of wipPatches) {
		await git.patch.applyText(tmpDir, wip);
	}
	await git.patch.applyText(tmpDir, patchText);

	const wipFiles = new Set(wipPatches.flatMap(patchTouchedFiles));
	const deltaFiles = new Set(patchTouchedFiles(patchText));
	const wipOnly = [...wipFiles].filter(f => !deltaFiles.has(f));
	if (wipOnly.length === 0) return;

	const untrackedSet = new Set(baselineWip.untracked);
	const candidates = wipOnly.filter(f => !untrackedSet.has(f));
	const inHead = candidates.length > 0 ? new Set(await git.ls.tree(tmpDir, "HEAD", candidates)) : new Set<string>();
	const toRestore = candidates.filter(f => inHead.has(f));
	const toRemove = wipOnly.filter(f => !toRestore.includes(f));
	if (toRestore.length > 0) {
		await git.restore(tmpDir, { source: "HEAD", staged: true, worktree: true, files: toRestore });
	}
	for (const rel of toRemove) {
		await fs.rm(path.join(tmpDir, rel), { force: true });
	}
}

interface FilteredAgentReplayOptions {
	baseline: WorktreeBaseline;
	branchName: string;
	commitMessage?: (diff: string) => Promise<string | null>;
	fallbackMessage: string;
	isolationDir: string;
	isolationHead: string;
	repoRoot: string;
	rootPatch: string;
	taskId: string;
}

async function replayFilteredAgentCommits(opts: FilteredAgentReplayOptions): Promise<void> {
	const baselineSha = opts.baseline.root.headCommit;
	await git.branch.create(opts.repoRoot, opts.branchName, baselineSha);

	const tmpDir = path.join(os.tmpdir(), `proto-branch-${Snowflake.next()}`);
	try {
		await git.worktree.add(opts.repoRoot, tmpDir, opts.branchName);
		const agentCommits = await git.revList.range(opts.isolationDir, baselineSha, opts.isolationHead);
		const baselineWip = [opts.baseline.root.staged, opts.baseline.root.unstaged, opts.baseline.root.untrackedPatch];

		await writeSyntheticTree(opts.repoRoot, baselineSha, baselineWip);
		const dirtyBaselineTree = await writeSyntheticTree(opts.isolationDir, baselineSha, baselineWip);
		let previousFilteredTree = baselineSha;
		let filteredCommitsApplied = 0;

		for (const commitSha of agentCommits) {
			const taskStatePatch = await git.diff.tree(opts.isolationDir, dirtyBaselineTree, `${commitSha}^{tree}`, {
				allowFailure: true,
				binary: true,
			});
			const currentFilteredTree = await writeSyntheticTree(opts.repoRoot, baselineSha, [taskStatePatch], {
				threeWay: true,
			});
			const commitPatch = await git.diff.tree(opts.repoRoot, previousFilteredTree, currentFilteredTree, {
				allowFailure: true,
				binary: true,
			});
			if (commitPatch.trim()) {
				const details = await git.commitDetails(opts.isolationDir, commitSha);
				await commitPatchToBranchWorktree(
					tmpDir,
					opts.taskId,
					commitPatch,
					details.message || commitSha,
					details.author,
				);
				filteredCommitsApplied++;
			}
			previousFilteredTree = currentFilteredTree;
		}
		if (filteredCommitsApplied === 0) {
			if (opts.rootPatch.trim()) {
				const msg = (opts.commitMessage && (await opts.commitMessage(opts.rootPatch))) || opts.fallbackMessage;
				await commitPatchToBranchWorktree(tmpDir, opts.taskId, opts.rootPatch, msg, undefined, opts.baseline.root);
			}
		} else {
			const finalFilteredTree = await writeSyntheticTree(opts.repoRoot, baselineSha, [opts.rootPatch], {
				threeWay: true,
			});
			const leftoverPatch = await git.diff.tree(opts.repoRoot, previousFilteredTree, finalFilteredTree, {
				allowFailure: true,
				binary: true,
			});
			if (leftoverPatch.trim()) {
				const msg = (opts.commitMessage && (await opts.commitMessage(leftoverPatch))) || opts.fallbackMessage;
				await commitPatchToBranchWorktree(tmpDir, opts.taskId, leftoverPatch, msg);
			}
		}
	} finally {
		await git.worktree.tryRemove(opts.repoRoot, tmpDir);
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
}

export async function commitToBranch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	taskId: string,
	description: string | undefined,
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<CommitToBranchResult | null> {
	const baselineSha = baseline.root.headCommit;
	const isolationHead = (await git.head.sha(isolationDir)) ?? "";
	const agentCommitted = isolationHead !== "" && isolationHead !== baselineSha;

	const { rootPatch, nestedPatches } = await captureDeltaPatch(isolationDir, baseline);
	if (!rootPatch.trim() && nestedPatches.length === 0) return null;
	if (!rootPatch.trim()) return { nestedPatches };

	const repoRoot = baseline.root.repoRoot;
	const branchName = `proto/task/${taskId}`;
	const fallbackMessage = description || taskId;

	let branchCreated = false;

	if (agentCommitted) {
		if (baselineHasRootWip(baseline.root)) {
			await replayFilteredAgentCommits({
				baseline,
				branchName,
				commitMessage,
				fallbackMessage,
				isolationDir,
				isolationHead,
				repoRoot,
				rootPatch,
				taskId,
			});
		} else {
			await git.fetch(repoRoot, isolationDir, "HEAD", `refs/heads/${branchName}`);

			const leftoverPatch = await captureRepoDeltaPatch(isolationDir, {
				repoRoot: isolationDir,
				headCommit: isolationHead,
				staged: "",
				unstaged: "",
				untracked: [],
				untrackedPatch: "",
			});
			if (leftoverPatch.trim()) {
				const tmpDir = path.join(os.tmpdir(), `proto-branch-${Snowflake.next()}`);
				try {
					await git.worktree.add(repoRoot, tmpDir, branchName);
					const msg = (commitMessage && (await commitMessage(leftoverPatch))) || fallbackMessage;
					await commitPatchToBranchWorktree(tmpDir, taskId, leftoverPatch, msg);
				} finally {
					await git.worktree.tryRemove(repoRoot, tmpDir);
					await fs.rm(tmpDir, { recursive: true, force: true });
				}
			}
		}
		branchCreated = true;
	} else if (rootPatch.trim()) {
		await git.branch.create(repoRoot, branchName, baselineSha);
		branchCreated = true;
		const tmpDir = path.join(os.tmpdir(), `proto-branch-${Snowflake.next()}`);
		try {
			await git.worktree.add(repoRoot, tmpDir, branchName);

			const msg = (commitMessage && (await commitMessage(rootPatch))) || fallbackMessage;
			const wip = baselineHasRootWip(baseline.root) ? baseline.root : undefined;
			await commitPatchToBranchWorktree(tmpDir, taskId, rootPatch, msg, undefined, wip);
		} finally {
			await git.worktree.tryRemove(repoRoot, tmpDir);
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	}

	return {
		branchName: branchCreated ? branchName : undefined,
		baseSha: baselineSha,
		nestedPatches,
	};
}

interface MergeBranchResult {
	merged: string[];
	failed: string[];
	conflict?: string;

	stashConflict?: string;
}

export async function mergeTaskBranches(
	repoRoot: string,
	branches: Array<{ branchName: string; taskId: string; description?: string; baseSha?: string }>,
): Promise<MergeBranchResult> {
	return git.withRepoLock(repoRoot, async () => {
		const merged: string[] = [];
		const failed: string[] = [];

		const didStash = await git.stash.push(repoRoot, "proto-worker-merge");

		let conflictResult: MergeBranchResult | undefined;

		try {
			for (const { branchName, baseSha } of branches) {
				try {
					const target = baseSha ? `${baseSha}..${branchName}` : branchName;
					await git.cherryPick(repoRoot, target);
				} catch (initialErr) {
					let cursor: unknown = initialErr;
					while (git.cherryPick.isEmptyError(cursor)) {
						try {
							await git.cherryPick.skip(repoRoot);
							cursor = undefined;
							break;
						} catch (skipErr) {
							cursor = skipErr;
						}
					}
					if (cursor === undefined) {
						merged.push(branchName);
						continue;
					}
					try {
						await git.cherryPick.abort(repoRoot);
					} catch {}
					const stderr =
						cursor instanceof git.GitCommandError
							? cursor.result.stderr.trim()
							: cursor instanceof Error
								? cursor.message
								: String(cursor);
					failed.push(branchName);
					conflictResult = {
						merged,
						failed: [...failed, ...branches.slice(merged.length + failed.length).map(b => b.branchName)],
						conflict: `${branchName}: ${stderr}`,
					};
					break;
				}

				merged.push(branchName);
			}
		} finally {
			if (didStash) {
				const restored = await git.stash.tryPop(repoRoot, { index: true });
				if (!restored) {
					logger.warn("Failed to restore stashed changes after worker merge; stash entry preserved");
					const stashConflict =
						"stash pop: cherry-picked changes conflict with uncommitted edits. The merged commits are on HEAD; run `git stash pop` and resolve manually.";
					if (conflictResult) {
						conflictResult.stashConflict = stashConflict;
					} else {
						conflictResult = { merged, failed: [], stashConflict };
					}
				}
			}
		}

		return conflictResult ?? { merged, failed };
	});
}

export async function cleanupTaskBranches(repoRoot: string, branches: string[]): Promise<void> {
	for (const branch of branches) {
		await git.branch.tryDelete(repoRoot, branch);
	}
}
