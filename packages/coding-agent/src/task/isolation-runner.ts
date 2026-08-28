import * as path from "node:path";
import type * as natives from "@oh-my-pi/pi-natives";
import { AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from "../tools";
import { generateCommitMessage } from "../utils/commit-message-generator";
import * as git from "../utils/git";
import { trackLateCleanup } from "../utils/late-cleanup";
import type { ExecutorOptions } from "./executor";
import { runSubprocess } from "./executor";
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

async function writeIsolationPatch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	artifactsDir: string,
	agentId: string,
): Promise<{ patchPath: string; nestedPatches: NestedRepoPatch[] }> {
	const delta = await captureDeltaPatch(isolationDir, baseline);
	const patchPath = path.join(artifactsDir, `${agentId}.patch`);
	await Bun.write(patchPath, delta.rootPatch);
	return { patchPath, nestedPatches: delta.nestedPatches };
}

export async function runIsolatedSubprocess(opts: IsolatedRunOptions): Promise<SingleResult> {
	let handle: IsolationHandle | undefined;
	let deferredCleanup: Promise<void> | undefined;
	try {
		const taskBaseline = structuredClone(opts.context.baseline);
		handle = await ensureIsolation(opts.context.repoRoot, opts.agentId, opts.preferredBackend);
		const isolationDir = handle.mergedDir;
		const result = await runSubprocess({
			...opts.baseOptions,
			worktree: isolationDir,
			preloadedExtensionPaths: undefined,
			preloadedCustomToolPaths: undefined,
			onCleanupDeferred: completion => {
				deferredCleanup = completion;
				opts.baseOptions.onCleanupDeferred?.(completion);
			},
		});
		opts.onSubprocessResult?.(result);
		if (deferredCleanup) return result;
		if (opts.mergeMode === "branch" && result.exitCode === 0) {
			try {
				const commitResult = await commitToBranch(
					isolationDir,
					taskBaseline,
					opts.agentId,
					opts.description,
					opts.buildCommitMessage?.(),
				);
				return rememberAgentArtifacts({
					...result,
					branchName: commitResult?.branchName,
					branchBaseSha: commitResult?.baseSha,
					nestedPatches: commitResult?.nestedPatches,
				});
			} catch (mergeErr) {
				const baseSha = taskBaseline.root.headCommit;
				const branchName = `proto/task/${opts.agentId}`;
				const rescueBranch = await rescueTaskBranch(opts.context.repoRoot, branchName, baseSha);
				const rescueNote = rescueBranch
					? ` The agent's commits are preserved on branch ${rescueBranch} — merge or cherry-pick it manually.`
					: "";
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
						patchPath: patchResult.patchPath,
						nestedPatches: patchResult.nestedPatches,
						error: `Merge failed: ${msg}.${rescueNote}`,
					});
				} catch (patchErr) {
					const patchMsg = patchErr instanceof Error ? patchErr.message : String(patchErr);
					return rememberAgentArtifacts({
						...result,
						error: `Merge failed: ${msg}; patch capture failed: ${patchMsg}.${rescueNote}`,
					});
				}
			}
		}
		if (result.exitCode === 0) {
			try {
				const patchResult = await writeIsolationPatch(isolationDir, taskBaseline, opts.artifactsDir, opts.agentId);
				return rememberAgentArtifacts({
					...result,
					patchPath: patchResult.patchPath,
					nestedPatches: patchResult.nestedPatches,
				});
			} catch (patchErr) {
				const msg = patchErr instanceof Error ? patchErr.message : String(patchErr);
				return rememberAgentArtifacts({ ...result, error: `Patch capture failed: ${msg}` });
			}
		}
		return rememberAgentArtifacts(result);
	} catch (err) {
		return rememberAgentArtifacts(opts.buildFailureResult(err));
	} finally {
		if (handle) {
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
	try {
		if (mergeMode === "branch") {
			if (!result.branchName && result.exitCode === 0 && !result.aborted && result.error) {
				const patchList = result.patchPath ? `\nPatch artifact:\n- ${result.patchPath}` : "";
				return {
					summary: `\n\n<system-notification>Branch merge failed while capturing the task branch: ${result.error}\nTask outputs are preserved but changes were not applied.${patchList}</system-notification>`,
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
				summary = `\n\n<system-notification>Branch merge failed: ${result.branchName}.${conflictPart}\nThe unmerged branch remains for manual resolution.</system-notification>`;
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
			summary = `\n\n${notification}${patchList}`;
		}
		return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches: false };
	} catch (mergeErr) {
		const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
		return {
			summary: `\n\n<system-notification>Merge phase failed: ${msg}\nTask outputs are preserved but changes were not applied.</system-notification>`,
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
