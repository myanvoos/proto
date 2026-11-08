/**
 * A failed protofs checkout removal must not erase the record `proto worktree
 * clear` needs. Reusing the slot moves that record aside; a lost creation reply
 * keeps it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";
import { clearWorktrees } from "../cli/worktree-cli";
import * as client from "../protofs/client";
import * as daemon from "../protofs/daemon";
import * as executor from "./executor";
import { ISOLATION_OWNER_FILE } from "./isolation-ownership";
import * as isolationRunner from "./isolation-runner";
import { runIsolatedSubprocess } from "./isolation-runner";
import { PROTOFS_CHECKOUT_FILE, protofsWorkspace, releaseProtofsCheckout } from "./protofs";
import * as worktree from "./worktree";
import { taskIsolationBaseDir } from "./worktree";

const COMMAND = "/opt/protofs/protofs";
const STALE = "proto-authrefactor-stale1";

interface CheckoutRecord {
	command: string;
	checkout: string;
}

interface DaemonOp {
	op: string;
	checkout?: string;
	name?: string;
}

describe("protofs checkout recovery", () => {
	let root: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-protofs-"));
		savedEnv = process.env.PROTO_WORKTREE_DIR;
		delete process.env.PROTO_WORKTREE_DIR;
		setWorktreesDir(path.join(root, "wt"));
	});

	afterEach(async () => {
		setWorktreesDir(undefined);
		if (savedEnv === undefined) delete process.env.PROTO_WORKTREE_DIR;
		else process.env.PROTO_WORKTREE_DIR = savedEnv;
		vi.restoreAllMocks();
		await fs.rm(root, { recursive: true, force: true });
	});

	function mockDaemon(handle: (op: DaemonOp) => unknown): void {
		vi.spyOn(daemon, "startDaemon").mockResolvedValue({ socket: "/tmp/protofs-test.sock", mount: "/mnt/protofs" });
		vi.spyOn(client, "callSocket").mockImplementation(
			async <T>(_socket: string, op: string, args: object): Promise<T> => {
				const record = args as { checkout?: unknown; name?: unknown };
				return handle({
					op,
					checkout: typeof record.checkout === "string" ? record.checkout : undefined,
					name: typeof record.name === "string" ? record.name : undefined,
				}) as T;
			},
		);
	}

	async function plant(repo: string, agentId: string, checkout: string, pid: number): Promise<string> {
		const baseDir = taskIsolationBaseDir(repo, agentId);
		await fs.mkdir(baseDir, { recursive: true });
		await Bun.write(path.join(baseDir, PROTOFS_CHECKOUT_FILE), JSON.stringify({ command: COMMAND, checkout }));
		await Bun.write(path.join(baseDir, ISOLATION_OWNER_FILE), JSON.stringify({ pid, id: agentId }));
		return baseDir;
	}

	async function retainedDirs(baseDir: string): Promise<string[]> {
		const prefix = `${path.basename(baseDir)}.retained-`;
		const names = await fs.readdir(path.dirname(baseDir));
		return names.filter(name => name.startsWith(prefix)).map(name => path.join(path.dirname(baseDir), name));
	}

	async function deadPid(): Promise<number> {
		const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
		await proc.exited;
		return proc.pid;
	}

	async function readRecord(dir: string): Promise<CheckoutRecord> {
		return (await Bun.file(path.join(dir, PROTOFS_CHECKOUT_FILE)).json()) as CheckoutRecord;
	}

	it("reuses a slot after checkout removal fails without dropping the old record", async () => {
		const removed: string[] = [];
		let failRemoval = true;
		mockDaemon(op => {
			if (op.op === "rm") {
				removed.push(op.checkout ?? "");
				if (failRemoval) throw new client.ProtofsError("busy", "checkout is busy");
				return {};
			}
			if (op.op === "new" && op.name) return { checkout: { name: op.name, path: `/mnt/protofs/${op.name}` } };
			throw new Error(op.op);
		});
		const repo = path.join(root, "reuse");
		await fs.mkdir(repo);
		const agentId = "AuthRefactor";
		const baseDir = await plant(repo, agentId, STALE, await deadPid());
		const owner = await Bun.file(path.join(baseDir, ISOLATION_OWNER_FILE)).text();

		const workspace = await protofsWorkspace(COMMAND)(repo, agentId);

		const current = await readRecord(baseDir);
		expect(current).toEqual({
			command: COMMAND,
			checkout: expect.stringMatching(/^proto-authrefactor-[0-9a-f]{6}$/),
		});
		expect(workspace.dir).toBe(`/mnt/protofs/${current.checkout}`);
		const [sibling] = await retainedDirs(baseDir);
		expect(sibling).toBeString();
		expect(await readRecord(sibling)).toEqual({ command: COMMAND, checkout: STALE });
		expect(await Bun.file(path.join(sibling, ISOLATION_OWNER_FILE)).text()).toBe(owner);

		failRemoval = false;
		const beforeClear = removed.length;
		vi.spyOn(console, "log").mockImplementation(() => {});
		await clearWorktrees({ all: false, dryRun: false, json: true });
		expect(removed.slice(beforeClear)).toEqual([STALE]);
		await expect(fs.stat(sibling)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readRecord(baseDir)).toEqual(current);
	});

	it("replaces a slot once its previous checkout is removed", async () => {
		const removed: string[] = [];
		mockDaemon(op => {
			if (op.op === "rm") {
				removed.push(op.checkout ?? "");
				return {};
			}
			if (op.op === "new" && op.name) return { checkout: { name: op.name, path: `/mnt/protofs/${op.name}` } };
			throw new Error(op.op);
		});
		const repo = path.join(root, "removed");
		await fs.mkdir(repo);
		const baseDir = await plant(repo, "Removed", STALE, await deadPid());

		const workspace = await protofsWorkspace(COMMAND)(repo, "Removed");

		expect(removed).toEqual([STALE]);
		expect(await retainedDirs(baseDir)).toEqual([]);
		const record = await readRecord(baseDir);
		expect(record.command).toBe(COMMAND);
		expect(record.checkout).not.toBe(STALE);
		expect(workspace.dir).toBe(`/mnt/protofs/${record.checkout}`);
	});

	it("keeps the checkout record when it cannot be moved out of the slot", async () => {
		const ops: string[] = [];
		mockDaemon(op => {
			ops.push(op.op);
			if (op.op === "rm") throw new client.ProtofsError("busy", "checkout is busy");
			if (op.op === "new" && op.name) return { checkout: { name: op.name, path: `/mnt/protofs/${op.name}` } };
			throw new Error(op.op);
		});
		vi.spyOn(isolationRunner, "vacateIsolationSlot").mockResolvedValue(undefined);
		const repo = path.join(root, "stuck");
		await fs.mkdir(repo);
		const baseDir = await plant(repo, "Stuck", STALE, await deadPid());
		const owner = await Bun.file(path.join(baseDir, ISOLATION_OWNER_FILE)).text();

		await expect(protofsWorkspace(COMMAND)(repo, "Stuck")).rejects.toThrow(/previous checkout/);

		expect(await readRecord(baseDir)).toEqual({ command: COMMAND, checkout: STALE });
		expect(await Bun.file(path.join(baseDir, ISOLATION_OWNER_FILE)).text()).toBe(owner);
		expect(ops).not.toContain("new");
		expect(await retainedDirs(baseDir)).toEqual([]);
	});

	it("keeps the checkout record when creation fails after the request may have reached the daemon", async () => {
		const removed: string[] = [];
		let requested = "";
		mockDaemon(op => {
			if (op.op === "new") {
				requested = op.name ?? "";
				throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
			}
			if (op.op === "rm") {
				removed.push(op.checkout ?? "");
				throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
			}
			throw new Error(op.op);
		});
		const repo = path.join(root, "lost");
		await fs.mkdir(repo);
		const agentId = "LostReply";

		await expect(protofsWorkspace(COMMAND)(repo, agentId)).rejects.toThrow(/socket hang up/);

		const baseDir = taskIsolationBaseDir(repo, agentId);
		const record = await readRecord(baseDir);
		expect(requested).toMatch(/^proto-lostreply-[0-9a-f]{6}$/);
		expect(record).toEqual({ command: COMMAND, checkout: requested });
		expect(await Bun.file(path.join(baseDir, ISOLATION_OWNER_FILE)).exists()).toBe(true);
		expect(removed).toContain(requested);
		await expect(releaseProtofsCheckout(baseDir)).rejects.toThrow(/connection refused/);
		expect(await readRecord(baseDir)).toEqual(record);
	});

	it("deletes the checkout record when creation fails and removal is confirmed", async () => {
		const removed: string[] = [];
		let requested = "";
		mockDaemon(op => {
			if (op.op === "new") {
				requested = op.name ?? "";
				throw new client.ProtofsError("invalid", "rejected");
			}
			if (op.op === "rm") {
				removed.push(op.checkout ?? "");
				throw new client.ProtofsError("not_found", "missing");
			}
			throw new Error(op.op);
		});
		const repo = path.join(root, "confirmed");
		await fs.mkdir(repo);
		const baseDir = taskIsolationBaseDir(repo, "Confirmed");

		await expect(protofsWorkspace(COMMAND)(repo, "Confirmed")).rejects.toThrow(/protofs: invalid: rejected/);

		expect(requested).toMatch(/^proto-confirmed-[0-9a-f]{6}$/);
		expect(removed).toEqual([requested]);
		await expect(fs.stat(baseDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps the older checkout when creation is refused because its name already exists", async () => {
		const removed: string[] = [];
		let requested = "";
		mockDaemon(op => {
			if (op.op === "new") {
				requested = op.name ?? "";
				throw new client.ProtofsError("exists", "already exists");
			}
			if (op.op === "rm") {
				removed.push(op.checkout ?? "");
				return {};
			}
			throw new Error(op.op);
		});
		const repo = path.join(root, "collision");
		await fs.mkdir(repo);
		const baseDir = taskIsolationBaseDir(repo, "Collision");

		await expect(protofsWorkspace(COMMAND)(repo, "Collision")).rejects.toThrow(/protofs: exists: already exists/);

		expect(requested).toMatch(/^proto-collision-[0-9a-f]{6}$/);
		expect(removed).toEqual([]);
		await expect(fs.stat(baseDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes a new slot when the daemon cannot start", async () => {
		vi.spyOn(daemon, "startDaemon").mockRejectedValue(new Error("cannot run /opt/protofs/protofs"));
		const repo = path.join(root, "no-daemon");
		await fs.mkdir(repo);
		const baseDir = taskIsolationBaseDir(repo, "NoDaemon");

		await expect(protofsWorkspace(COMMAND)(repo, "NoDaemon")).rejects.toThrow(/cannot run \/opt\/protofs\/protofs/);

		await expect(fs.stat(baseDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps the checkout record when closing a workspace cannot remove its checkout", async () => {
		let failRemoval = false;
		const removed: string[] = [];
		mockDaemon(op => {
			if (op.op === "new" && op.name) return { checkout: { name: op.name, path: `/mnt/protofs/${op.name}` } };
			if (op.op === "rm") {
				removed.push(op.checkout ?? "");
				if (failRemoval) throw new client.ProtofsError("busy", "checkout is busy");
				return {};
			}
			throw new Error(op.op);
		});
		const repo = path.join(root, "cleanup");
		await fs.mkdir(repo);
		const agentId = "Cleanup";
		const workspace = await protofsWorkspace(COMMAND)(repo, agentId);
		const baseDir = taskIsolationBaseDir(repo, agentId);
		const record = await readRecord(baseDir);

		failRemoval = true;
		await workspace.cleanup();

		expect(removed).toContain(record.checkout);
		expect(await readRecord(baseDir)).toEqual(record);
		expect(workspace.dir).toBe(`/mnt/protofs/${record.checkout}`);

		failRemoval = false;
		await workspace.cleanup();
		await expect(fs.stat(baseDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps a checkout leased until deferred job cleanup settles", async () => {
		const removed: string[] = [];
		const checkout = path.join(root, "leased-checkout");
		mockDaemon(op => {
			if (op.op === "new" && op.name) return { checkout: { name: op.name, path: checkout } };
			if (op.op === "rm") {
				removed.push(op.checkout ?? "");
				return {};
			}
			throw new Error(op.op);
		});
		const repo = path.join(root, "leased");
		await fs.mkdir(repo);
		const artifacts = path.join(root, "artifacts");
		await fs.mkdir(artifacts);
		const deferred = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		let sessionCwd: string | undefined;
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			sessionCwd = options.worktree;
			options.onCleanupDeferred?.(deferred.promise);
			started.resolve();
			return {
				index: 0,
				id: "Leased",
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
		});
		vi.spyOn(worktree, "captureDeltaPatch").mockResolvedValue({ rootPatch: "", nestedPatches: [] });

		const running = runIsolatedSubprocess({
			baseOptions: {
				cwd: repo,
				agent: { name: "worker", description: "worker", systemPrompt: "", source: "bundled" },
				task: "edit",
				index: 0,
				id: "Leased",
			},
			context: {
				repoRoot: repo,
				baseline: {
					root: {
						repoRoot: repo,
						headCommit: "base",
						staged: "",
						unstaged: "",
						untracked: [],
						untrackedPatch: "",
					},
					nested: [],
				},
			},
			openWorkspace: protofsWorkspace(COMMAND),
			agentId: "Leased",
			mergeMode: "patch",
			artifactsDir: artifacts,
			buildFailureResult: error => ({
				index: 0,
				id: "Leased",
				agent: "worker",
				agentSource: "bundled",
				task: "edit",
				exitCode: 1,
				output: "",
				stderr: String(error),
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
			}),
		});

		await started.promise;
		expect(sessionCwd).toBe(checkout);
		expect(removed).toEqual([]);
		deferred.resolve();
		await running;
		await Bun.sleep(10);
		expect(removed).toHaveLength(1);
	});
});
