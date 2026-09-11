import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, hasFsCode, isEacces, isEisdir, isEnoent, isEnotdir, Snowflake } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import {
	parseDiffHunks as parseCommitDiffHunks,
	parseFileDiffs,
	parseFileHunks,
	parseNumstat,
} from "../commit/git/diff";
import type { FileDiff, FileHunks, NumstatEntry } from "../commit/types";
import { REJECT_PROMPT_COMMAND } from "../exec/non-interactive-env";
import { ToolAbortError, ToolError, throwIfAborted } from "../tools/tool-errors";

export interface GitCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;

	truncated: boolean;
}

export interface GitRepository {
	commonDir: string;
	gitDir: string;
	gitEntryPath: string;
	headPath: string;
	repoRoot: string;
	isReftable?: boolean;
}

export interface GitStatusSummary {
	staged: number;
	unstaged: number;
	untracked: number;
}

type HunkSelection = {
	path: string;
	hunks: { type: "all" } | { type: "indices"; indices: number[] } | { type: "lines"; start: number; end: number };
};

interface StageHunksOptions {
	readonly diffCached?: boolean;
	readonly rawDiff?: string;
	readonly signal?: AbortSignal;
}
export interface HunkSelectionValidationError {
	readonly path: string;
	readonly message: string;
}

export interface DiffOptions {
	readonly allowFailure?: boolean;
	readonly base?: string;
	readonly binary?: boolean;
	readonly cached?: boolean;
	readonly env?: Record<string, string | undefined>;
	readonly files?: readonly string[];
	readonly head?: string;
	readonly nameOnly?: boolean;
	readonly noIndex?: { left: string; right: string };
	readonly numstat?: boolean;
	readonly signal?: AbortSignal;
	readonly stat?: boolean;
	readonly requireComplete?: boolean;
}

interface StatusOptions {
	readonly pathspecs?: readonly string[];
	readonly porcelainV1?: boolean;
	readonly signal?: AbortSignal;
	readonly untrackedFiles?: "all" | "no" | "normal";
	readonly z?: boolean;
}

export interface CommitAuthor {
	readonly date?: string;
	readonly email: string;
	readonly name: string;
}

interface CommitDetails {
	readonly author: CommitAuthor;
	readonly message: string;
}

interface CommitOptions {
	readonly allowEmpty?: boolean;
	readonly author?: CommitAuthor;
	readonly files?: readonly string[];
	readonly signal?: AbortSignal;
}

export interface PushOptions {
	readonly forceWithLease?: boolean;
	readonly refspec?: string;
	readonly remote?: string;
	readonly signal?: AbortSignal;
}

interface PatchOptions {
	readonly cached?: boolean;
	readonly check?: boolean;
	readonly env?: Record<string, string | undefined>;
	readonly reverse?: boolean;
	readonly threeWay?: boolean;
	readonly signal?: AbortSignal;
}

interface RestoreOptions {
	readonly files?: readonly string[];
	readonly signal?: AbortSignal;
	readonly source?: string;
	readonly staged?: boolean;
	readonly worktree?: boolean;
}

interface FetchOptions {
	readonly signal?: AbortSignal;

	readonly timeoutMs?: number;
}

interface CloneOptions {
	readonly ref?: string;
	readonly sha?: string;
	readonly signal?: AbortSignal;

	readonly timeoutMs?: number;
}

interface GitHeadBase extends GitRepository {
	headContent: string;
}

interface GitRefHead extends GitHeadBase {
	branchName: string | null;
	commit: string | null;
	kind: "ref";
	ref: string;
}

interface GitDetachedHead extends GitHeadBase {
	commit: string | null;
	kind: "detached";
}

type GitHeadState = GitRefHead | GitDetachedHead;

export interface GitWorktreeEntry {
	branch?: string;
	detached: boolean;
	head?: string;
	path: string;
}

export class GitCommandError extends Error {
	readonly args: readonly string[];
	readonly result: GitCommandResult;

	constructor(args: readonly string[], result: GitCommandResult) {
		super(formatCommandFailure(args, result));
		this.name = "GitCommandError";
		this.args = [...args];
		this.result = result;
	}
}

export class GitOutputTruncatedError extends Error {
	readonly args: readonly string[];
	readonly result: GitCommandResult;

	constructor(args: readonly string[], result: GitCommandResult) {
		const limitMiB = Math.round(GIT_COMMAND_OUTPUT_LIMIT_BYTES / (1024 * 1024));
		super(
			`git ${args.join(" ")} produced more than ${limitMiB} MiB of output; the captured result is truncated and incomplete.`,
		);
		this.name = "GitOutputTruncatedError";
		this.args = [...args];
		this.result = result;
	}
}

const NO_OPTIONAL_LOCKS = "--no-optional-locks";
const HEAD_REF_PREFIX = "ref:";
const LOCAL_BRANCH_PREFIX = "refs/heads/";
const DEFAULT_BRANCH_REFS = ["refs/remotes/origin/HEAD", "refs/remotes/upstream/HEAD"] as const;
const SHORT_LIVED_GIT_CONFIG: readonly (readonly [key: string, value: string])[] = [
	["core.fsmonitor", "false"],
	["core.untrackedCache", "false"],
];
const AMBIENT_GIT_ENV = {
	GIT_DIR: undefined,
	GIT_COMMON_DIR: undefined,
	GIT_WORK_TREE: undefined,
	GIT_INDEX_FILE: undefined,
	GIT_OBJECT_DIRECTORY: undefined,
	GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
} satisfies Record<string, undefined>;

const GIT_NON_INTERACTIVE_ENV = {
	GIT_ASKPASS: "true",
	GIT_EDITOR: "true",
	GIT_TERMINAL_PROMPT: "0",
	LC_ALL: undefined,
	LC_MESSAGES: "C",
	SSH_ASKPASS: REJECT_PROMPT_COMMAND,
} satisfies Record<string, string | undefined>;
const GH_NON_INTERACTIVE_ENV = {
	...GIT_NON_INTERACTIVE_ENV,
	GH_PROMPT_DISABLED: "1",
} satisfies Record<string, string | undefined>;

export const GIT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

const GIT_NETWORK_TIMEOUT_MS = 30 * 60 * 1000;

export const GIT_COMMAND_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

const GIT_SPAWN_SYNC_TIMEOUT_MS = 5_000;

const HEAD_WATCH_INTERVAL_MS = 1000;

const GIT_COMMAND_TIMEOUT_EXIT_CODE = 124;

const GIT_SPAWN_ENOENT_EXIT_CODE = 127;
const GIT_OUTPUT_TRUNCATED_MARKER = "\n[git subprocess output truncated after 8 MiB]\n";
const GIT_COMMAND_TERMINATE_GRACE_MS = 5_000;

type CommandName = "git" | "gh";

function resolveTimeoutMs(timeoutMs: number | undefined, fallback: number = GIT_COMMAND_TIMEOUT_MS): number {
	if (timeoutMs === undefined) return fallback;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return fallback;
	return Math.trunc(timeoutMs);
}

function resolveOutputLimit(maxOutputBytes: number | undefined): number {
	if (maxOutputBytes === undefined) return GIT_COMMAND_OUTPUT_LIMIT_BYTES;
	if (!Number.isFinite(maxOutputBytes) || maxOutputBytes < 0) return GIT_COMMAND_OUTPUT_LIMIT_BYTES;
	return Math.trunc(maxOutputBytes);
}

function formatCommandLabel(command: CommandName, args: readonly string[]): string {
	return `${command} ${args.join(" ")}`.trim();
}

async function waitForChildExit(child: Subprocess, timeoutMs: number): Promise<boolean> {
	if (timeoutMs <= 0) return false;
	const timeout = Promise.withResolvers<false>();
	const timer = setTimeout(() => timeout.resolve(false), timeoutMs);
	timer.unref?.();
	try {
		return await Promise.race([
			child.exited.then(
				() => true,
				() => true,
			),
			timeout.promise,
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function terminateTimedOutChild(child: Subprocess): Promise<void> {
	child.kill("SIGTERM");
	if (await waitForChildExit(child, GIT_COMMAND_TERMINATE_GRACE_MS)) return;
	child.kill("SIGKILL");
	await waitForChildExit(child, GIT_COMMAND_TERMINATE_GRACE_MS);
}

async function waitForExitWithTimeout(
	child: Subprocess,
	commandLabel: string,
	timeoutMs: number,
): Promise<{ exitCode: number | null; timedOut: false } | { timedOut: true; stderr: string }> {
	if (timeoutMs === 0) {
		await terminateTimedOutChild(child);
		return { timedOut: true, stderr: `${commandLabel} timed out after 0ms` };
	}
	const timeout = Promise.withResolvers<"timeout">();
	const timer = setTimeout(() => timeout.resolve("timeout"), timeoutMs);
	timer.unref?.();
	try {
		const result = await Promise.race([
			child.exited.then(exitCode => ({ kind: "exit" as const, exitCode })),
			timeout.promise.then(() => ({ kind: "timeout" as const })),
		]);
		if (result.kind === "exit") {
			return { timedOut: false, exitCode: result.exitCode };
		}
		await terminateTimedOutChild(child);
		return { timedOut: true, stderr: `${commandLabel} timed out after ${timeoutMs}ms` };
	} finally {
		clearTimeout(timer);
	}
}

export async function readCappedText(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	truncatedMarker = GIT_OUTPUT_TRUNCATED_MARKER,
): Promise<{ text: string; truncated: boolean }> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let remaining = maxBytes;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!truncated && value.length <= remaining) {
				chunks.push(decoder.decode(value, { stream: true }));
				remaining -= value.length;
				continue;
			}
			if (!truncated && remaining > 0) {
				chunks.push(decoder.decode(value.subarray(0, remaining), { stream: true }));
				remaining = 0;
			}
			truncated = true;
		}
		chunks.push(decoder.decode());
		if (truncated) chunks.push(truncatedMarker);
		return { text: chunks.join(""), truncated };
	} finally {
		reader.releaseLock();
	}
}

async function cancelOutput(stream: ReadableStream<Uint8Array>): Promise<void> {
	try {
		await stream.cancel();
	} catch {}
}

async function collectSubprocessResult(
	command: CommandName,
	args: readonly string[],
	child: Subprocess,
	options: Pick<CommandOptions, "maxOutputBytes" | "timeoutMs"> = {},
): Promise<GitCommandResult> {
	const stdoutStream = child.stdout;
	const stderrStream = child.stderr;
	if (!(stdoutStream instanceof ReadableStream) || !(stderrStream instanceof ReadableStream)) {
		throw new Error(`Failed to capture ${command} command output.`);
	}
	const maxOutputBytes = resolveOutputLimit(options.maxOutputBytes);
	const stdoutPromise = readCappedText(stdoutStream, maxOutputBytes);
	const stderrPromise = readCappedText(stderrStream, maxOutputBytes);
	const exit = await waitForExitWithTimeout(
		child,
		formatCommandLabel(command, args),
		resolveTimeoutMs(options.timeoutMs),
	);
	if (exit.timedOut) {
		void stdoutPromise.catch(() => undefined);
		void stderrPromise.catch(() => undefined);
		await Promise.all([cancelOutput(stdoutStream), cancelOutput(stderrStream)]);
		return { exitCode: GIT_COMMAND_TIMEOUT_EXIT_CODE, stdout: "", stderr: exit.stderr, truncated: false };
	}
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
	return {
		exitCode: exit.exitCode ?? 0,
		stdout: stdout.text,
		stderr: stderr.text,
		truncated: stdout.truncated || stderr.truncated,
	};
}

interface CommandOptions {
	readonly env?: Record<string, string | undefined>;
	readonly maxOutputBytes?: number;
	readonly readOnly?: boolean;
	readonly signal?: AbortSignal;
	readonly stdin?: string | Uint8Array | ArrayBuffer | SharedArrayBuffer;
	readonly timeoutMs?: number;
}

function normalizeStdin(input: CommandOptions["stdin"]): "ignore" | Uint8Array {
	if (input === undefined) return "ignore";
	if (typeof input === "string") return new TextEncoder().encode(input);
	if (input instanceof Uint8Array) return input;
	return new Uint8Array(input);
}

function buildNonInteractiveEnv(
	env: Record<string, string | undefined>,
	pinnedEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const preservedCharacterLocale =
		env.LC_ALL !== undefined && /(?:^|[._-])utf-?8(?:$|[.@_-])/i.test(env.LC_ALL) ? env.LC_ALL : undefined;
	return {
		...env,
		...(preservedCharacterLocale === undefined ? {} : { LC_CTYPE: preservedCharacterLocale }),
		...pinnedEnv,
	};
}

function buildGitEnv(overrides?: Record<string, string | undefined>): Record<string, string | undefined> {
	return buildNonInteractiveEnv(
		{
			...process.env,
			GIT_OPTIONAL_LOCKS: "0",
			...AMBIENT_GIT_ENV,
			...overrides,
		},
		GIT_NON_INTERACTIVE_ENV,
	);
}

function buildGhEnv(): Record<string, string | undefined> {
	return buildNonInteractiveEnv({ ...process.env }, GH_NON_INTERACTIVE_ENV);
}

function ensureAvailable(): void {
	if (!$which("git")) {
		throw new Error("git is not installed.");
	}
}

function gitSpawnSyncText(
	cwd: string,
	args: readonly string[],
	timeoutMs: number = GIT_SPAWN_SYNC_TIMEOUT_MS,
): { exitCode: number; stdout: string } {
	const commandArgs = withShortLivedGitConfig(withNoOptionalLocks(args));
	try {
		const result = Bun.spawnSync(["git", ...commandArgs], {
			cwd,
			env: buildGitEnv(),
			stdout: "pipe",
			stderr: "pipe",
			timeout: timeoutMs,
		});

		const exitCode = result.exitedDueToTimeout
			? GIT_COMMAND_TIMEOUT_EXIT_CODE
			: (result.exitCode ?? GIT_COMMAND_TIMEOUT_EXIT_CODE);
		return { exitCode, stdout: new TextDecoder().decode(result.stdout).trim() };
	} catch (err) {
		if (isEnoent(err)) return { exitCode: GIT_SPAWN_ENOENT_EXIT_CODE, stdout: "" };
		throw err;
	}
}

function formatCommandFailure(
	args: readonly string[],
	result: Pick<GitCommandResult, "exitCode" | "stdout" | "stderr">,
): string {
	const stderr = result.stderr.trim();
	if (stderr) return stderr;
	const stdout = result.stdout.trim();
	if (stdout) return stdout;
	return `git ${args.join(" ")} failed with exit code ${result.exitCode}`;
}

async function git(cwd: string, args: readonly string[], options: CommandOptions = {}): Promise<GitCommandResult> {
	const commandArgs = withShortLivedGitConfig(options.readOnly ? withNoOptionalLocks(args) : [...args]);
	let child: Subprocess;
	try {
		child = Bun.spawn(["git", ...commandArgs], {
			cwd,
			env: buildGitEnv(options.env),
			signal: options.signal,
			stdin: normalizeStdin(options.stdin),
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		if (isEnoent(err)) {
			const stderr = fs.existsSync(cwd) ? "git is not installed." : `working directory does not exist: ${cwd}`;
			return { exitCode: GIT_SPAWN_ENOENT_EXIT_CODE, stdout: "", stderr, truncated: false };
		}
		throw err;
	}

	return await collectSubprocessResult("git", commandArgs, child, options);
}

function withNoOptionalLocks(args: readonly string[]): string[] {
	if (args.includes(NO_OPTIONAL_LOCKS)) return [...args];
	return [NO_OPTIONAL_LOCKS, ...args];
}

function withShortLivedGitConfig(args: readonly string[]): string[] {
	const prefix: string[] = [];
	for (const [key, value] of SHORT_LIVED_GIT_CONFIG) {
		if (hasGitConfig(args, key, value)) continue;
		prefix.push("-c", `${key}=${value}`);
	}
	return [...prefix, ...args];
}

function hasGitConfig(args: readonly string[], key: string, value: string): boolean {
	const expected = `${key}=${value}`;
	for (let index = 0; index < args.length - 1; index += 1) {
		if (args[index] === "-c" && args[index + 1] === expected) {
			return true;
		}
	}
	return false;
}

async function runChecked(
	cwd: string,
	args: readonly string[],
	options: CommandOptions = {},
): Promise<GitCommandResult> {
	ensureAvailable();
	const result = await git(cwd, args, options);
	if (result.exitCode !== 0) {
		throw new GitCommandError(args, result);
	}
	return result;
}

async function runEffect(cwd: string, args: readonly string[], options: CommandOptions = {}): Promise<void> {
	await runChecked(cwd, args, options);
}

async function runText(cwd: string, args: readonly string[], options: CommandOptions = {}): Promise<string> {
	return (await runChecked(cwd, args, options)).stdout;
}

async function tryText(
	cwd: string,
	args: readonly string[],
	options: CommandOptions = {},
): Promise<string | undefined> {
	ensureAvailable();
	const result = await git(cwd, args, options);
	if (result.exitCode !== 0) return undefined;
	return result.stdout;
}

type GitRunOptions = Pick<CommandOptions, "env" | "maxOutputBytes" | "signal" | "stdin" | "timeoutMs">;

export async function runUnchecked(
	cwd: string,
	args: readonly string[],
	options: GitRunOptions = {},
): Promise<GitCommandResult> {
	return await git(cwd, args, options);
}

const repoWriteChain = new Map<string, Promise<unknown>>();

export async function withRepoLock<T>(cwd: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const key = (await repo.primaryRoot(cwd, signal)) ?? cwd;
	const prior = repoWriteChain.get(key);
	const run = (async () => {
		if (prior) {
			try {
				await prior;
			} catch {}
		}
		throwIfAborted(signal);
		return fn();
	})();
	repoWriteChain.set(key, run);
	try {
		return await run;
	} finally {
		if (repoWriteChain.get(key) === run) repoWriteChain.delete(key);
	}
}

function splitLines(text: string): string[] {
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

function trimScalar(text: string | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed || undefined;
}

function buildDiffArgs(options: DiffOptions): string[] {
	const args = ["diff"];
	if (options.binary) args.push("--binary");
	if (options.cached) args.push("--cached");
	if (options.nameOnly) args.push("--name-only");
	if (options.stat) args.push("--stat");
	if (options.numstat) args.push("--numstat");
	if (options.noIndex) {
		args.push("--no-index", options.noIndex.left, options.noIndex.right);
		return args;
	}
	if (options.base) {
		args.push(options.base);
		if (options.head) args.push(options.head);
	}
	if (options.files?.length) args.push("--", ...options.files);
	return args;
}

function buildApplyArgs(patchPath: string, options: PatchOptions): string[] {
	const args = ["apply"];
	if (options.check) args.push("--check");
	if (options.cached) args.push("--cached");
	if (options.reverse) args.push("--reverse");
	if (options.threeWay) args.push("--3way");
	args.push("--binary", patchPath);
	return args;
}

async function writeTempPatch(content: string): Promise<string> {
	const tempPath = path.join(os.tmpdir(), `proto-git-patch-${Snowflake.next()}.patch`);
	await Bun.write(tempPath, content);
	return tempPath;
}

type EntryType = "directory" | "file";

function isPermissionError(err: unknown): boolean {
	return isEacces(err) || hasFsCode(err, "EPERM");
}

function shouldRetry(err: unknown, n: number) {
	if (isEnoent(err) || isEisdir(err) || isEnotdir(err) || hasFsCode(err, "ENFILE") || hasFsCode(err, "EMFILE"))
		return false;
	if (hasFsCode(err, "EINTR")) return n < EINTR_MAX_RETRIES;
	if (n > EINTR_MAX_RETRIES) throw err;
	throw err;
}

const EINTR_MAX_RETRIES = 3;
function retryOnEintrSync<T>(op: () => T): T | null {
	for (let attempt = 0; attempt <= EINTR_MAX_RETRIES; attempt += 1) {
		try {
			return op();
		} catch (err) {
			if (shouldRetry(err, attempt)) continue;
			return null;
		}
	}
	throw new Error("retryOnEintrSync: exhausted without resolution");
}
async function retryOnEintr<T>(op: () => Promise<T>): Promise<T | null> {
	for (let attempt = 0; attempt <= EINTR_MAX_RETRIES; attempt += 1) {
		try {
			return await op();
		} catch (err) {
			if (shouldRetry(err, attempt)) continue;
			return null;
		}
	}
	throw new Error("retryOnEintr: exhausted without resolution");
}

function getEntryTypeSync(gitEntryPath: string): EntryType | null {
	return retryOnEintrSync(() => {
		const stat = fs.statSync(gitEntryPath);
		if (stat.isDirectory()) return "directory";
		if (stat.isFile()) return "file";
		return null;
	});
}

async function getEntryType(gitEntryPath: string): Promise<EntryType | null> {
	return retryOnEintr(async () => {
		const stat = await fs.promises.stat(gitEntryPath);
		if (stat.isDirectory()) return "directory";
		if (stat.isFile()) return "file";
		return null;
	});
}

function readOptionalTextSync(filePath: string): string | null {
	return retryOnEintrSync(() => fs.readFileSync(filePath, "utf8"));
}

async function readOptionalText(filePath: string): Promise<string | null> {
	return retryOnEintr(async () => await Bun.file(filePath).text());
}

async function readOptionalBytes(filePath: string): Promise<Uint8Array | null> {
	return retryOnEintr(async () => await Bun.file(filePath).bytes());
}

function parseGitDirPointer(content: string): string | null {
	const match = /^gitdir:\s*(.+)\s*$/iu.exec(content.trim());
	return match?.[1] ?? null;
}

function resolveGitDirSync(gitEntryPath: string, entryType: EntryType): string | null {
	if (entryType === "directory") return gitEntryPath;
	const content = readOptionalTextSync(gitEntryPath);
	if (content === null) return null;
	const parsed = parseGitDirPointer(content);
	if (!parsed) return null;
	const gitDir = path.resolve(path.dirname(gitEntryPath), parsed);
	return getEntryTypeSync(gitDir) === "directory" ? gitDir : null;
}

async function resolveGitDir(gitEntryPath: string, entryType: EntryType): Promise<string | null> {
	if (entryType === "directory") return gitEntryPath;
	const content = await readOptionalText(gitEntryPath);
	if (content === null) return null;
	const parsed = parseGitDirPointer(content);
	if (!parsed) return null;
	const gitDir = path.resolve(path.dirname(gitEntryPath), parsed);
	return (await getEntryType(gitDir)) === "directory" ? gitDir : null;
}

function resolveCommonDirSync(gitDir: string): string {
	const content = readOptionalTextSync(path.join(gitDir, "commondir"));
	const relative = content?.trim();
	if (!relative) return gitDir;
	return path.resolve(gitDir, relative);
}

async function resolveCommonDir(gitDir: string): Promise<string> {
	const content = await readOptionalText(path.join(gitDir, "commondir"));
	const relative = content?.trim();
	if (!relative) return gitDir;
	return path.resolve(gitDir, relative);
}
function isLinkedWorktree(repository: GitRepository): boolean {
	return (
		repository.gitDir !== repository.commonDir &&
		getEntryTypeSync(path.join(repository.gitDir, "commondir")) === "file"
	);
}

async function isLinkedWorktreeAsync(repository: GitRepository): Promise<boolean> {
	return (
		repository.gitDir !== repository.commonDir &&
		(await getEntryType(path.join(repository.gitDir, "commondir"))) === "file"
	);
}

function primaryRootFromRepositorySync(repository: GitRepository): string {
	if (path.basename(repository.commonDir) === ".git") return path.dirname(repository.commonDir);
	if (isLinkedWorktree(repository)) return repository.commonDir;
	return repository.repoRoot;
}

async function primaryRootFromRepository(repository: GitRepository): Promise<string> {
	if (path.basename(repository.commonDir) === ".git") return path.dirname(repository.commonDir);
	if (await isLinkedWorktreeAsync(repository)) return repository.commonDir;
	return repository.repoRoot;
}

function resolveRepoFromEntrySync(repoRoot: string, gitEntryPath: string, entryType: EntryType): GitRepository | null {
	const gitDir = resolveGitDirSync(gitEntryPath, entryType);
	if (!gitDir) return null;
	return {
		commonDir: resolveCommonDirSync(gitDir),
		gitDir,
		gitEntryPath,
		headPath: path.join(gitDir, "HEAD"),
		repoRoot,
	};
}

async function resolveRepoFromEntry(
	repoRoot: string,
	gitEntryPath: string,
	entryType: EntryType,
): Promise<GitRepository | null> {
	const gitDir = await resolveGitDir(gitEntryPath, entryType);
	if (!gitDir) return null;
	return {
		commonDir: await resolveCommonDir(gitDir),
		gitDir,
		gitEntryPath,
		headPath: path.join(gitDir, "HEAD"),
		repoRoot,
	};
}

function resolveRepositorySync(startDir: string): GitRepository | null {
	let current = path.resolve(startDir);
	while (true) {
		const gitEntryPath = path.join(current, ".git");
		const entryType = getEntryTypeSync(gitEntryPath);
		if (entryType) {
			try {
				const repository = resolveRepoFromEntrySync(current, gitEntryPath, entryType);
				if (repository) return repository;
			} catch (err) {
				if (entryType === "file" && isPermissionError(err)) return null;
				throw err;
			}
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

async function resolveRepository(startDir: string): Promise<GitRepository | null> {
	let current = path.resolve(startDir);
	while (true) {
		const gitEntryPath = path.join(current, ".git");
		const entryType = await getEntryType(gitEntryPath);
		if (entryType) {
			try {
				const repository = await resolveRepoFromEntry(current, gitEntryPath, entryType);
				if (repository) return repository;
			} catch (err) {
				if (entryType === "file" && isPermissionError(err)) return null;
				throw err;
			}
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function getRefLookupDirs(repository: GitRepository): string[] {
	if (repository.gitDir === repository.commonDir) return [repository.gitDir];
	return [repository.gitDir, repository.commonDir];
}

function normalizeRefValue(content: string | null): string | null {
	const trimmed = content?.trim() ?? "";
	return trimmed || null;
}

function parsePackedRefs(content: string | null, targetRef: string): string | null {
	if (!content) return null;
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) continue;
		const [sha, refName] = trimmed.split(" ", 2);
		if (refName === targetRef && sha) return sha;
	}
	return null;
}

function stripGitConfigComments(line: string): string {
	let clean = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') {
			inQuotes = !inQuotes;
			clean += char;
		} else if (!inQuotes && (char === ";" || char === "#")) {
			break;
		} else {
			clean += char;
		}
	}
	return clean.trim();
}

function parseGitConfigHasReftable(content: string): boolean {
	let inExtensions = false;
	for (const line of content.split("\n")) {
		const trimmed = stripGitConfigComments(line);
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			const section = trimmed.slice(1, -1).trim().toLowerCase();
			inExtensions = section === "extensions";
		} else if (inExtensions) {
			const eqIndex = trimmed.indexOf("=");
			if (eqIndex !== -1) {
				const key = trimmed.slice(0, eqIndex).trim().toLowerCase();
				let value = trimmed.slice(eqIndex + 1).trim();
				if (key === "refstorage") {
					if (value.startsWith('"') && value.endsWith('"')) {
						value = value.slice(1, -1).trim();
					}
					const lowerValue = value.toLowerCase();
					if (lowerValue === "reftable" || lowerValue.startsWith("reftable:")) {
						return true;
					}
				}
			}
		}
	}
	return false;
}

function isReftableRepoSync(repository: GitRepository): boolean {
	if (repository.isReftable !== undefined) return repository.isReftable;
	const configPath = path.join(repository.commonDir, "config");
	const content = readOptionalTextSync(configPath);
	repository.isReftable = content ? parseGitConfigHasReftable(content) : false;
	return repository.isReftable;
}

async function isReftableRepo(repository: GitRepository): Promise<boolean> {
	if (repository.isReftable !== undefined) return repository.isReftable;
	const configPath = path.join(repository.commonDir, "config");
	const content = await readOptionalText(configPath);
	repository.isReftable = content ? parseGitConfigHasReftable(content) : false;
	return repository.isReftable;
}

async function resolveHeadStateReftable(repository: GitRepository, signal?: AbortSignal): Promise<GitHeadState | null> {
	throwIfAborted(signal);
	const symResult = await git(repository.repoRoot, ["symbolic-ref", "HEAD"], { readOnly: true, signal }).catch(err => {
		if (signal?.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "ToolAbortError"))) {
			throw err;
		}
		return null;
	});
	throwIfAborted(signal);
	const revResult = await git(repository.repoRoot, ["rev-parse", "--verify", "HEAD"], {
		readOnly: true,
		signal,
	}).catch(err => {
		if (signal?.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "ToolAbortError"))) {
			throw err;
		}
		return null;
	});
	const commit = revResult && revResult.exitCode === 0 ? revResult.stdout.trim() || null : null;

	if (symResult && symResult.exitCode === 0) {
		const ref = symResult.stdout.trim();
		const branchName = ref.startsWith(LOCAL_BRANCH_PREFIX) ? ref.slice(LOCAL_BRANCH_PREFIX.length) : null;
		return {
			...repository,
			kind: "ref",
			ref,
			branchName,
			commit,
			headContent: `${HEAD_REF_PREFIX} ${ref}`,
		};
	}

	return {
		...repository,
		kind: "detached",
		commit,
		headContent: commit || "",
	};
}

function resolveHeadStateReftableSync(repository: GitRepository): GitHeadState | null {
	const symResult = gitSpawnSyncText(repository.repoRoot, ["symbolic-ref", "HEAD"]);
	const revResult = gitSpawnSyncText(repository.repoRoot, ["rev-parse", "--verify", "HEAD"]);
	const commit = revResult.exitCode === 0 ? revResult.stdout || null : null;

	if (symResult.exitCode === 0) {
		const ref = symResult.stdout;
		const branchName = ref.startsWith(LOCAL_BRANCH_PREFIX) ? ref.slice(LOCAL_BRANCH_PREFIX.length) : null;
		return {
			...repository,
			kind: "ref",
			ref,
			branchName,
			commit,
			headContent: `${HEAD_REF_PREFIX} ${ref}`,
		};
	}

	return {
		...repository,
		kind: "detached",
		commit,
		headContent: commit || "",
	};
}

function readRefSync(repository: GitRepository, targetRef: string): string | null {
	if (isReftableRepoSync(repository)) {
		const symResult = gitSpawnSyncText(repository.repoRoot, ["symbolic-ref", targetRef]);
		if (symResult.exitCode === 0) {
			return `${HEAD_REF_PREFIX} ${symResult.stdout}`;
		}
		const revResult = gitSpawnSyncText(repository.repoRoot, ["rev-parse", "--verify", targetRef]);
		if (revResult.exitCode === 0) {
			return revResult.stdout || null;
		}
		return null;
	}

	for (const dir of getRefLookupDirs(repository)) {
		const value = normalizeRefValue(readOptionalTextSync(path.join(dir, targetRef)));
		if (value) return value;
	}
	for (const dir of getRefLookupDirs(repository)) {
		const value = parsePackedRefs(readOptionalTextSync(path.join(dir, "packed-refs")), targetRef);
		if (value) return value;
	}
	return null;
}

async function readRef(repository: GitRepository, targetRef: string, signal?: AbortSignal): Promise<string | null> {
	if (await isReftableRepo(repository)) {
		throwIfAborted(signal);
		const symResult = await git(repository.repoRoot, ["symbolic-ref", targetRef], { readOnly: true, signal }).catch(
			err => {
				if (
					signal?.aborted ||
					(err instanceof Error && (err.name === "AbortError" || err.name === "ToolAbortError"))
				) {
					throw err;
				}
				return null;
			},
		);
		if (symResult && symResult.exitCode === 0) {
			return `${HEAD_REF_PREFIX} ${symResult.stdout.trim()}`;
		}
		throwIfAborted(signal);
		const revResult = await git(repository.repoRoot, ["rev-parse", "--verify", targetRef], {
			readOnly: true,
			signal,
		}).catch(err => {
			if (
				signal?.aborted ||
				(err instanceof Error && (err.name === "AbortError" || err.name === "ToolAbortError"))
			) {
				throw err;
			}
			return null;
		});
		if (revResult && revResult.exitCode === 0) {
			return revResult.stdout.trim() || null;
		}
		return null;
	}

	for (const dir of getRefLookupDirs(repository)) {
		const value = normalizeRefValue(await readOptionalText(path.join(dir, targetRef)));
		if (value) return value;
	}
	for (const dir of getRefLookupDirs(repository)) {
		const value = parsePackedRefs(await readOptionalText(path.join(dir, "packed-refs")), targetRef);
		if (value) return value;
	}
	return null;
}

function parseHeadStateSync(repository: GitRepository, headContent: string): GitHeadState {
	const trimmed = headContent.trim();
	if (!trimmed?.startsWith(HEAD_REF_PREFIX)) {
		return { ...repository, commit: trimmed || null, headContent, kind: "detached" };
	}
	const refValue = trimmed.slice(HEAD_REF_PREFIX.length).trim();
	const branchName = refValue.startsWith(LOCAL_BRANCH_PREFIX) ? refValue.slice(LOCAL_BRANCH_PREFIX.length) : null;
	return {
		...repository,
		branchName,
		commit: readRefSync(repository, refValue),
		headContent,
		kind: "ref",
		ref: refValue,
	};
}

async function parseHeadState(repository: GitRepository, headContent: string): Promise<GitHeadState> {
	const trimmed = headContent.trim();
	if (!trimmed?.startsWith(HEAD_REF_PREFIX)) {
		return { ...repository, commit: trimmed || null, headContent, kind: "detached" };
	}
	const refValue = trimmed.slice(HEAD_REF_PREFIX.length).trim();
	const branchName = refValue.startsWith(LOCAL_BRANCH_PREFIX) ? refValue.slice(LOCAL_BRANCH_PREFIX.length) : null;
	return {
		...repository,
		branchName,
		commit: await readRef(repository, refValue),
		headContent,
		kind: "ref",
		ref: refValue,
	};
}

function parseDefaultBranchRef(refPath: string, target: string | null): string | null {
	if (!target?.startsWith(HEAD_REF_PREFIX)) return null;
	const resolvedRef = target.slice(HEAD_REF_PREFIX.length).trim();
	const remotePrefix = refPath.slice(0, -"HEAD".length);
	if (!resolvedRef.startsWith(remotePrefix)) return null;
	return resolvedRef.slice(remotePrefix.length) || null;
}

function stripRemotePrefix(refValue: string): string | null {
	const slash = refValue.indexOf("/");
	if (slash < 0) return refValue || null;
	return refValue.slice(slash + 1) || null;
}

function parseWorktreeList(text: string): GitWorktreeEntry[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	return trimmed
		.split(/\n\s*\n/)
		.map(block => block.trim())
		.filter(Boolean)
		.map(block => {
			const entry: GitWorktreeEntry = { detached: false, path: "" };
			for (const line of block.split("\n")) {
				if (line.startsWith("worktree ")) entry.path = line.slice("worktree ".length);
				else if (line.startsWith("HEAD ")) entry.head = line.slice("HEAD ".length);
				else if (line.startsWith("branch ")) entry.branch = line.slice("branch ".length);
				else if (line === "detached") entry.detached = true;
			}
			return entry;
		});
}

function extractFileHeader(diffText: string): string {
	const lines = diffText.split("\n");
	const headerLines: string[] = [];
	for (const line of lines) {
		if (line.startsWith("@@")) break;
		headerLines.push(line);
	}
	return headerLines.join("\n");
}

function selectHunks(file: FileHunks, selector: HunkSelection["hunks"]): FileHunks["hunks"] {
	if (selector.type === "indices") {
		const wanted = new Set(selector.indices.map(v => Math.max(1, Math.floor(v))));
		return file.hunks.filter(hunk => wanted.has(hunk.index + 1));
	}
	if (selector.type === "lines") {
		const start = Math.floor(selector.start);
		const end = Math.floor(selector.end);
		return file.hunks.filter(hunk => hunk.newStart <= end && hunk.newStart + hunk.newLines - 1 >= start);
	}
	return file.hunks;
}

export function createHunkSelectionValidator(
	rawDiff: string,
): (selections: readonly HunkSelection[]) => HunkSelectionValidationError[] {
	const fileDiffMap = new Map(parseFileDiffs(rawDiff).map(entry => [entry.filename, entry]));
	return selections => validateHunkSelectionsFromMap(fileDiffMap, selections);
}

function validateHunkSelectionsFromMap(
	fileDiffMap: ReadonlyMap<string, FileDiff>,
	selections: readonly HunkSelection[],
): HunkSelectionValidationError[] {
	const errors: HunkSelectionValidationError[] = [];

	for (const selection of selections) {
		const fileDiff = fileDiffMap.get(selection.path);
		if (!fileDiff) continue;
		if (selection.hunks.type === "all") continue;
		if (fileDiff.isBinary) {
			errors.push({ path: selection.path, message: `Cannot select hunks for binary file ${selection.path}` });
			continue;
		}
		const selected = selectHunks(parseFileHunks(fileDiff), selection.hunks);
		if (selected.length === 0) {
			errors.push({ path: selection.path, message: `No hunks selected for ${selection.path}` });
		}
	}

	return errors;
}

function parseStatusPorcelain(text: string): GitStatusSummary {
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	for (const line of text.split("\n")) {
		if (!line) continue;
		const x = line[0];
		const y = line[1];
		if (x === "?" && y === "?") {
			untracked += 1;
			continue;
		}
		if (x && x !== " " && x !== "?") staged += 1;
		if (y && y !== " ") unstaged += 1;
	}
	return { staged, unstaged, untracked };
}

export const diff = Object.assign(
	async function diff(cwd: string, options: DiffOptions = {}): Promise<string> {
		const args = buildDiffArgs(options);
		if (options.allowFailure) {
			return (await git(cwd, args, { env: options.env, readOnly: true, signal: options.signal })).stdout;
		}
		const result = await runChecked(cwd, args, { env: options.env, readOnly: true, signal: options.signal });
		if (options.requireComplete && result.truncated) {
			throw new GitOutputTruncatedError(args, result);
		}
		return result.stdout;
	},
	{
		async changedFiles(
			cwd: string,
			options: Pick<DiffOptions, "cached" | "files" | "signal"> = {},
		): Promise<string[]> {
			return splitLines(await diff(cwd, { ...options, nameOnly: true }));
		},

		async numstat(cwd: string, options: Pick<DiffOptions, "cached" | "signal"> = {}): Promise<NumstatEntry[]> {
			return parseNumstat(await diff(cwd, { ...options, numstat: true }));
		},

		async hunks(
			cwd: string,
			files: readonly string[],
			options: { cached?: boolean; signal?: AbortSignal } = {},
		): Promise<FileHunks[]> {
			return parseCommitDiffHunks(
				await diff(cwd, { cached: options.cached ?? true, files, signal: options.signal }),
			);
		},

		async has(cwd: string, options: Pick<DiffOptions, "cached" | "files" | "signal"> = {}): Promise<boolean> {
			const args = ["diff"];
			if (options.cached) args.push("--cached");
			args.push("--quiet");
			if (options.files?.length) args.push("--", ...options.files);
			const result = await git(cwd, args, { readOnly: true, signal: options.signal });
			if (result.exitCode === 0) return false;
			if (result.exitCode === 1) return true;
			throw new GitCommandError(args, result);
		},

		async tree(
			cwd: string,
			base: string,
			headRef: string,
			options: { binary?: boolean; signal?: AbortSignal; allowFailure?: boolean } = {},
		): Promise<string> {
			const args = ["diff-tree", "-r", "-p"];
			if (options.binary) args.push("--binary");
			args.push(base, headRef);
			if (options.allowFailure) {
				return (await git(cwd, args, { readOnly: true, signal: options.signal })).stdout;
			}
			return runText(cwd, args, { readOnly: true, signal: options.signal });
		},

		parseFiles(text: string): FileDiff[] {
			return parseFileDiffs(text);
		},

		parseHunks(text: string): FileHunks[] {
			return parseCommitDiffHunks(text);
		},
	},
);

export const status = Object.assign(
	async function status(cwd: string, options: StatusOptions = {}): Promise<string> {
		const args = ["status"];
		args.push(options.porcelainV1 ? "--porcelain=v1" : "--porcelain");
		if (options.z) args.push("-z");
		if (options.untrackedFiles) args.push(`--untracked-files=${options.untrackedFiles}`);
		if (options.pathspecs?.length) args.push("--", ...options.pathspecs);
		return runText(cwd, args, { readOnly: true, signal: options.signal });
	},
	{
		async summary(cwd: string, signal?: AbortSignal): Promise<GitStatusSummary | null> {
			const result = await git(cwd, ["status", "--porcelain"], { readOnly: true, signal });
			if (result.exitCode !== 0) return null;
			return parseStatusPorcelain(result.stdout);
		},

		parse: parseStatusPorcelain,
	},
);

export const stage = {
	async files(cwd: string, files: readonly string[] = [], signal?: AbortSignal): Promise<void> {
		const args = files.length === 0 ? ["add", "-A"] : ["add", "--", ...files];
		await runEffect(cwd, args, { signal });
	},

	async hunks(cwd: string, selections: HunkSelection[], options: StageHunksOptions = {}): Promise<void> {
		if (selections.length === 0) return;
		const rawDiff = options.rawDiff ?? (await diff(cwd, { cached: options.diffCached, signal: options.signal }));
		const fileDiffs = parseFileDiffs(rawDiff);
		const fileDiffMap = new Map(fileDiffs.map(entry => [entry.filename, entry]));
		const patchParts: string[] = [];

		for (const selection of selections) {
			const fileDiff = fileDiffMap.get(selection.path);
			if (!fileDiff) throw new Error(`No diff found for ${selection.path}`);
			if (fileDiff.isBinary) {
				if (selection.hunks.type !== "all")
					throw new Error(`Cannot select hunks for binary file ${selection.path}`);
				patchParts.push(fileDiff.content);
				continue;
			}
			if (selection.hunks.type === "all") {
				patchParts.push(fileDiff.content);
				continue;
			}
			const fileHunks = parseFileHunks(fileDiff);
			const selected = selectHunks(fileHunks, selection.hunks);
			if (selected.length === 0) throw new Error(`No hunks selected for ${selection.path}`);
			const header = extractFileHeader(fileDiff.content);
			patchParts.push([header, ...selected.map(h => h.content)].join("\n"));
		}

		const patchText = patch.join(patchParts);
		if (!patchText.trim()) return;
		await patch.applyText(cwd, patchText, { cached: true, signal: options.signal });
	},

	async reset(cwd: string, files: readonly string[] = [], signal?: AbortSignal): Promise<void> {
		const args = files.length === 0 ? ["reset"] : ["reset", "--", ...files];
		await runEffect(cwd, args, { signal });
	},
};

export async function commit(cwd: string, message: string, options: CommitOptions = {}): Promise<GitCommandResult> {
	const args = ["commit", "-F", "-"];
	if (options.author) {
		args.push(`--author=${options.author.name} <${options.author.email}>`);
		if (options.author.date) args.push(`--date=${options.author.date}`);
	}
	if (options.allowEmpty) args.push("--allow-empty");
	if (options.files?.length) args.push("--", ...options.files);
	return runChecked(cwd, args, { signal: options.signal, stdin: message });
}

export async function push(cwd: string, options: PushOptions = {}): Promise<void> {
	const args = ["push", "--no-follow-tags"];
	if (options.forceWithLease) args.push("--force-with-lease");
	if (options.remote) args.push(options.remote);
	if (options.refspec) args.push(options.refspec);
	await runEffect(cwd, args, { signal: options.signal });
}

export async function checkout(cwd: string, ref: string, signal?: AbortSignal): Promise<void> {
	await runEffect(cwd, ["checkout", ref], { signal });
}

export async function fetch(
	cwd: string,
	remote: string,
	source: string,
	target: string,
	options: FetchOptions = {},
): Promise<void> {
	await runEffect(cwd, ["fetch", remote, `+${source}:${target}`], {
		signal: options.signal,
		timeoutMs: resolveTimeoutMs(options.timeoutMs, GIT_NETWORK_TIMEOUT_MS),
	});
}

export async function readTree(
	cwd: string,
	treeish: string,
	options: Pick<CommandOptions, "env" | "signal"> = {},
): Promise<void> {
	await runEffect(cwd, ["read-tree", treeish], options);
}

export async function writeTree(cwd: string, options: Pick<CommandOptions, "env" | "signal"> = {}): Promise<string> {
	return (await runText(cwd, ["write-tree"], options)).trim();
}

type DetachGitDirResult = "no-git" | "independent" | "detached";

export async function detachGitDir(worktreeRoot: string, sourceCommonDir: string): Promise<DetachGitDirResult> {
	ensureAvailable();
	const gitEntry = path.join(worktreeRoot, ".git");
	let entryStat: fs.Stats;
	try {
		entryStat = await fs.promises.lstat(gitEntry);
	} catch (err) {
		if (isEnoent(err)) return "no-git";
		throw err;
	}

	const parentCommon = await fs.promises.realpath(sourceCommonDir).catch(() => path.resolve(sourceCommonDir));
	const isoCommonRaw = (
		await runText(worktreeRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			readOnly: true,
		})
	).trim();
	const isoCommon = await fs.promises.realpath(isoCommonRaw).catch(() => path.resolve(isoCommonRaw));

	if (isoCommon !== parentCommon) return "independent";

	const headSha = (await tryText(worktreeRoot, ["rev-parse", "HEAD"], { readOnly: true }))?.trim() ?? "";
	const headRef = (await tryText(worktreeRoot, ["symbolic-ref", "-q", "HEAD"], { readOnly: true }))?.trim() ?? "";
	const refDump = headSha
		? (
				await runText(worktreeRoot, ["for-each-ref", "--format=%(objectname) %(refname)"], {
					readOnly: true,
				})
			).trim()
		: "";
	const objectFormat =
		(await tryText(worktreeRoot, ["rev-parse", "--show-object-format"], { readOnly: true }))?.trim() || "sha1";
	const userName = await config.get(worktreeRoot, "user.name");
	const userEmail = await config.get(worktreeRoot, "user.email");

	const indexPath = (
		await runText(worktreeRoot, ["rev-parse", "--path-format=absolute", "--git-path", "index"], {
			readOnly: true,
		})
	).trim();
	const indexBytes = await readOptionalBytes(indexPath);
	const sparseCheckout = await config.get(worktreeRoot, "core.sparseCheckout");
	const sparseCone = await config.get(worktreeRoot, "core.sparseCheckoutCone");
	const sparsePatternPath = (
		await runText(worktreeRoot, ["rev-parse", "--path-format=absolute", "--git-path", "info/sparse-checkout"], {
			readOnly: true,
		})
	).trim();
	const sparsePatterns = await readOptionalText(sparsePatternPath);

	const fileMode = await config.get(worktreeRoot, "core.fileMode");

	const splitIndex = await config.get(worktreeRoot, "core.splitIndex");
	const sharedIndexFiles: Array<{ name: string; bytes: Uint8Array }> = [];
	if (indexBytes) {
		const indexDir = path.dirname(indexPath);
		let entries: string[] = [];
		try {
			entries = await fs.promises.readdir(indexDir);
		} catch {}
		for (const name of entries) {
			if (!name.startsWith("sharedindex.")) continue;
			const bytes = await readOptionalBytes(path.join(indexDir, name));
			if (bytes) sharedIndexFiles.push({ name, bytes });
		}
	}

	const shallowBoundary = await readOptionalText(path.join(parentCommon, "shallow"));

	let ownWorktreeAdmin: string | undefined;
	if (entryStat.isFile()) {
		const pointer = parseGitDirPointer((await readOptionalText(gitEntry)) ?? "");
		if (pointer) {
			const adminDir = path.resolve(path.dirname(gitEntry), pointer);
			const backRef = (await readOptionalText(path.join(adminDir, "gitdir")))?.trim();
			if (backRef) {
				const [realBackRef, realGitEntry] = await Promise.all([
					fs.promises.realpath(backRef).catch(() => path.resolve(backRef)),
					fs.promises.realpath(gitEntry).catch(() => path.resolve(gitEntry)),
				]);
				if (realBackRef === realGitEntry) ownWorktreeAdmin = adminDir;
			}
		}
	}

	await fs.promises.rm(gitEntry, { recursive: true, force: true });
	if (ownWorktreeAdmin) await fs.promises.rm(ownWorktreeAdmin, { recursive: true, force: true });

	const initArgs = ["init", "--object-format", objectFormat, "-q"];
	const initialBranch = headRef.startsWith(LOCAL_BRANCH_PREFIX) ? headRef.slice(LOCAL_BRANCH_PREFIX.length) : "";
	if (initialBranch) initArgs.push("-b", initialBranch);
	await runEffect(worktreeRoot, initArgs);
	const objectsInfo = path.join(gitEntry, "objects", "info");
	await fs.promises.mkdir(objectsInfo, { recursive: true });
	const alternates = [path.join(parentCommon, "objects")];
	const chained = await readOptionalText(path.join(parentCommon, "objects", "info", "alternates"));
	if (chained) {
		for (const line of chained.split("\n")) {
			const entry = line.trim();
			if (!entry) continue;
			alternates.push(path.isAbsolute(entry) ? entry : path.resolve(parentCommon, "objects", entry));
		}
	}
	await Bun.write(path.join(objectsInfo, "alternates"), `${alternates.join("\n")}\n`);

	if (headSha) {
		await Bun.write(path.join(gitEntry, "HEAD"), `${headSha}\n`);
		if (refDump) {
			const commands = refDump
				.split("\n")
				.filter(Boolean)
				.map(line => {
					const sep = line.indexOf(" ");
					return `create ${line.slice(sep + 1)} ${line.slice(0, sep)}`;
				})
				.join("\n");
			await runEffect(worktreeRoot, ["update-ref", "--stdin"], { stdin: `${commands}\n` });
		}
		if (headRef) await Bun.write(path.join(gitEntry, "HEAD"), `ref: ${headRef}\n`);
	} else if (headRef && !initialBranch) {
		await Bun.write(path.join(gitEntry, "HEAD"), `ref: ${headRef}\n`);
	}

	if (userName) await config.set(worktreeRoot, "user.name", userName);
	if (userEmail) await config.set(worktreeRoot, "user.email", userEmail);
	if (fileMode !== undefined) await config.set(worktreeRoot, "core.fileMode", fileMode);
	if (splitIndex !== undefined) await config.set(worktreeRoot, "core.splitIndex", splitIndex);

	if (shallowBoundary !== null) await Bun.write(path.join(gitEntry, "shallow"), shallowBoundary);

	if (sparseCheckout) await config.set(worktreeRoot, "core.sparseCheckout", sparseCheckout);
	if (sparseCone) await config.set(worktreeRoot, "core.sparseCheckoutCone", sparseCone);
	if (sparsePatterns !== null) {
		const infoDir = path.join(gitEntry, "info");
		await fs.promises.mkdir(infoDir, { recursive: true });
		await Bun.write(path.join(infoDir, "sparse-checkout"), sparsePatterns);
	}

	if (indexBytes) {
		for (const shared of sharedIndexFiles) {
			await Bun.write(path.join(gitEntry, shared.name), shared.bytes);
		}
		await Bun.write(path.join(gitEntry, "index"), indexBytes);
	} else if (headSha) {
		await readTree(worktreeRoot, headSha);
	}
	return "detached";
}

export const show = Object.assign(
	async function show(
		cwd: string,
		revision: string,
		options: { format?: string; signal?: AbortSignal } = {},
	): Promise<string> {
		return runText(cwd, ["show", `--format=${options.format ?? ""}`, revision], {
			readOnly: true,
			signal: options.signal,
		});
	},
	{
		async prefix(cwd: string, signal?: AbortSignal): Promise<string> {
			return (await runText(cwd, ["rev-parse", "--show-prefix"], { readOnly: true, signal })).trim();
		},
	},
);

export async function commitDetails(cwd: string, revision: string, signal?: AbortSignal): Promise<CommitDetails> {
	const raw = await runText(cwd, ["show", "-s", "--format=%an%x00%ae%x00%aI%x00%B", revision], {
		readOnly: true,
		signal,
	});
	const [name = "", email = "", date = "", ...messageParts] = raw.split("\0");
	return {
		author: { date, email, name },
		message: messageParts.join("\0").replace(/\n$/, ""),
	};
}

export const log = {
	async subjects(cwd: string, count: number, signal?: AbortSignal): Promise<string[]> {
		return splitLines(await runText(cwd, ["log", `-n${count}`, "--pretty=format:%s"], { readOnly: true, signal }));
	},

	async onelines(cwd: string, count: number, signal?: AbortSignal): Promise<string[]> {
		return splitLines(
			await runText(cwd, ["log", `-${count}`, "--oneline", "--no-decorate"], { readOnly: true, signal }),
		);
	},
};

export const revList = {
	async range(cwd: string, base: string, head: string, signal?: AbortSignal): Promise<string[]> {
		return splitLines(await runText(cwd, ["rev-list", "--reverse", `${base}..${head}`], { readOnly: true, signal }));
	},

	async touching(cwd: string, ref: string, file: string, limit: number, signal?: AbortSignal): Promise<string[]> {
		return splitLines(
			await runText(cwd, ["rev-list", `--max-count=${limit}`, ref, "--", file], { readOnly: true, signal }),
		);
	},
};

export const branch = {
	async current(cwd: string, signal?: AbortSignal): Promise<string | null> {
		const headState = await resolveHead(cwd);
		if (headState?.kind === "ref") return headState.branchName ?? headState.ref;
		const result = await git(cwd, ["symbolic-ref", "--short", "HEAD"], { readOnly: true, signal });
		if (result.exitCode !== 0) return null;
		return result.stdout.trim() || null;
	},

	async default(cwd: string, signal?: AbortSignal): Promise<string | null> {
		const repository = await resolveRepository(cwd);
		if (repository) {
			for (const refPath of DEFAULT_BRANCH_REFS) {
				const target = await readRef(repository, refPath, signal);
				const branchName = parseDefaultBranchRef(refPath, target);
				if (branchName) return branchName;
			}
		}
		for (const remoteRef of ["origin/HEAD", "upstream/HEAD"]) {
			const result = await git(cwd, ["rev-parse", "--abbrev-ref", remoteRef], { readOnly: true, signal });
			if (result.exitCode !== 0) continue;
			const branchName = stripRemotePrefix(result.stdout.trim());
			if (branchName) return branchName;
		}
		return null;
	},

	async create(cwd: string, name: string, startPoint = "HEAD", signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["branch", name, startPoint], { signal });
	},

	async force(cwd: string, name: string, startPoint: string, signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["branch", "--force", name, startPoint], { signal });
	},

	async delete(cwd: string, name: string, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
		await runEffect(cwd, ["branch", options.force === false ? "-d" : "-D", name], { signal: options.signal });
	},

	async tryDelete(
		cwd: string,
		name: string,
		options: { force?: boolean; signal?: AbortSignal } = {},
	): Promise<boolean> {
		const result = await git(cwd, ["branch", options.force === false ? "-d" : "-D", name], {
			signal: options.signal,
		});
		return result.exitCode === 0;
	},

	async checkoutNew(cwd: string, name: string, signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["checkout", "-b", name], { signal });
	},

	async list(cwd: string, options: { all?: boolean; signal?: AbortSignal } = {}): Promise<string[]> {
		const args = ["branch"];
		if (options.all) args.push("-a");
		args.push("--format=%(refname:short)");
		return splitLines(await runText(cwd, args, { readOnly: true, signal: options.signal }));
	},
};

export const remote = {
	async list(cwd: string, signal?: AbortSignal): Promise<string[]> {
		return splitLines(await runText(cwd, ["remote"], { readOnly: true, signal }));
	},

	async url(cwd: string, name: string, signal?: AbortSignal): Promise<string | undefined> {
		return trimScalar(await tryText(cwd, ["remote", "get-url", name], { readOnly: true, signal }));
	},

	async add(cwd: string, name: string, url: string, signal?: AbortSignal): Promise<void> {
		const result = await git(cwd, ["remote", "add", name, url], { signal });
		if (result.exitCode === 0) return;
		const existing = await remote.url(cwd, name, signal);
		if (existing !== undefined) {
			if (existing === url) return;
			throw new ToolError(`remote ${name} already exists with URL ${existing}, expected ${url}`);
		}
		throw new GitCommandError(["remote", "add", name, url], result);
	},
};

export const ref = {
	async exists(cwd: string, refName: string, signal?: AbortSignal): Promise<boolean> {
		if (refName === "HEAD") return (await head.sha(cwd, signal)) !== null;
		const repository = await resolveRepository(cwd);
		if (repository && refName.startsWith("refs/")) return (await readRef(repository, refName, signal)) !== null;
		const result = await git(cwd, ["show-ref", "--verify", "--quiet", refName], { readOnly: true, signal });
		return result.exitCode === 0;
	},

	async resolve(cwd: string, refName: string, signal?: AbortSignal): Promise<string | null> {
		if (refName === "HEAD") return head.sha(cwd, signal);
		const repository = await resolveRepository(cwd);
		if (repository && refName.startsWith("refs/")) return readRef(repository, refName, signal);
		const result = await git(cwd, ["rev-parse", refName], { readOnly: true, signal });
		if (result.exitCode !== 0) return null;
		return result.stdout.trim() || null;
	},

	async tags(cwd: string, refName = "HEAD", signal?: AbortSignal): Promise<string[]> {
		return splitLines(
			await runText(
				cwd,
				[
					"for-each-ref",
					"--points-at",
					refName,
					"--sort=-version:refname",
					"--format=%(refname:strip=2)",
					"refs/tags",
				],
				{ readOnly: true, signal },
			),
		);
	},
};

export const config = {
	async get(cwd: string, key: string, signal?: AbortSignal): Promise<string | undefined> {
		return trimScalar(await tryText(cwd, ["config", "--get", key], { readOnly: true, signal }));
	},

	async set(cwd: string, key: string, value: string, signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["config", key, value], { signal });
	},

	async getBranch(cwd: string, branchName: string, key: string, signal?: AbortSignal): Promise<string | undefined> {
		return config.get(cwd, `branch.${branchName}.${key}`, signal);
	},

	async setBranch(cwd: string, branchName: string, key: string, value: string, signal?: AbortSignal): Promise<void> {
		return config.set(cwd, `branch.${branchName}.${key}`, value, signal);
	},
};

export const worktree = {
	async add(
		cwd: string,
		worktreePath: string,
		refName: string,
		options: { detach?: boolean; signal?: AbortSignal } = {},
	): Promise<void> {
		const args = ["worktree", "add"];
		if (options.detach) args.push("--detach");
		args.push(worktreePath, refName);
		await runEffect(cwd, args, { signal: options.signal });
	},

	async remove(
		cwd: string,
		worktreePath: string,
		options: { force?: boolean; signal?: AbortSignal } = {},
	): Promise<void> {
		const args = ["worktree", "remove"];
		if (options.force ?? true) args.push("-f");
		args.push(worktreePath);
		await runEffect(cwd, args, { signal: options.signal });
	},

	async tryRemove(
		cwd: string,
		worktreePath: string,
		options: { force?: boolean; signal?: AbortSignal } = {},
	): Promise<boolean> {
		const args = ["worktree", "remove"];
		if (options.force ?? true) args.push("-f");
		args.push(worktreePath);
		const result = await git(cwd, args, { signal: options.signal });
		return result.exitCode === 0;
	},

	async list(cwd: string, signal?: AbortSignal): Promise<GitWorktreeEntry[]> {
		return parseWorktreeList(await runText(cwd, ["worktree", "list", "--porcelain"], { readOnly: true, signal }));
	},

	async prune(cwd: string, signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["worktree", "prune"], { signal });
	},
};

export const patch = {
	async apply(cwd: string, patchPath: string, options: PatchOptions = {}): Promise<void> {
		await runEffect(cwd, buildApplyArgs(patchPath, options), { env: options.env, signal: options.signal });
	},

	async applyText(cwd: string, patchText: string, options: PatchOptions = {}): Promise<void> {
		if (!patchText.trim()) return;
		const tempPath = await writeTempPatch(patchText);
		try {
			await patch.apply(cwd, tempPath, options);
		} finally {
			await fs.promises.rm(tempPath, { force: true });
		}
	},

	async canApply(cwd: string, patchPath: string, options: Omit<PatchOptions, "check"> = {}): Promise<boolean> {
		const result = await git(cwd, buildApplyArgs(patchPath, { ...options, check: true }), {
			env: options.env,
			readOnly: true,
			signal: options.signal,
		});
		return result.exitCode === 0;
	},

	async canApplyText(cwd: string, patchText: string, options: Omit<PatchOptions, "check"> = {}): Promise<boolean> {
		if (!patchText.trim()) return true;
		const tempPath = await writeTempPatch(patchText);
		try {
			return await patch.canApply(cwd, tempPath, options);
		} finally {
			await fs.promises.rm(tempPath, { force: true });
		}
	},

	join(parts: string[]): string {
		return parts.map(part => (part.endsWith("\n") ? part : `${part}\n`)).join("");
	},
};

export const cherryPick = Object.assign(
	async function cherryPick(cwd: string, revision: string, signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["cherry-pick", revision], { signal });
	},
	{
		async abort(cwd: string, signal?: AbortSignal): Promise<void> {
			await runEffect(cwd, ["cherry-pick", "--abort"], { signal });
		},

		async skip(cwd: string, signal?: AbortSignal): Promise<void> {
			await runEffect(cwd, ["cherry-pick", "--skip"], { signal });
		},

		isEmptyError(err: unknown): boolean {
			return err instanceof GitCommandError && /the previous cherry-pick is now empty/i.test(err.result.stderr);
		},
	},
);

export const stash = {
	async push(cwd: string, message?: string): Promise<boolean> {
		ensureAvailable();
		const previousStash = await ref.resolve(cwd, "refs/stash");
		const args = ["stash", "push", "--include-untracked"];
		if (message) args.push("-m", message);
		await runEffect(cwd, args);
		const nextStash = await ref.resolve(cwd, "refs/stash");
		return nextStash !== null && nextStash !== previousStash;
	},

	async pop(cwd: string, options?: { index?: boolean }): Promise<void> {
		const args = ["stash", "pop"];
		if (options?.index) args.push("--index");
		await runEffect(cwd, args);
	},

	async showPatch(cwd: string): Promise<string> {
		return (await tryText(cwd, ["stash", "show", "-p", "--binary", "stash@{0}"], { readOnly: true })) ?? "";
	},

	async untrackedFiles(cwd: string): Promise<string[]> {
		const output = await tryText(cwd, ["ls-tree", "-r", "-z", "--name-only", "stash@{0}^3"], { readOnly: true });
		return output?.split("\0").filter(Boolean) ?? [];
	},

	async tryPop(cwd: string, options?: { index?: boolean }): Promise<boolean> {
		const workingPatch = await stash.showPatch(cwd);
		if (workingPatch.trim() && !(await patch.canApplyText(cwd, workingPatch, { threeWay: true }))) {
			return false;
		}
		const restoredUntracked = await stash.untrackedFiles(cwd);
		try {
			await stash.pop(cwd, options);
			return true;
		} catch {
			try {
				await reset(cwd, { hard: true });
			} catch {}
			if (restoredUntracked.length > 0) {
				try {
					await clean(cwd, { includeIgnored: true, literalPathspecs: true, paths: restoredUntracked });
				} catch {}
			}
			return false;
		}
	},
};

export async function clone(url: string, targetDir: string, options: CloneOptions = {}): Promise<void> {
	ensureAvailable();
	const absoluteTarget = path.resolve(targetDir);
	await fs.promises.mkdir(path.dirname(absoluteTarget), { recursive: true });

	const shallow = !options.sha;
	const args = ["clone"];
	if (shallow) args.push("--depth", "1");
	if (options.ref) args.push("--branch", options.ref, "--single-branch");
	else if (shallow) args.push("--single-branch");
	args.push(url, absoluteTarget);

	try {
		await runEffect(path.dirname(absoluteTarget), args, {
			signal: options.signal,
			timeoutMs: resolveTimeoutMs(options.timeoutMs, GIT_NETWORK_TIMEOUT_MS),
		});
		if (options.sha) {
			try {
				await checkout(absoluteTarget, options.sha, options.signal);
			} catch {
				await fs.promises.rm(absoluteTarget, { force: true, recursive: true });
				throw new Error(`Failed to checkout SHA ${options.sha} in cloned repository ${url}`);
			}
		}
	} catch (err) {
		await fs.promises.rm(absoluteTarget, { force: true, recursive: true });
		throw err;
	}
}

export async function restore(cwd: string, options: RestoreOptions = {}): Promise<void> {
	const args = ["restore"];
	if (options.source) args.push(`--source=${options.source}`);
	if (options.staged) args.push("--staged");
	if (options.worktree) args.push("--worktree");
	if (options.files?.length) args.push("--", ...options.files);
	await runEffect(cwd, args, { signal: options.signal });
}

export async function reset(
	cwd: string,
	options: { hard?: boolean; mixed?: boolean; soft?: boolean; target?: string; signal?: AbortSignal } = {},
): Promise<void> {
	const args = ["reset"];
	if (options.hard) args.push("--hard");
	else if (options.mixed) args.push("--mixed");
	else if (options.soft) args.push("--soft");
	if (options.target) args.push(options.target);
	await runEffect(cwd, args, { signal: options.signal });
}

export async function clean(
	cwd: string,
	options: {
		ignoredOnly?: boolean;
		includeIgnored?: boolean;
		literalPathspecs?: boolean;
		paths?: readonly string[];
		signal?: AbortSignal;
	} = {},
): Promise<void> {
	const args = [options.literalPathspecs ? "--literal-pathspecs" : undefined, "clean"].filter(
		(arg): arg is string => arg !== undefined,
	);
	args.push(options.ignoredOnly ? "-fdX" : options.includeIgnored ? "-fdx" : "-fd");
	if (options.paths?.length) args.push("--", ...options.paths);
	await runEffect(cwd, args, { signal: options.signal });
}

export const ls = {
	async files(
		cwd: string,
		options: { others?: boolean; excludeStandard?: boolean; signal?: AbortSignal } = {},
	): Promise<string[]> {
		const args = ["ls-files"];
		if (options.others) args.push("--others");
		if (options.excludeStandard) args.push("--exclude-standard");
		return splitLines(await runText(cwd, args, { readOnly: true, signal: options.signal }));
	},

	async untracked(cwd: string, signal?: AbortSignal): Promise<string[]> {
		return ls.files(cwd, { others: true, excludeStandard: true, signal });
	},

	async tree(cwd: string, ref: string, files: readonly string[] = [], signal?: AbortSignal): Promise<string[]> {
		const args = ["ls-tree", "--name-only", "-r", "-z", ref];
		if (files.length > 0) args.push("--", ...files);
		const raw = await runText(cwd, args, { readOnly: true, signal });
		return raw.split("\0").filter(entry => entry.length > 0);
	},

	async submodules(cwd: string, signal?: AbortSignal): Promise<string[]> {
		const output = await git(cwd, ["submodule", "--quiet", "foreach", "--recursive", "echo $sm_path"], {
			readOnly: true,
			signal,
		});
		return splitLines(output.stdout);
	},
};

export const head = {
	async resolve(cwd: string, signal?: AbortSignal): Promise<GitHeadState | null> {
		const repository = await resolveRepository(cwd);
		if (!repository) return null;
		if (await isReftableRepo(repository)) {
			return resolveHeadStateReftable(repository, signal);
		}
		const content = await readOptionalText(repository.headPath);
		if (content === null) return null;
		return parseHeadState(repository, content);
	},

	resolveSync(cwd: string): GitHeadState | null {
		const repository = resolveRepositorySync(cwd);
		if (!repository) return null;
		if (isReftableRepoSync(repository)) {
			return resolveHeadStateReftableSync(repository);
		}
		const content = readOptionalTextSync(repository.headPath);
		if (content === null) return null;
		return parseHeadStateSync(repository, content);
	},

	async sha(cwd: string, signal?: AbortSignal): Promise<string | null> {
		const headState = await head.resolve(cwd, signal);
		if (headState?.commit) return headState.commit;
		const result = await git(cwd, ["rev-parse", "HEAD"], { readOnly: true, signal });
		if (result.exitCode !== 0) return null;
		return result.stdout.trim() || null;
	},

	async short(cwd: string, length = 7, signal?: AbortSignal): Promise<string | null> {
		const result = await git(cwd, ["rev-parse", `--short=${length}`, "HEAD"], { readOnly: true, signal });
		if (result.exitCode !== 0) return null;
		return result.stdout.trim() || null;
	},

	watch(repository: GitRepository, onChange: () => void): () => void {
		const target = isReftableRepoSync(repository) ? path.join(repository.gitDir, "reftable") : repository.headPath;
		const listener = (curr: fs.Stats, prev: fs.Stats) => {
			if (curr.mtimeMs !== prev.mtimeMs || curr.ino !== prev.ino || curr.size !== prev.size) onChange();
		};
		fs.watchFile(target, { interval: HEAD_WATCH_INTERVAL_MS }, listener).unref();
		return () => fs.unwatchFile(target, listener);
	},
};

export const repo = {
	async root(cwd: string, signal?: AbortSignal): Promise<string | null> {
		const repository = await resolveRepository(cwd);
		if (repository) return repository.repoRoot;
		const result = await git(cwd, ["rev-parse", "--show-toplevel"], { readOnly: true, signal });
		if (result.exitCode !== 0) return null;
		return result.stdout.trim() || null;
	},

	async primaryRoot(cwd: string, signal?: AbortSignal): Promise<string | null> {
		const repository = await resolveRepository(cwd);
		if (repository) return primaryRootFromRepository(repository);
		const repoRoot = await repo.root(cwd, signal);
		if (!repoRoot) return null;
		const commonDir = await runText(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			readOnly: true,
			signal,
		});
		if (path.basename(commonDir.trim()) === ".git") return path.dirname(commonDir.trim());
		return repoRoot;
	},

	primaryRootSync(cwd: string): string | null {
		const repository = resolveRepositorySync(cwd);
		if (!repository) return null;
		return primaryRootFromRepositorySync(repository);
	},

	linkedWorktreeSync(cwd: string): { root: string; primaryRoot: string } | null {
		const repository = resolveRepositorySync(cwd);
		if (!repository || !isLinkedWorktree(repository)) return null;
		return { root: repository.repoRoot, primaryRoot: primaryRootFromRepositorySync(repository) };
	},

	resolveSync(cwd: string): GitRepository | null {
		return resolveRepositorySync(cwd);
	},

	resolve(cwd: string): Promise<GitRepository | null> {
		return resolveRepository(cwd);
	},

	isReftableSync(repository: GitRepository): boolean {
		return isReftableRepoSync(repository);
	},

	isReftable(repository: GitRepository): Promise<boolean> {
		return isReftableRepo(repository);
	},
};

async function resolveHead(cwd: string, signal?: AbortSignal): Promise<GitHeadState | null> {
	return head.resolve(cwd, signal);
}

interface GhCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface GhCommandOptions {
	repoProvided?: boolean;
	trimOutput?: boolean;
}

function formatGhFailure(args: readonly string[], stdout: string, stderr: string, options?: GhCommandOptions): string {
	const message = (stderr || stdout).trim();
	if (message.includes("gh auth login") || message.includes("not logged into any GitHub hosts")) {
		return "GitHub CLI is not authenticated. Run `gh auth login`.";
	}
	if (
		!options?.repoProvided &&
		(message.includes("not a git repository") ||
			message.includes("no git remotes found") ||
			message.includes("unable to determine current repository"))
	) {
		return "GitHub repository context is unavailable. Pass `repo` explicitly or run the tool inside a GitHub checkout.";
	}
	if (message.length > 0) return message;
	return `GitHub CLI command failed: gh ${args.join(" ")}`;
}

export const github = {
	available(): boolean {
		return Boolean($which("gh"));
	},

	async run(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<GhCommandResult> {
		throwIfAborted(signal);
		if (!$which("gh")) {
			throw new ToolError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/.");
		}
		try {
			const child = Bun.spawn(["gh", ...args], {
				cwd,
				env: buildGhEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				signal,
			});
			const { stdout, stderr, exitCode } = await collectSubprocessResult("gh", args, child, {});
			throwIfAborted(signal);
			const trim = options?.trimOutput !== false;
			return {
				exitCode: exitCode ?? 0,
				stdout: trim ? stdout.trim() : stdout,
				stderr: trim ? stderr.trim() : stderr,
			};
		} catch (error) {
			if (signal?.aborted) throw new ToolAbortError();
			throw error;
		}
	},

	async json<T>(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<T> {
		const result = await github.run(cwd, args, signal, options);
		if (result.exitCode !== 0) {
			throw new ToolError(formatGhFailure(args, result.stdout, result.stderr, options));
		}
		if (!result.stdout) {
			throw new ToolError("GitHub CLI returned empty output.");
		}
		try {
			return JSON.parse(result.stdout) as T;
		} catch {
			throw new ToolError("GitHub CLI returned invalid JSON output.");
		}
	},

	async text(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<string> {
		const result = await github.run(cwd, args, signal, options);
		if (result.exitCode !== 0) {
			throw new ToolError(formatGhFailure(args, result.stdout, result.stderr, options));
		}
		return result.stdout;
	},
};
