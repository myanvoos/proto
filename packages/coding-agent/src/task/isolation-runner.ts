import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as natives from "@oh-my-pi/pi-natives";
import { prompt } from "@oh-my-pi/pi-utils";
import isolationErrorTemplate from "../prompts/tools/isolation-error.md" with { type: "text" };
import isolationSummaryTemplate from "../prompts/tools/isolation-summary.md" with { type: "text" };
import { AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from "../tools";
import { generateCommitMessage } from "../utils/commit-message-generator";
import * as git from "../utils/git";
import { trackLateCleanup } from "../utils/late-cleanup";
import type { ExecutorOptions } from "./executor";
import { runSubprocess } from "./executor";
import { writeRetainedBackend } from "./isolation-ownership";
import type { SingleResult } from "./types";
import {
	applyNestedPatches,
	captureBaseline,
	captureDeltaPatch,
	cleanupIsolation,
	cleanupTaskBranches,
	commitToBranch,
	ensureIsolation,
	getRepoRoot,
	type IsolationHandle,
	mergeTaskBranches,
	type NestedRepoPatch,
	type WorktreeBaseline,
} from "./worktree";

type IsoBackendKind = natives.IsoBackendKind;

interface IsolationSummaryContext {
	kind: "captured" | "capture-error" | "nested-not-applied";
	branchName?: string;
	/** Root patch path, only when it holds changes. */
	rootPatchPath?: string;
	nestedCount?: number;
	nestedPatchPaths: string[];
	error?: string;
}

/** The model-facing isolation outcome appended to a worker result; empty when there is nothing to say. */
export function renderIsolationSummary(context: IsolationSummaryContext): string {
	const text = prompt.render(isolationSummaryTemplate, { ...context });
	return text ? `\n\n${text}` : "";
}

function rememberAgentArtifacts(result: SingleResult): SingleResult {
	AgentRegistry.global().setHistory(result.id, {
		outputPath: result.outputPath,
		patchPath: result.patchPath,
		branchName: result.branchName,
	});
	return result;
}

async function rescueTaskBranch(repoRoot: string, branchName: string, baseSha: string): Promise<string | undefined> {
	try {
		const carriedCommits = (await git.revList.range(repoRoot, baseSha, branchName)).length;
		if (carriedCommits > 0) return branchName;
	} catch {
		try {
			if (await git.ref.exists(repoRoot, `refs/heads/${branchName}`)) return branchName;
		} catch {
			return branchName;
		}
	}
	await git.branch.tryDelete(repoRoot, branchName);
	return undefined;
}

export interface IsolationContext {
	repoRoot: string;
	baseline: WorktreeBaseline;
}

export async function prepareIsolationContext(cwd: string): Promise<IsolationContext> {
	const repoRoot = await getRepoRoot(cwd);
	const baseline = await captureBaseline(repoRoot);
	return { repoRoot, baseline };
}

type BuildCommitMessage = () => undefined | ((diff: string) => Promise<string | null>);

export function makeIsolationCommitMessage(session: ToolSession): BuildCommitMessage {
	return () => {
		const style = session.settings.get("orchestrator.isolation.commits");
		if (style !== "ai" || !session.modelRegistry) return undefined;
		const registry = session.modelRegistry;
		const settings = session.settings;
		const sessionId = session.getSessionId?.() ?? undefined;
		return async (diff: string) => generateCommitMessage(diff, registry, settings, sessionId);
	};
}

interface IsolatedRunOptions {
	baseOptions: ExecutorOptions;

	context: IsolationContext;

	preferredBackend: IsoBackendKind | undefined;

	agentId: string;

	mergeMode: "patch" | "branch";

	artifactsDir: string;

	description?: string;

	buildCommitMessage?: BuildCommitMessage;

	buildFailureResult: (err: unknown) => SingleResult;

	onSubprocessResult?: (result: SingleResult) => void;
}

/**
 * Writes one patch file per nested repository. The isolation workspace is the only other copy of that work, so this
 * must happen before teardown; on failure every attempted file is removed so a partial set never passes for the whole.
 */
export async function persistNestedPatches(
	artifactsDir: string,
	agentId: string,
	nestedPatches: readonly NestedRepoPatch[],
): Promise<string[]> {
	const saved: string[] = [];
	try {
		for (const [index, nestedPatch] of nestedPatches.entries()) {
			const destination = path.join(
				artifactsDir,
				`${agentId}.nested-${index}-${nestedPatch.relativePath.replace(/[^a-zA-Z0-9._-]/g, "_") || "root"}.patch`,
			);
			saved.push(destination);
			await Bun.write(destination, nestedPatch.patch);
		}
	} catch (error) {
		await Promise.all(saved.map(file => fs.rm(file, { force: true }).catch(() => undefined)));
		throw error;
	}
	return saved;
}

async function writeIsolationPatch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	artifactsDir: string,
	agentId: string,
): Promise<Pick<SingleResult, "patchPath" | "hasRootChanges" | "nestedPatches" | "nestedPatchPaths">> {
	const delta = await captureDeltaPatch(isolationDir, baseline);
	const patchPath = path.join(artifactsDir, `${agentId}.patch`);
	await Bun.write(patchPath, delta.rootPatch);
	return {
		patchPath,
		hasRootChanges: delta.rootPatch.trim().length > 0,
		nestedPatches: delta.nestedPatches,
		nestedPatchPaths: await persistNestedPatches(artifactsDir, agentId, delta.nestedPatches),
	};
}

export interface RetainedWorkspace {
	dir: string;
	sidecarOk: boolean;
}

export async function retainIsolationWorkspace(
	isolationDir: string,
	backend: IsoBackendKind,
): Promise<RetainedWorkspace> {
	const baseDir = path.dirname(isolationDir);
	const retainedBase = `${baseDir}.retained-${crypto.randomUUID()}`;
	let sidecarOk = false;
	try {
		// Write before renaming so the backend guard moves atomically with the workspace.
		await writeRetainedBackend(baseDir, backend);
		sidecarOk = true;
	} catch {}
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await fs.rename(baseDir, retainedBase);
			return { dir: path.join(retainedBase, path.basename(isolationDir)), sidecarOk };
		} catch {
			if (attempt < 2) await Bun.sleep(25);
		}
	}
	return { dir: isolationDir, sidecarOk };
}

interface IsolationErrorContext {
	kind: "merge-failed" | "patch-capture-failed" | "nested-capture-failed";
	message: string;
	captureError?: string;
	rescueBranch?: string;
	retainedDir?: string;
	sidecarMissing?: boolean;
}

function renderIsolationError(context: IsolationErrorContext): string {
	return prompt.render(isolationErrorTemplate, { ...context });
}

export async function runIsolatedSubprocess(opts: IsolatedRunOptions): Promise<SingleResult> {
	let handle: IsolationHandle | undefined;
	let deferredCleanup: Promise<void> | undefined;
	let retainWorkspace = false;
	try {
		const taskBaseline = structuredClone(opts.context.baseline);
		handle = await ensureIsolation(opts.context.repoRoot, opts.agentId, opts.preferredBackend);
		const isolationDir = handle.mergedDir;
		const result = await runSubprocess({
			...opts.baseOptions,
			worktree: isolationDir,
			preloadedPreparedExtensions: undefined,
			preloadedCustomToolPaths: undefined,
			onCleanupDeferred: completion => {
				deferredCleanup = completion;
				opts.baseOptions.onCleanupDeferred?.(completion);
			},
		});
		opts.onSubprocessResult?.(result);
		// Owner jobs or shutdown hooks may still write the worktree; a successful result is captured only once they
		// settle. Failed runs skip capture, so their cleanup stays asynchronous.
		if (deferredCleanup && result.exitCode === 0) await deferredCleanup;
		if (opts.mergeMode === "branch" && result.exitCode === 0) {
			try {
				const commitResult = await commitToBranch(
					isolationDir,
					taskBaseline,
					opts.agentId,
					opts.description,
					opts.buildCommitMessage?.(),
				);
				const committed: SingleResult = {
					...result,
					branchName: commitResult?.branchName,
					branchBaseSha: commitResult?.baseSha,
					nestedPatches: commitResult?.nestedPatches,
				};
				try {
					committed.nestedPatchPaths = await persistNestedPatches(
						opts.artifactsDir,
						opts.agentId,
						commitResult?.nestedPatches ?? [],
					);
				} catch (persistErr) {
					retainWorkspace = true;
					const retained = await retainIsolationWorkspace(isolationDir, handle.backend);
					committed.error = renderIsolationError({
						kind: "nested-capture-failed",
						message: persistErr instanceof Error ? persistErr.message : String(persistErr),
						retainedDir: retained.dir,
						sidecarMissing: !retained.sidecarOk,
					});
				}
				return rememberAgentArtifacts(committed);
			} catch (mergeErr) {
				const baseSha = taskBaseline.root.headCommit;
				const branchName = `proto/task/${opts.agentId}`;
				const rescueBranch = await rescueTaskBranch(opts.context.repoRoot, branchName, baseSha);
				const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
				try {
					const patchResult = await writeIsolationPatch(
						isolationDir,
						taskBaseline,
						opts.artifactsDir,
						opts.agentId,
					);
					return rememberAgentArtifacts({
						...result,
						...patchResult,
						error: renderIsolationError({ kind: "merge-failed", message: msg, rescueBranch }),
					});
				} catch (patchErr) {
					retainWorkspace = true;
					const retained = await retainIsolationWorkspace(isolationDir, handle.backend);
					return rememberAgentArtifacts({
						...result,
						error: renderIsolationError({
							kind: "merge-failed",
							message: msg,
							captureError: patchErr instanceof Error ? patchErr.message : String(patchErr),
							rescueBranch,
							retainedDir: retained.dir,
							sidecarMissing: !retained.sidecarOk,
						}),
					});
				}
			}
		}
		if (result.exitCode === 0) {
			try {
				const patchResult = await writeIsolationPatch(isolationDir, taskBaseline, opts.artifactsDir, opts.agentId);
				return rememberAgentArtifacts({ ...result, ...patchResult });
			} catch (patchErr) {
				retainWorkspace = true;
				const retained = await retainIsolationWorkspace(isolationDir, handle.backend);
				return rememberAgentArtifacts({
					...result,
					error: renderIsolationError({
						kind: "patch-capture-failed",
						message: patchErr instanceof Error ? patchErr.message : String(patchErr),
						retainedDir: retained.dir,
						sidecarMissing: !retained.sidecarOk,
					}),
				});
			}
		}
		return rememberAgentArtifacts(result);
	} catch (err) {
		return rememberAgentArtifacts(opts.buildFailureResult(err));
	} finally {
		if (handle && !retainWorkspace) {
			const isolationHandle = handle;
			if (deferredCleanup) {
				trackLateCleanup(
					deferredCleanup.then(() => cleanupIsolation(isolationHandle)),
					{
						agentId: opts.agentId,
						resource: "isolation",
					},
				);
			} else {
				await cleanupIsolation(isolationHandle);
			}
		}
	}
}

interface IsolationMergeOptions {
	result: SingleResult;
	repoRoot: string;
	mergeMode: "patch" | "branch";
}

interface IsolationMergeOutcome {
	summary: string;

	changesApplied: boolean | null;
	hadAnyChanges: boolean;

	mergedBranchForNestedPatches: boolean;
}

export async function mergeIsolatedChanges(opts: IsolationMergeOptions): Promise<IsolationMergeOutcome> {
	const { result, repoRoot, mergeMode } = opts;
	// Nested patches are applied only after the root change lands, so every not-applied outcome names their files.
	const nestedNotApplied = renderIsolationSummary({
		kind: "nested-not-applied",
		nestedPatchPaths: result.nestedPatchPaths ?? [],
	});
	try {
		if (mergeMode === "branch") {
			if (!result.branchName && result.exitCode === 0 && !result.aborted && result.error) {
				const patchList = result.patchPath ? `\nPatch artifact:\n- ${result.patchPath}` : "";
				return {
					summary: `\n\n<system-notification>Branch merge failed while capturing the task branch: ${result.error}\nTask outputs are preserved but changes were not applied.${patchList}</system-notification>${nestedNotApplied}`,
					changesApplied: false,
					hadAnyChanges: false,
					mergedBranchForNestedPatches: false,
				};
			}
			const canApplyNestedOnly =
				!result.branchName && result.exitCode === 0 && !result.aborted && (result.nestedPatches?.length ?? 0) > 0;
			if (!result.branchName || result.exitCode !== 0 || result.aborted) {
				return {
					summary: canApplyNestedOnly
						? "\n\nNo root changes to apply; nested repository patches captured."
						: "\n\nNo changes to apply.",
					changesApplied: true,
					hadAnyChanges: canApplyNestedOnly,
					mergedBranchForNestedPatches: canApplyNestedOnly,
				};
			}
			const mergeResult = await mergeTaskBranches(repoRoot, [
				{
					branchName: result.branchName,
					taskId: result.id,
					description: result.description,
					baseSha: result.branchBaseSha,
				},
			]);
			const mergedBranchForNestedPatches = mergeResult.merged.includes(result.branchName);
			const changesApplied = mergeResult.failed.length === 0;
			const hadAnyChanges = changesApplied && mergeResult.merged.length > 0;

			let summary: string;
			if (changesApplied) {
				summary = hadAnyChanges ? `\n\nMerged branch: ${result.branchName}` : "\n\nNo changes to apply.";
			} else {
				const conflictPart = mergeResult.conflict ? `\nConflict: ${mergeResult.conflict}` : "";
				summary = `\n\n<system-notification>Branch merge failed: ${result.branchName}.${conflictPart}\nThe unmerged branch remains for manual resolution.</system-notification>${nestedNotApplied}`;
			}
			if (mergeResult.stashConflict) {
				summary += `\n\n<system-notification>${mergeResult.stashConflict}</system-notification>`;
			}

			if (changesApplied) {
				await cleanupTaskBranches(repoRoot, [result.branchName]);
			}
			return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches };
		}

		let changesApplied: boolean;
		let hadAnyChanges: boolean;
		const succeeded = result.exitCode === 0 && !result.error && !result.aborted;
		if (!succeeded) {
			changesApplied = true;
			hadAnyChanges = false;
		} else if (!result.patchPath) {
			changesApplied = false;
			hadAnyChanges = false;
		} else {
			const patchText = await Bun.file(result.patchPath).text();
			if (!patchText.trim()) {
				changesApplied = true;
				hadAnyChanges = false;
			} else {
				const normalized = patchText.endsWith("\n") ? patchText : `${patchText}\n`;

				const [alreadyApplied, forwardApplies] = await Promise.all([
					git.patch.canApplyText(repoRoot, normalized, { reverse: true }),
					git.patch.canApplyText(repoRoot, normalized),
				]);
				hadAnyChanges = false;
				if (alreadyApplied && !forwardApplies) {
					changesApplied = true;
				} else if (forwardApplies) {
					changesApplied = true;
					try {
						await git.patch.applyText(repoRoot, normalized);
						hadAnyChanges = true;
					} catch {
						changesApplied = false;
					}
				} else {
					changesApplied = false;
				}
			}
		}

		let summary: string;
		if (changesApplied) {
			summary = hadAnyChanges ? "\n\nApplied patches: yes" : "\n\nNo changes to apply.";
		} else {
			const notification =
				"<system-notification>Patches were not applied and must be handled manually.</system-notification>";
			const patchList = result.patchPath ? `\n\nPatch artifact:\n- ${result.patchPath}` : "";
			summary = `\n\n${notification}${patchList}${nestedNotApplied}`;
		}
		return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches: false };
	} catch (mergeErr) {
		const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
		return {
			summary: `\n\n<system-notification>Merge phase failed: ${msg}\nTask outputs are preserved but changes were not applied.</system-notification>${nestedNotApplied}`,
			changesApplied: false,
			hadAnyChanges: false,
			mergedBranchForNestedPatches: false,
		};
	}
}

interface NestedPatchApplyOptions {
	result: SingleResult;
	repoRoot: string;
	mergeMode: "patch" | "branch";

	changesApplied: boolean | null;

	mergedBranchForNestedPatches: boolean;

	commitMessage?: (diff: string) => Promise<string | null>;
}

export async function applyEligibleNestedPatches(opts: NestedPatchApplyOptions): Promise<string> {
	const { result, repoRoot, mergeMode, changesApplied, mergedBranchForNestedPatches, commitMessage } = opts;
	if (mergeMode === "patch" && changesApplied === false) return "";
	const nestedPatches = result.nestedPatches ?? [];
	const eligible =
		nestedPatches.length > 0 &&
		result.exitCode === 0 &&
		!result.aborted &&
		(mergeMode !== "branch" || mergedBranchForNestedPatches);
	if (!eligible) return "";
	try {
		const warnings = await applyNestedPatches(repoRoot, nestedPatches, commitMessage);
		if (warnings.length === 0) return "";
		return `\n\n<system-notification>${warnings.join("\n")}</system-notification>`;
	} catch {
		return "\n\n<system-notification>Some nested repository patches failed to apply.</system-notification>";
	}
}
