import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listAllSessions } from "./session-listing";
import { FileSessionStorage } from "./session-storage";

const directories: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proto-session-symlink-"));
	directories.push(directory);
	return directory;
}

async function transcript(file: string, id: string): Promise<void> {
	await Bun.write(
		file,
		`${JSON.stringify({ type: "session", id, cwd: path.dirname(file), timestamp: "2026-01-01T00:00:00.000Z" })}\n`,
	);
}

test("rewriting a staged transcript follows its symlink without replacing the link or stranding new entries", async () => {
	const directory = await temporaryDirectory();
	const original = path.join(directory, "original.jsonl");
	const staged = path.join(directory, "staged.jsonl");
	await Bun.write(original, "old\n");
	await fs.symlink(original, staged);
	const storage = new FileSessionStorage();
	expect(storage.listFilesSync(directory, "*.jsonl")).toContain(staged);
	storage.writeLinesSync(staged, ["sync\n", "界\n"], { expectedSize: 4 });
	expect(await Bun.file(original).text()).toBe("sync\n界\n");
	await storage.writeLinesAtomic(staged, ["async\n", "next\n"], {
		expectedSize: Buffer.byteLength("sync\n界\n"),
		durable: true,
	});
	expect(await Bun.file(original).text()).toBe("async\nnext\n");
	expect((await fs.lstat(staged)).isSymbolicLink()).toBe(true);
});

test("global session inventory excludes directory escapes and deduplicates aliases of the same transcript", async () => {
	const directory = await temporaryDirectory();
	const sessions = path.join(directory, "sessions");
	const realBucket = path.join(sessions, "real");
	await transcript(path.join(realBucket, "real_session.jsonl"), "real");
	await transcript(path.join(directory, "outside", "outside_session.jsonl"), "outside");
	await fs.symlink(realBucket, path.join(sessions, "alias"));
	await fs.symlink(path.join(directory, "outside"), path.join(sessions, "escape"));
	await fs.symlink(path.join(realBucket, "real_session.jsonl"), path.join(realBucket, "alias_session.jsonl"));
	expect((await listAllSessions(new FileSessionStorage(), sessions)).map(session => session.id)).toEqual(["real"]);
});

test("a bucket that fails after yielding a match contributes no partial rows and does not hide healthy buckets", async () => {
	const sessions = await temporaryDirectory();
	await transcript(path.join(sessions, "healthy", "kept_session.jsonl"), "kept");
	await transcript(path.join(sessions, "failed", "leaked_session.jsonl"), "leaked");
	const scan = Bun.Glob.prototype.scan;
	spyOn(Bun.Glob.prototype, "scan").mockImplementation(function (this: Bun.Glob, options) {
		if (typeof options === "object" && options.cwd === path.join(sessions, "failed")) {
			return (async function* () {
				yield "leaked_session.jsonl";
				throw Object.assign(new Error("bucket disappeared"), { code: "EACCES" });
			})();
		}
		return scan.call(this, options);
	});
	expect((await listAllSessions(new FileSessionStorage(), sessions)).map(session => session.id)).toEqual(["kept"]);
});
