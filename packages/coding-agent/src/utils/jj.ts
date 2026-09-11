import * as fs from "node:fs";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { withTimeoutSignal } from "./fetch-timeout";
import * as git from "./git";
import { readCappedText } from "./git";

const JJ_TRUNCATED_MARKER = "\n[jj subprocess output truncated after 8 MiB]\n";

interface JjCommandResult {
	exitCode: number;

	stdout: string;

	stderr: string;

	truncated: boolean;
}

interface JjRepository {
	repoRoot: string;

	storeDir: string;
}

export interface DiffOptions extends JjCommandOptions {
	readonly files?: readonly string[];

	readonly nameOnly?: boolean;
}

interface JjCommandOptions {
	readonly signal?: AbortSignal;

	readonly timeoutMs?: number;
}

const JJ_COMMAND_TIMEOUT_MS = 5_000;

class JjCommandError extends Error {
	readonly args: readonly string[];

	readonly result: JjCommandResult;

	constructor(args: readonly string[], result: JjCommandResult) {
		super(formatCommandFailure(args, result));
		this.name = "JjCommandError";
		this.args = [...args];
		this.result = result;
	}
}

const WORKING_COPY_LABEL_REVSET = "@ | heads(::@ & bookmarks())";
const WORKING_COPY_LABEL_TEMPLATE = 'change_id.shortest(8) ++ "|" ++ local_bookmarks ++ "\\n"';

function ensureAvailable(): void {
	if (!$which("jj")) {
		throw new Error("jj is not installed.");
	}
}

function formatCommandFailure(
	args: readonly string[],
	result: Pick<JjCommandResult, "exitCode" | "stdout" | "stderr">,
): string {
	const stderr = result.stderr.trim();
	if (stderr) return stderr;
	const stdout = result.stdout.trim();
	if (stdout) return stdout;
	return `jj ${args.join(" ")} failed with exit code ${result.exitCode}`;
}

async function jj(cwd: string, args: readonly string[], options: JjCommandOptions = {}): Promise<JjCommandResult> {
	const child = Bun.spawn(["jj", "--no-pager", "--color=never", ...args], {
		cwd,
		signal: withTimeoutSignal(options.timeoutMs ?? JJ_COMMAND_TIMEOUT_MS, options.signal),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	if (!child.stdout || !child.stderr) {
		throw new Error("Failed to capture jj command output.");
	}

	const [stdout, stderr, exitCode] = await Promise.all([
		readCappedText(child.stdout, git.GIT_COMMAND_OUTPUT_LIMIT_BYTES, JJ_TRUNCATED_MARKER),
		readCappedText(child.stderr, git.GIT_COMMAND_OUTPUT_LIMIT_BYTES, JJ_TRUNCATED_MARKER),
		child.exited,
	]);

	return {
		exitCode: exitCode ?? 0,
		stdout: stdout.text,
		stderr: stderr.text,
		truncated: stdout.truncated || stderr.truncated,
	};
}

async function runChecked(
	cwd: string,
	args: readonly string[],
	options: JjCommandOptions = {},
): Promise<JjCommandResult> {
	ensureAvailable();
	const result = await jj(cwd, args, options);
	if (result.exitCode !== 0) {
		throw new JjCommandError(args, result);
	}
	return result;
}

async function runText(cwd: string, args: readonly string[], options: JjCommandOptions = {}): Promise<string> {
	return (await runChecked(cwd, args, options)).stdout;
}

async function runOptionalText(
	cwd: string,
	args: readonly string[],
	options: JjCommandOptions = {},
): Promise<string | null> {
	try {
		const result = await jj(cwd, args, options);
		return result.exitCode === 0 ? result.stdout : null;
	} catch {
		return null;
	}
}

function splitLines(text: string): string[] {
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

function buildDiffArgs(options: DiffOptions): string[] {
	const args = ["diff"];
	args.push(options.nameOnly ? "--name-only" : "--git");
	if (options.files?.length) args.push("--", ...options.files);
	return args;
}

function parseWorkingCopyLabel(raw: string): string | null {
	let changeId: string | null = null;
	for (const line of raw.split("\n")) {
		const sep = line.indexOf("|");
		const change = (sep === -1 ? line : line.slice(0, sep)).trim();
		const bookmarks = sep === -1 ? "" : line.slice(sep + 1).trim();
		if (changeId === null && change) changeId = change;
		if (bookmarks) return bookmarks.replace(/\s+/g, " ");
	}
	return changeId;
}

function parseStatusSummary(raw: string): git.GitStatusSummary {
	let unstaged = 0;
	let untracked = 0;
	for (const line of raw.split("\n")) {
		const type = line.trim()[0];
		if (!type) continue;
		if (type === "A") untracked++;
		else unstaged++;
	}
	return { staged: 0, unstaged, untracked };
}

interface WorkspaceRootCacheEntry {
	readonly root?: string;
}

const WORKSPACE_ROOT_CACHE_MAX_ENTRIES = 256;
const workspaceRootCache = new LRUCache<string, WorkspaceRootCacheEntry>({ max: WORKSPACE_ROOT_CACHE_MAX_ENTRIES });

async function hasJjWorkspaceMetadata(dir: string): Promise<boolean> {
	try {
		await fs.promises.stat(path.join(dir, ".jj", "repo"));
		return true;
	} catch {
		return false;
	}
}

function hasJjWorkspaceMetadataSync(dir: string): boolean {
	try {
		fs.statSync(path.join(dir, ".jj", "repo"));
		return true;
	} catch {
		return false;
	}
}

function parentOf(dir: string): string | undefined {
	const parent = path.dirname(dir);
	return parent === dir ? undefined : parent;
}

async function findWorkspaceRoot(cwd: string): Promise<string | undefined> {
	const key = path.resolve(cwd);
	if (workspaceRootCache.has(key)) return workspaceRootCache.get(key)?.root;

	for (let dir: string | undefined = key; dir; dir = parentOf(dir)) {
		if (await hasJjWorkspaceMetadata(dir)) {
			workspaceRootCache.set(key, { root: dir });
			return dir;
		}
	}

	workspaceRootCache.set(key, {});
	return undefined;
}

function findWorkspaceRootSync(cwd: string): string | undefined {
	const key = path.resolve(cwd);
	if (workspaceRootCache.has(key)) return workspaceRootCache.get(key)?.root;

	for (let dir: string | undefined = key; dir; dir = parentOf(dir)) {
		if (hasJjWorkspaceMetadataSync(dir)) {
			workspaceRootCache.set(key, { root: dir });
			return dir;
		}
	}

	workspaceRootCache.set(key, {});
	return undefined;
}

async function resolveRepoDir(root: string): Promise<string> {
	const jjDir = path.join(root, ".jj");
	const repoPath = path.join(jjDir, "repo");
	if ((await fs.promises.stat(repoPath)).isFile()) {
		const target = (await fs.promises.readFile(repoPath, "utf8")).trim();
		return path.resolve(jjDir, target);
	}
	return repoPath;
}

async function repositoryFromRoot(root: string): Promise<JjRepository> {
	return {
		repoRoot: root,
		storeDir: path.join(await resolveRepoDir(root), "store"),
	};
}

export const diff = Object.assign(
	async function diff(cwd: string, options: DiffOptions = {}): Promise<string> {
		return runText(cwd, buildDiffArgs(options), { signal: options.signal });
	},
	{
		async changedFiles(cwd: string, options: Pick<DiffOptions, "files" | "signal"> = {}): Promise<string[]> {
			return splitLines(await diff(cwd, { ...options, nameOnly: true }));
		},
	},
);

export const workingCopy = {
	async label(cwd: string, options?: JjCommandOptions): Promise<string | null> {
		const raw = await runOptionalText(
			cwd,
			[
				"log",
				"--no-graph",
				"--ignore-working-copy",
				"-r",
				WORKING_COPY_LABEL_REVSET,
				"-T",
				WORKING_COPY_LABEL_TEMPLATE,
			],
			options,
		);
		return raw === null ? null : parseWorkingCopyLabel(raw);
	},

	parseLabel: parseWorkingCopyLabel,
};

export const status = {
	async summary(cwd: string, options?: JjCommandOptions): Promise<git.GitStatusSummary | null> {
		const raw = await runOptionalText(cwd, ["diff", "-r", "@", "--summary", "--ignore-working-copy"], options);
		return raw === null ? null : parseStatusSummary(raw);
	},

	parse: parseStatusSummary,
};

export const repo = {
	clearRootCache(): void {
		workspaceRootCache.clear();
	},

	rootSync(cwd: string): string | null {
		return findWorkspaceRootSync(cwd) ?? null;
	},

	async root(cwd: string): Promise<string | null> {
		return (await findWorkspaceRoot(cwd)) ?? null;
	},

	async resolve(cwd: string): Promise<JjRepository | null> {
		const root = await repo.root(cwd);
		return root ? await repositoryFromRoot(root) : null;
	},

	async is(cwd: string): Promise<boolean> {
		return (await repo.root(cwd)) !== null;
	},
};

export async function isPureJjRepo(cwd: string): Promise<boolean> {
	const jjRoot = await repo.root(cwd);
	if (jjRoot === null) return false;
	const gitRoot = await git.repo.root(cwd);
	if (gitRoot === null) return true;
	return isStrictDescendant(path.resolve(jjRoot), path.resolve(gitRoot));
}

function isStrictDescendant(child: string, ancestor: string): boolean {
	const rel = path.relative(ancestor, child);
	if (rel === "" || rel === ".") return false;
	if (rel.startsWith("..")) return false;

	return !path.isAbsolute(rel);
}
