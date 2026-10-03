import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import * as utils from "@oh-my-pi/pi-utils";
import {
	ISOLATION_OWNER_FILE,
	RETAINED_BACKEND_FILE,
	writeIsolationOwner,
	writeRetainedBackend,
} from "../task/isolation-ownership";
import { clearWorktrees } from "./worktree-cli";

let root: string;
let previousExitCode: typeof process.exitCode;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-retained-clear-"));
	previousExitCode = process.exitCode ?? 0;
	vi.spyOn(utils, "getWorktreesDir").mockReturnValue(root);
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
	vi.restoreAllMocks();
	process.exitCode = previousExitCode;
	await fs.rm(root, { recursive: true, force: true });
});

async function sandbox(name: string): Promise<string> {
	const base = path.join(root, name);
	await fs.mkdir(path.join(base, "m"), { recursive: true });
	await Bun.write(path.join(base, "m", "work.txt"), "recover me");
	// A recycled PID is deterministic and avoids depending on an unused host PID.
	await Bun.write(
		path.join(base, ISOLATION_OWNER_FILE),
		JSON.stringify({ pid: process.pid, startToken: "not-this-process" }),
	);
	return base;
}

for (const backend of [natives.IsoBackendKind.Overlayfs, natives.IsoBackendKind.Btrfs]) {
	test(`clear tears down retained backend ${backend} before touching its files`, async () => {
		const base = await sandbox("worker.retained-test");
		await writeRetainedBackend(base, backend);
		const stop = vi.spyOn(natives, "isoStop").mockImplementation(async (kind, merged) => {
			expect(kind).toBe(backend);
			expect(merged).toBe(path.join(base, "m"));
			expect(await Bun.file(path.join(merged, "work.txt")).text()).toBe("recover me");
		});
		await clearWorktrees({ all: false, dryRun: false, json: true });
		expect(stop).toHaveBeenCalledTimes(1);
		await expect(fs.stat(base)).rejects.toThrow();
	});
}

test("failed native teardown leaves the retained workspace intact and reports failure", async () => {
	const base = await sandbox("worker.retained-test");
	await writeRetainedBackend(base, natives.IsoBackendKind.Overlayfs);
	vi.spyOn(natives, "isoStop").mockRejectedValue(new Error("unmount busy"));
	await clearWorktrees({ all: true, dryRun: false, json: true });
	expect(await Bun.file(path.join(base, "m", "work.txt")).text()).toBe("recover me");
	expect(process.exitCode).toBe(1);
	expect(console.log).toHaveBeenCalledWith(expect.stringContaining("unmount busy"));
});

for (const metadata of [undefined, "{ truncated", '{"backend":999}', '{"backend":"Overlayfs"}', "{}"]) {
	test(`clear refuses retained workspaces with unsafe metadata ${metadata}`, async () => {
		const base = await sandbox("worker.retained-test");
		if (metadata !== undefined) await Bun.write(path.join(base, RETAINED_BACKEND_FILE), metadata);
		const stop = vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);
		await clearWorktrees({ all: true, dryRun: false, json: true });
		expect(stop).not.toHaveBeenCalled();
		expect(await Bun.file(path.join(base, "m", "work.txt")).text()).toBe("recover me");
		expect(process.exitCode).toBe(1);
	});
}

test("copy workspaces keep plain removal, including legacy sandboxes without sidecars", async () => {
	const copy = await sandbox("copy.retained-test");
	const legacy = await sandbox("legacy");
	await writeRetainedBackend(copy, natives.IsoBackendKind.Rcopy);
	const stop = vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);
	await clearWorktrees({ all: false, dryRun: false, json: true });
	expect(stop).not.toHaveBeenCalled();
	await expect(fs.stat(copy)).rejects.toThrow();
	await expect(fs.stat(legacy)).rejects.toThrow();
});

test("retained ZFS work is not deleted using a stale dataset mountpoint", async () => {
	const base = await sandbox("worker.retained-test");
	await writeRetainedBackend(base, natives.IsoBackendKind.Zfs);
	const stop = vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);
	await clearWorktrees({ all: true, dryRun: false, json: true });
	expect(stop).not.toHaveBeenCalled();
	expect(await Bun.file(path.join(base, "m", "work.txt")).text()).toBe("recover me");
	expect(console.log).toHaveBeenCalledWith(expect.stringContaining("manual dataset teardown"));
});

test("live retained owners and dry runs never unmount or delete their work", async () => {
	const base = await sandbox("worker.retained-test");
	await writeIsolationOwner(base, "worker");
	await writeRetainedBackend(base, natives.IsoBackendKind.Overlayfs);
	const stop = vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);
	await clearWorktrees({ all: false, dryRun: false, json: true });
	await clearWorktrees({ all: true, dryRun: true, json: true });
	expect(stop).not.toHaveBeenCalled();
	expect(await Bun.file(path.join(base, "m", "work.txt")).text()).toBe("recover me");
});
