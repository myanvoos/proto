import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import * as utils from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";
import * as git from "../utils/git";
import * as executor from "./executor";
import { RETAINED_BACKEND_FILE, readRetainedBackend } from "./isolation-ownership";
import {
	persistNestedPatches,
	renderIsolationSummary,
	retainIsolationWorkspace,
	runIsolatedSubprocess,
} from "./isolation-runner";
import type { SingleResult } from "./types";
import * as worktree from "./worktree";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function artifactsDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-nested-patches-"));
	tempDirs.push(dir);
	return dir;
}

test("nested repository patches are written one file per repository", async () => {
	const dir = await artifactsDir();
	const paths = await persistNestedPatches(dir, "agent", [
		{ relativePath: "vendor/lib", patch: "diff --git a/x b/x\n" },
		{ relativePath: "tools", patch: "diff --git a/y b/y\n" },
	]);
	expect(paths).toEqual([
		path.join(dir, "agent.nested-0-vendor_lib.patch"),
		path.join(dir, "agent.nested-1-tools.patch"),
	]);
	expect(await Bun.file(paths[0]!).text()).toBe("diff --git a/x b/x\n");
	expect(await Bun.file(paths[1]!).text()).toBe("diff --git a/y b/y\n");
});

// A partial set must not pass for the complete capture: the caller keeps the work elsewhere when this throws.
test("a failed nested patch write leaves no partial set behind", async () => {
	const dir = await artifactsDir();
	await fs.mkdir(path.join(dir, "agent.nested-1-tools.patch"));
	await expect(
		persistNestedPatches(dir, "agent", [
			{ relativePath: "vendor/lib", patch: "diff --git a/x b/x\n" },
			{ relativePath: "tools", patch: "diff --git a/y b/y\n" },
		]),
	).rejects.toThrow();
	expect(await Bun.file(path.join(dir, "agent.nested-0-vendor_lib.patch")).exists()).toBe(false);
});

// Regression: with apply=false and changes only in a nested repository, the summary claimed the empty root patch held
// the changes and never said where the nested work was written.
test("an apply=false summary names nested patch files and not an empty root patch", () => {
	const summary = renderIsolationSummary({
		kind: "captured",
		nestedCount: 1,
		nestedPatchPaths: ["/artifacts/agent.nested-0-vendor_lib.patch"],
	});
	expect(summary).toBe(
		"\n\nIsolation: changes captured for 1 nested repository (apply=false). Not applied.\n- nested repository patch: `/artifacts/agent.nested-0-vendor_lib.patch`",
	);
});

async function workspace(): Promise<string> {
	const parent = await artifactsDir();
	const dir = path.join(parent, "sandbox", "m");
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, "work.txt"), "only remaining copy");
	return dir;
}

test("retention moves work and its backend guard out of the reusable agent slot", async () => {
	const dir = await workspace();
	const retained = await retainIsolationWorkspace(dir, natives.IsoBackendKind.Rcopy);
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, "work.txt"), "replacement worker");
	expect(await Bun.file(path.join(retained.dir, "work.txt")).text()).toBe("only remaining copy");
	expect(await readRetainedBackend(path.dirname(retained.dir))).toBe(natives.IsoBackendKind.Rcopy);
	expect(retained.sidecarOk).toBe(true);
});

test("transient rename locks are retried without losing the backend guard", async () => {
	const dir = await workspace();
	const base = path.dirname(dir);
	const rename = fs.rename;
	let attempts = 0;
	vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (from === base) {
			attempts++;
			expect(await readRetainedBackend(base)).toBe(natives.IsoBackendKind.Overlayfs);
			if (attempts < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
		}
		await rename(from, to);
	});
	const retained = await retainIsolationWorkspace(dir, natives.IsoBackendKind.Overlayfs);
	expect(attempts).toBe(3);
	expect(retained.dir).not.toBe(dir);
	expect(await Bun.file(path.join(retained.dir, "work.txt")).text()).toBe("only remaining copy");
});

test("exhausted rename retries leave work intact and a later same-id run refuses to erase it", async () => {
	const dir = await workspace();
	const base = path.dirname(dir);
	const rename = fs.rename;
	vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (from === base) throw new Error("busy");
		await rename(from, to);
	});
	const retained = await retainIsolationWorkspace(dir, natives.IsoBackendKind.Rcopy);
	expect(retained).toEqual({ dir, sidecarOk: true });
	vi.spyOn(git.repo, "root").mockResolvedValue(path.dirname(base));
	vi.spyOn(git.repo, "resolve").mockResolvedValue(null);
	vi.spyOn(utils, "getWorktreeDir").mockReturnValue(base);
	await expect(worktree.ensureIsolation(path.dirname(base), "same-id")).rejects.toThrow("recover its changes");
	expect(await Bun.file(path.join(dir, "work.txt")).text()).toBe("only remaining copy");
});

test("backend metadata survives disk pressure even when the workspace cannot be moved", async () => {
	const parent = await artifactsDir();
	const base = path.join(parent, "sandbox");
	const dir = path.join(base, "m");
	vi.spyOn(git.repo, "root").mockResolvedValue(parent);
	vi.spyOn(git.repo, "resolve").mockResolvedValue(null);
	vi.spyOn(git, "detachGitDir").mockResolvedValue("detached");
	vi.spyOn(utils, "getWorktreeDir").mockReturnValue(base);
	vi.spyOn(natives, "isoResolve").mockReturnValue({
		kind: natives.IsoBackendKind.Overlayfs,
		candidates: [natives.IsoBackendKind.Overlayfs],
		fellBack: false,
	});
	vi.spyOn(natives, "isoStart").mockImplementation(async () => {
		expect(await readRetainedBackend(base)).toBe(natives.IsoBackendKind.Overlayfs);
		await fs.mkdir(dir);
		await Bun.write(path.join(dir, "work.txt"), "only remaining copy");
	});
	await worktree.ensureIsolation(parent, "same-id");
	const rename = fs.rename;
	vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (from === base || to === path.join(base, RETAINED_BACKEND_FILE)) throw new Error("disk pressure");
		await rename(from, to);
	});
	const retained = await retainIsolationWorkspace(dir, natives.IsoBackendKind.Overlayfs);
	expect(retained.dir).toBe(dir);
	expect(await readRetainedBackend(base)).toBe(natives.IsoBackendKind.Overlayfs);
	expect(await Bun.file(path.join(dir, "work.txt")).text()).toBe("only remaining copy");
});

test("a failed atomic sidecar write still retains the work and reports unsafe cleanup", async () => {
	const dir = await workspace();
	await fs.mkdir(path.join(path.dirname(dir), RETAINED_BACKEND_FILE));
	const retained = await retainIsolationWorkspace(dir, natives.IsoBackendKind.Overlayfs);
	expect(retained.sidecarOk).toBe(false);
	expect(retained.dir).not.toBe(dir);
	expect(await Bun.file(path.join(retained.dir, "work.txt")).text()).toBe("only remaining copy");
	await expect(readRetainedBackend(path.dirname(retained.dir))).rejects.toThrow();
});

for (const failure of ["patch", "nested", "merge"] as const) {
	test(`${failure} capture failure reports recoverable work instead of deleting its only copy`, async () => {
		const dir = await workspace();
		const artifacts = path.join(path.dirname(dir), "blocked-artifacts");
		await Bun.write(artifacts, "not a directory");
		// Exercise the warning branch through a real sidecar I/O failure as well.
		if (failure === "patch") await fs.mkdir(path.join(path.dirname(dir), RETAINED_BACKEND_FILE));
		const result: SingleResult = {
			index: 0,
			id: "retain-test",
			agent: "worker",
			agentSource: "bundled",
			task: "edit",
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		};
		vi.spyOn(AgentRegistry.global(), "setHistory").mockReturnValue(false);
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			options.onCleanupDeferred?.(Promise.resolve());
			return result;
		});
		vi.spyOn(worktree, "ensureIsolation").mockResolvedValue({
			mergedDir: dir,
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		const cleanup = vi.spyOn(worktree, "cleanupIsolation").mockImplementation(async handle => {
			await fs.rm(path.dirname(handle.mergedDir), { recursive: true, force: true });
		});
		vi.spyOn(worktree, "captureDeltaPatch").mockResolvedValue({ rootPatch: "diff", nestedPatches: [] });
		const commit = vi.spyOn(worktree, "commitToBranch");
		if (failure === "merge") {
			commit.mockRejectedValue(new Error("commit failed"));
			vi.spyOn(git.revList, "range").mockResolvedValue(["rescued-commit"]);
		} else {
			commit.mockResolvedValue({
				branchName: "proto/task/retain-test",
				nestedPatches: [{ relativePath: "vendor", patch: "diff" }],
			});
		}
		const outcome = await runIsolatedSubprocess({
			baseOptions: {
				cwd: dir,
				agent: { name: "worker", description: "worker", systemPrompt: "", source: "bundled" },
				task: "edit",
				index: 0,
				id: result.id,
			},
			context: {
				repoRoot: dir,
				baseline: {
					root: { repoRoot: dir, headCommit: "base", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
					nested: [],
				},
			},
			preferredBackend: natives.IsoBackendKind.Rcopy,
			agentId: result.id,
			mergeMode: failure === "patch" ? "patch" : "branch",
			artifactsDir: artifacts,
			buildFailureResult: error => ({ ...result, error: String(error) }),
		});
		const retainedBase = (await fs.readdir(path.dirname(path.dirname(dir)))).find(name =>
			name.includes(".retained-"),
		);
		expect(retainedBase).toBeDefined();
		const retainedDir = path.join(path.dirname(path.dirname(dir)), retainedBase!, "m");
		expect(outcome.error).toContain(retainedDir);
		if (failure === "patch") expect(outcome.error).toContain("automatic cleanup is unsafe");
		if (failure === "merge") expect(outcome.error).toContain("proto/task/retain-test");
		expect(await Bun.file(path.join(retainedDir, "work.txt")).text()).toBe("only remaining copy");
		expect(cleanup).not.toHaveBeenCalled();
	});
}
