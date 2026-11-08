import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { getCustomSessionFilesDir, getSessionsDir, Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import {
	createSessionLiveHeartbeat,
	type SessionLiveHeartbeat,
	tryAcquireSessionOwnershipLease,
} from "../session/session-liveness";
import { FileSessionStorage } from "../session/session-storage";
import { serializeTitleSlot } from "../session/session-title-slot";
import { collectGcErrors, type GcResult, runGcCommand } from "./gc-cli";
import * as gcCompress from "./gc-compress";

const ARCHIVE_FLAGS = {
	archive: true,
	blobs: false,
	wal: false,
	json: true,
	coldArchiveAfterDays: 1,
	retainNewestGlobal: 0,
	retainNewestPerCwd: 0,
};

async function writeColdSession(agentDir: string, relativePath: string) {
	const sessionsDir = getSessionsDir(agentDir);
	const file = path.join(sessionsDir, relativePath);
	const timestamp = "2020-01-01T00:00:00.000Z";
	const contents = `${[
		{ type: "session", id: path.basename(file, ".jsonl"), cwd: "/project", timestamp },
		{
			type: "message",
			id: "done",
			timestamp,
			message: { role: "assistant", content: [{ type: "text", text: "Finished" }], stopReason: "stop" },
		},
	]
		.map(entry => JSON.stringify(entry))
		.join("\n")}\n`;
	await Bun.write(file, contents);
	await fs.utimes(file, new Date(timestamp), new Date(timestamp));
	return {
		file,
		contents,
		artifacts: file.slice(0, -".jsonl".length),
		archive: path.join(path.dirname(sessionsDir), "archive", "sessions", `${relativePath}.gz`),
	};
}

beforeEach(() => {
	vi.spyOn(process.stdout, "write").mockReturnValue(true);
});

afterEach(() => {
	vi.restoreAllMocks();
});

test.each([false, true])("GC reclaims orphan rewrite temps without deleting fresh writes (custom=%s)", async custom => {
	await using agentDir = await TempDir.create();
	const target = custom
		? path.join(agentDir.path(), "outside", "checkpoint.log")
		: path.join(getSessionsDir(agentDir.path()), "project", "session.jsonl");
	const oldTemp = path.join(path.dirname(target), `.${path.basename(target)}.${Snowflake.next()}.tmp`);
	const freshTemp = path.join(path.dirname(target), `.${path.basename(target)}.${Snowflake.next()}.tmp`);
	await Bun.write(oldTemp, "abandoned rewrite");
	await Bun.write(freshTemp, "active rewrite");
	await fs.utimes(oldTemp, new Date(0), new Date(0));
	if (custom) await Bun.write(path.join(getCustomSessionFilesDir(agentDir.path()), "first-save"), target);
	const preview = await runGcCommand({ flags: { ...ARCHIVE_FLAGS, agentDir: agentDir.path(), apply: false } });
	expect(preview.archive).toMatchObject({ wouldDeleteTemps: 1, deletedTemps: 0 });
	expect(await Bun.file(oldTemp).text()).toBe("abandoned rewrite");
	const applied = await runGcCommand({ flags: { ...ARCHIVE_FLAGS, agentDir: agentDir.path(), apply: true } });
	expect(applied.archive).toMatchObject({ wouldDeleteTemps: 1, deletedTemps: 1 });
	expect(await Bun.file(oldTemp).exists()).toBe(false);
	expect(await Bun.file(freshTemp).text()).toBe("active rewrite");
});

describe("GC archive active-session safety", () => {
	test("archives a closed cold transcript and its nested artifacts without losing their contents", async () => {
		await using agentDir = await TempDir.create();
		const root = await writeColdSession(agentDir.path(), "project/root.jsonl");
		const child = await writeColdSession(agentDir.path(), "project/root/agents/child.jsonl");

		const preview = await runGcCommand({ flags: { ...ARCHIVE_FLAGS, agentDir: agentDir.path(), apply: false } });
		expect(preview.archive).toMatchObject({ wouldArchive: 1, archived: 0, errors: [] });
		expect(await Bun.file(root.file).text()).toBe(root.contents);
		expect(await Bun.file(root.archive).exists()).toBe(false);

		const applied = await runGcCommand({ flags: { ...ARCHIVE_FLAGS, agentDir: agentDir.path(), apply: true } });
		expect(applied.archive).toMatchObject({ archived: 1, skippedActive: 0, errors: [] });
		expect(await Bun.file(root.file).exists()).toBe(false);
		expect(gunzipSync(await Bun.file(root.archive).bytes()).toString()).toBe(root.contents);
		expect(await Bun.file(`${root.archive.slice(0, -".jsonl.gz".length)}/agents/child.jsonl`).text()).toBe(
			child.contents,
		);
	});

	test.each(["idle", "streaming"])("keeps an open %s root with a cold completed transcript", async mode => {
		await using agentDir = await TempDir.create();
		const root = await writeColdSession(agentDir.path(), "project/root.jsonl");
		const heartbeat = createSessionLiveHeartbeat(root.file);
		try {
			heartbeat?.setStreaming(mode === "streaming");
			for (const apply of [true, false]) {
				const result = await runGcCommand({ flags: { ...ARCHIVE_FLAGS, agentDir: agentDir.path(), apply } });
				expect(result.archive).toMatchObject({ wouldArchive: 0, archived: 0, skippedActive: 1, errors: [] });
				expect(await Bun.file(root.file).text()).toBe(root.contents);
				expect(await Bun.file(root.archive).exists()).toBe(false);
			}
		} finally {
			heartbeat?.dispose();
		}
	});

	test.each(["idle", "streaming"])("keeps an ancestor while a cold nested session is open and %s", async mode => {
		await using agentDir = await TempDir.create();
		const root = await writeColdSession(agentDir.path(), "project/root.jsonl");
		const child = await writeColdSession(agentDir.path(), "project/root/agents/child.jsonl");
		const heartbeat = createSessionLiveHeartbeat(child.file);
		try {
			heartbeat?.setStreaming(mode === "streaming");
			for (const apply of [true, false]) {
				const result = await runGcCommand({ flags: { ...ARCHIVE_FLAGS, agentDir: agentDir.path(), apply } });
				expect(result.archive).toMatchObject({ wouldArchive: 0, archived: 0, skippedActive: 1, errors: [] });
				expect(await Bun.file(root.file).text()).toBe(root.contents);
				expect(await Bun.file(child.file).text()).toBe(child.contents);
				expect(await Bun.file(root.archive).exists()).toBe(false);
			}
		} finally {
			heartbeat?.dispose();
		}
	});

	test("keeps a root opened after its listing snapshot was read", async () => {
		await using agentDir = await TempDir.create();
		const root = await writeColdSession(agentDir.path(), "project/root.jsonl");
		const child = await writeColdSession(agentDir.path(), "project/root/agents/child.jsonl");
		let heartbeat: SessionLiveHeartbeat | undefined;
		const originalRead = FileSessionStorage.prototype.readTextSlices;
		vi.spyOn(FileSessionStorage.prototype, "readTextSlices").mockImplementation(async function (
			this: FileSessionStorage,
			file,
			headBytes,
			tailBytes,
		) {
			const slices = await originalRead.call(this, file, headBytes, tailBytes);
			if (file === child.file && !heartbeat) heartbeat = createSessionLiveHeartbeat(root.file);
			return slices;
		});
		try {
			const result = await runGcCommand({ flags: { ...ARCHIVE_FLAGS, agentDir: agentDir.path(), apply: true } });
			expect(heartbeat).toBeDefined();
			expect(result.archive).toMatchObject({ archived: 0, skippedActive: 1, errors: [] });
			expect(await Bun.file(root.file).text()).toBe(root.contents);
			expect(await Bun.file(root.archive).exists()).toBe(false);
		} finally {
			heartbeat?.dispose();
		}
	});

	test("rechecks nested heartbeats after an ancestor was selected as an archive candidate", async () => {
		await using agentDir = await TempDir.create();
		const root = await writeColdSession(agentDir.path(), "project/root.jsonl");
		const child = await writeColdSession(agentDir.path(), "project/root/agents/child.jsonl");
		const later = await writeColdSession(agentDir.path(), "project/later.jsonl");
		const laterChild = await writeColdSession(agentDir.path(), "project/later/agents/later-child.jsonl");
		await fs.utimes(later.file, new Date("2019-01-01"), new Date("2019-01-01"));
		let heartbeat: SessionLiveHeartbeat | undefined;
		const originalRead = FileSessionStorage.prototype.readTextSlices;
		vi.spyOn(FileSessionStorage.prototype, "readTextSlices").mockImplementation(async function (
			this: FileSessionStorage,
			file,
			headBytes,
			tailBytes,
		) {
			const slices = await originalRead.call(this, file, headBytes, tailBytes);
			if (file === laterChild.file && !heartbeat) heartbeat = createSessionLiveHeartbeat(child.file);
			return slices;
		});
		try {
			const result = await runGcCommand({ flags: { ...ARCHIVE_FLAGS, agentDir: agentDir.path(), apply: true } });
			expect(heartbeat).toBeDefined();
			expect(result.archive).toMatchObject({ archived: 1, skippedActive: 1, errors: [] });
			expect(await Bun.file(root.file).text()).toBe(root.contents);
			expect(await Bun.file(child.file).text()).toBe(child.contents);
			expect(await Bun.file(root.archive).exists()).toBe(false);
			expect(await Bun.file(later.archive).exists()).toBe(true);
		} finally {
			heartbeat?.dispose();
		}
	});

	test("keeps a transcript modified after its listing snapshot was read", async () => {
		await using agentDir = await TempDir.create();
		const root = await writeColdSession(agentDir.path(), "project/root.jsonl");
		const child = await writeColdSession(agentDir.path(), "project/root/agents/child.jsonl");
		const appended = `${JSON.stringify({ type: "message", message: { role: "user", content: "Continue" } })}\n`;
		let changed = false;
		const originalRead = FileSessionStorage.prototype.readTextSlices;
		vi.spyOn(FileSessionStorage.prototype, "readTextSlices").mockImplementation(async function (
			this: FileSessionStorage,
			file,
			headBytes,
			tailBytes,
		) {
			const slices = await originalRead.call(this, file, headBytes, tailBytes);
			if (file === child.file && !changed) {
				changed = true;
				await fs.appendFile(root.file, appended);
			}
			return slices;
		});

		const result = await runGcCommand({ flags: { ...ARCHIVE_FLAGS, agentDir: agentDir.path(), apply: true } });
		expect(changed).toBe(true);
		expect(result.archive).toMatchObject({ archived: 0, skippedActive: 1, errors: [] });
		expect(await Bun.file(root.file).text()).toBe(root.contents + appended);
		expect(await Bun.file(root.archive).exists()).toBe(false);
	});

	test.each(["root", "nested"])("keeps a %s session opened while its archive is being staged", async target => {
		await using agentDir = await TempDir.create();
		const root = await writeColdSession(agentDir.path(), "project/root.jsonl");
		const child = await writeColdSession(agentDir.path(), "project/root/agents/child.jsonl");
		let heartbeat: SessionLiveHeartbeat | undefined;
		const originalOpen = fs.open;
		vi.spyOn(fs, "open").mockImplementation(async (file, ...rest) => {
			const handle = await originalOpen(file, ...rest);
			if (typeof file === "string" && file.startsWith(`${root.archive}.`) && !heartbeat) {
				heartbeat = createSessionLiveHeartbeat(target === "root" ? root.file : child.file);
			}
			return handle;
		});
		try {
			const result = await runGcCommand({ flags: { ...ARCHIVE_FLAGS, agentDir: agentDir.path(), apply: true } });
			expect(heartbeat).toBeDefined();
			expect(await Bun.file(root.file).exists()).toBe(true);
			expect(result.archive).toMatchObject({ archived: 0, skippedActive: 1, errors: [] });
			expect(await Bun.file(root.file).text()).toBe(root.contents);
			expect(await Bun.file(child.file).text()).toBe(child.contents);
			expect(await fs.readdir(path.dirname(root.archive))).toEqual([]);
		} finally {
			heartbeat?.dispose();
		}
	});

	test("does not unlink a replacement transcript with matching size and modification time", async () => {
		await using agentDir = await TempDir.create();
		const root = await writeColdSession(agentDir.path(), "project/root.jsonl");
		const sourceStat = await fs.stat(root.file);
		const replacement = root.contents.replace("Finished", "Replaced");
		let replaced = false;
		const originalOpen = fs.open;
		vi.spyOn(fs, "open").mockImplementation(async (file, ...rest) => {
			const handle = await originalOpen(file, ...rest);
			if (typeof file === "string" && file.startsWith(`${root.archive}.`) && !replaced) {
				replaced = true;
				const replacementFile = `${root.file}.replacement`;
				await Bun.write(replacementFile, replacement);
				await fs.utimes(replacementFile, sourceStat.atime, sourceStat.mtime);
				await fs.rename(replacementFile, root.file);
			}
			return handle;
		});

		const result = await runGcCommand({ flags: { ...ARCHIVE_FLAGS, agentDir: agentDir.path(), apply: true } });
		expect(replaced).toBe(true);
		expect(await Bun.file(root.file).exists()).toBe(true);
		expect(result.archive).toMatchObject({ archived: 0, skippedActive: 1, errors: [] });
		expect(await Bun.file(root.file).text()).toBe(replacement);
		expect(await fs.readdir(path.dirname(root.archive))).toEqual([]);
	});
});

// Test roots live under the temp dir, so its filesystem decides whether the real round-trip runs.
let realCompression = false;
try {
	const hostMethod = await gcCompress.compressMethod(os.tmpdir());
	realCompression = hostMethod !== undefined && (await gcCompress.compressionWorks(os.tmpdir()));
} catch {
	realCompression = false;
}

describe("runGcCommand session compression", () => {
	const filler =
		`${JSON.stringify({ type: "message", message: { role: "toolResult", content: "line ".repeat(40) } })}\n`.repeat(
			400,
		);

	/** Ages `file` to a timestamp with sub-millisecond digits, which a `Date` cannot carry. */
	async function agePathSubMs(file: string, ageDays: number): Promise<void> {
		const seconds = Math.floor((Date.now() - ageDays * 86_400_000) / 1000) + 0.123456;
		await fs.utimes(file, seconds, seconds);
	}

	/** An idle session with a compressible transcript and one artifact; filler precedes its final turn. */
	async function writeIdleSession(agentDir: string, id: string, ageDays = 30) {
		const file = path.join(getSessionsDir(agentDir), "project", `${id}.jsonl`);
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id,
			cwd: "/project",
			timestamp: "2020-01-01T00:00:00.000Z",
		});
		await Bun.write(
			file,
			`${serializeTitleSlot({ title: "idle session", source: "auto", updatedAt: "2020-01-01T00:00:00.000Z" })}${header}\n${filler}`,
		);
		const artifact = path.join(file.slice(0, -".jsonl".length), "1.bash.log");
		await Bun.write(artifact, filler);
		await agePathSubMs(artifact, ageDays);
		await agePathSubMs(file, ageDays);
		return { file, artifact };
	}

	async function snapshot(file: string) {
		const stat = await fs.stat(file);
		return {
			bytes: await Bun.file(file).text(),
			mtimeNs: (await fs.stat(file, { bigint: true })).mtimeNs,
			allocated: stat.blocks * 512,
			size: stat.size,
		};
	}

	async function writeConfig(agentDir: string, body: string): Promise<void> {
		await Bun.write(path.join(agentDir, "config.yml"), body);
	}

	/**
	 * Keeps the phase's selection and bookkeeping under test without running
	 * `ditto`, which is unavailable on non-APFS hosts and a no-op on macOS 27.
	 */
	function stubCompressPhase(): void {
		vi.spyOn(gcCompress, "compressMethod").mockResolvedValue("apfs");
		vi.spyOn(gcCompress, "compressionWorks").mockResolvedValue(true);
		vi.spyOn(gcCompress, "compressFilesInPlace").mockImplementation(async candidates => ({
			compressed: candidates.length,
			allocatedAfter: 0,
			errors: [],
		}));
	}

	test("reports the phase unsupported without touching sessions", async () => {
		await using agentDir = await TempDir.create();
		const { file } = await writeIdleSession(agentDir.path(), Bun.randomUUIDv7());
		const before = await snapshot(file);
		vi.spyOn(gcCompress, "compressMethod").mockResolvedValue(undefined);

		const result = await runGcCommand({ flags: { agentDir: agentDir.path(), compress: true, apply: true } });

		expect(result.compress).toMatchObject({ supported: false, scanned: 0, compressed: 0, errors: [] });
		expect(await snapshot(file)).toEqual(before);
	});

	test.skipIf(!realCompression)(
		"--apply stores an idle session compressed with identical bytes and mtimes",
		async () => {
			await using agentDir = await TempDir.create();
			const { file, artifact } = await writeIdleSession(agentDir.path(), Bun.randomUUIDv7());
			const before = await Promise.all([snapshot(file), snapshot(artifact)]);

			const result = await runGcCommand({ flags: { agentDir: agentDir.path(), compress: true, apply: true } });

			expect(result.compress).toMatchObject({
				supported: true,
				method: "apfs",
				sessions: 1,
				wouldCompress: 2,
				compressed: 2,
				errors: [],
			});
			expect(result.compress?.allocatedAfter).toBeLessThan(result.compress?.allocatedBefore ?? 0);
			for (const [index, target] of [file, artifact].entries()) {
				const after = await snapshot(target);
				expect(after.bytes).toBe(before[index]!.bytes);
				expect(after.mtimeNs).toBe(before[index]!.mtimeNs);
				expect(after.allocated).toBeLessThan(after.size);
			}
			expect((await fs.readdir(path.dirname(file))).filter(name => name.startsWith(".omp-gc-compress-"))).toEqual(
				[],
			);

			const rerun = await runGcCommand({ flags: { agentDir: agentDir.path(), compress: true, apply: true } });
			expect(rerun.compress).toMatchObject({ wouldCompress: 0, compressed: 0 });
		},
	);

	test("a dry run reports candidates without rewriting them", async () => {
		await using agentDir = await TempDir.create();
		stubCompressPhase();
		const { file } = await writeIdleSession(agentDir.path(), Bun.randomUUIDv7());
		const before = await snapshot(file);

		const result = await runGcCommand({ flags: { agentDir: agentDir.path(), compress: true } });

		expect(result.compress).toMatchObject({ sessions: 1, wouldCompress: 2, compressed: 0 });
		expect(await snapshot(file)).toEqual(before);
	});

	test("an unqualified gc run leaves compression off", async () => {
		await using agentDir = await TempDir.create();
		const { file } = await writeIdleSession(agentDir.path(), Bun.randomUUIDv7());
		const before = await snapshot(file);

		const result = await runGcCommand({ flags: { agentDir: agentDir.path(), apply: true } });

		expect(result.compress).toBeUndefined();
		expect(await snapshot(file)).toEqual(before);
	});

	test("a session whose artifact tree cannot be read does not stop the run", async () => {
		await using agentDir = await TempDir.create();
		stubCompressPhase();
		const broken = await writeIdleSession(agentDir.path(), Bun.randomUUIDv7());
		// A file where the artifact directory belongs makes the tree scan fail with ENOTDIR.
		await fs.rm(path.dirname(broken.artifact), { recursive: true });
		await Bun.write(path.dirname(broken.artifact), "not a directory");
		await writeIdleSession(agentDir.path(), Bun.randomUUIDv7());

		const result = await runGcCommand({
			flags: { agentDir: agentDir.path(), compress: true, wal: true, apply: true },
		});

		expect(result.compress).toMatchObject({ scanned: 2, sessions: 1, compressed: 2 });
		expect(result.compress?.errors).toEqual([expect.stringContaining(broken.file)]);
		expect(result.wal).toBeDefined();
	});

	test("--apply removes only the scratch dirs a killed run left behind", async () => {
		await using agentDir = await TempDir.create();
		stubCompressPhase();
		const { file, artifact } = await writeIdleSession(agentDir.path(), Bun.randomUUIDv7());
		const inSessions = path.join(path.dirname(file), ".omp-gc-compress-a1b2c3");
		const inArchive = path.join(agentDir.path(), "archive", "sessions", "project", "x", ".omp-gc-compress-d4e5f6");
		for (const dir of [inSessions, inArchive]) {
			await fs.mkdir(dir, { recursive: true });
			await Bun.write(path.join(dir, ".omp-gc-compress-owner"), "");
			await Bun.write(path.join(dir, "copy.jsonl"), filler);
		}
		// An artifact that merely shares the name carries no owner marker.
		const userArtifact = path.join(path.dirname(artifact), ".omp-gc-compress-notes", "keep.txt");
		await Bun.write(userArtifact, "keep");

		const dryRun = await runGcCommand({ flags: { agentDir: agentDir.path(), compress: true } });
		expect(dryRun.compress?.leftoverScratchDirs).toBe(2);
		expect(await Bun.file(path.join(inSessions, "copy.jsonl")).exists()).toBe(true);

		const applied = await runGcCommand({ flags: { agentDir: agentDir.path(), compress: true, apply: true } });
		expect(applied.compress).toMatchObject({ leftoverScratchDirs: 2, compressed: 2, errors: [] });
		for (const dir of [inSessions, inArchive]) expect(await fs.exists(dir)).toBe(false);
		expect(await Bun.file(userArtifact).text()).toBe("keep");
	});

	test.skipIf(!realCompression)("a failed batch still counts its files as allocated afterwards", async () => {
		await using agentDir = await TempDir.create();
		const { file, artifact } = await writeIdleSession(agentDir.path(), Bun.randomUUIDv7());
		const artifactBefore = await snapshot(artifact);
		// A read-only artifact dir cannot hold the scratch copy, so only the transcript compresses.
		await fs.chmod(path.dirname(artifact), 0o555);
		let result: GcResult;
		try {
			result = await runGcCommand({ flags: { agentDir: agentDir.path(), compress: true, apply: true } });
		} finally {
			await fs.chmod(path.dirname(artifact), 0o755);
		}

		expect(result.compress).toMatchObject({ wouldCompress: 2, compressed: 1 });
		expect(result.compress?.errors).toHaveLength(1);
		const transcriptAfter = (await fs.stat(file)).blocks * 512;
		expect(result.compress?.allocatedAfter).toBe(transcriptAfter + artifactBefore.allocated);
		expect(await snapshot(artifact)).toEqual(artifactBefore);
	});

	test("leaves recent and owned sessions uncompressed", async () => {
		await using agentDir = await TempDir.create();
		stubCompressPhase();
		const recent = await writeIdleSession(agentDir.path(), Bun.randomUUIDv7(), 1);
		const held = await writeIdleSession(agentDir.path(), Bun.randomUUIDv7());
		const lease = tryAcquireSessionOwnershipLease(held.file);
		if (!lease) throw new Error("Expected to take the session ownership lease");
		const targets = [recent.file, recent.artifact, held.file, held.artifact];
		const before = await Promise.all(targets.map(snapshot));
		let result: GcResult;
		try {
			result = await runGcCommand({ flags: { agentDir: agentDir.path(), compress: true, apply: true } });
		} finally {
			lease.release();
		}

		expect(result.compress).toMatchObject({ scanned: 2, skippedLive: 1, wouldCompress: 0, compressed: 0 });
		expect(await Promise.all(targets.map(snapshot))).toEqual(before);
	});

	test("leaves a session uncompressed while a nested transcript is owned", async () => {
		await using agentDir = await TempDir.create();
		stubCompressPhase();
		const parent = await writeIdleSession(agentDir.path(), Bun.randomUUIDv7());
		// `--session` opens any path, so the transcript is found by its header, not its name.
		const nested = path.join(path.dirname(parent.artifact), "0-subagent.log");
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: Bun.randomUUIDv7(),
			timestamp: "2026-01-01T00:00:00.000Z",
		});
		// Leading JSON whitespace still parses as a header, so it must not hide the transcript.
		await Bun.write(nested, `\n  ${header}\n${filler}`);
		await agePathSubMs(nested, 30);
		const lease = tryAcquireSessionOwnershipLease(nested);
		if (!lease) throw new Error("Expected to take the nested session ownership lease");
		const targets = [parent.file, parent.artifact, nested];
		const before = await Promise.all(targets.map(snapshot));
		let result: GcResult;
		try {
			result = await runGcCommand({ flags: { agentDir: agentDir.path(), compress: true, apply: true } });
		} finally {
			lease.release();
		}

		expect(result.compress).toMatchObject({ skippedLive: 1, wouldCompress: 0, compressed: 0 });
		expect(await Promise.all(targets.map(snapshot))).toEqual(before);
	});

	test("compresses an idle session whose last turn was interrupted", async () => {
		await using agentDir = await TempDir.create();
		stubCompressPhase();
		const { file } = await writeIdleSession(agentDir.path(), Bun.randomUUIDv7());
		const bytes = await fs.readFile(file);

		const result = await runGcCommand({ flags: { agentDir: agentDir.path(), compress: true, apply: true } });

		expect(result.compress).toMatchObject({ skippedLive: 0, compressed: 2 });
		expect(await fs.readFile(file)).toEqual(bytes);
	});

	test("compresses a session whose artifact tree holds a copy of its transcript", async () => {
		await using agentDir = await TempDir.create();
		stubCompressPhase();
		const { file, artifact } = await writeIdleSession(agentDir.path(), Bun.randomUUIDv7());
		// A plain copy keeps the parent's session id; leasing that id twice must not read as live.
		const copy = path.join(path.dirname(artifact), "backup.jsonl");
		await fs.copyFile(file, copy);
		await agePathSubMs(copy, 30);

		const result = await runGcCommand({ flags: { agentDir: agentDir.path(), compress: true, apply: true } });

		expect(result.compress).toMatchObject({ skippedLive: 0, compressed: 3 });
	});

	test("a dry run reads past a large JSON artifact with no session header", async () => {
		await using agentDir = await TempDir.create();
		stubCompressPhase();
		const { artifact } = await writeIdleSession(agentDir.path(), Bun.randomUUIDv7());
		// Pretty-printed JSON opens like a record but completes none within the header
		// read cap, and the file continues well past it.
		const output = path.join(path.dirname(artifact), "2.mcp_search.log");
		await Bun.write(output, `{\n  "results": [\n${'    "row",\n'.repeat(160_000)}    "end"\n  ]\n}\n`);
		await agePathSubMs(output, 30);

		const result = await runGcCommand({ flags: { agentDir: agentDir.path(), compress: true } });

		expect(result.compress).toMatchObject({ skippedLive: 0, sessions: 1, wouldCompress: 3, errors: [] });
	});

	test("--compress-after-days overrides gc.compressAfterDays", async () => {
		await using agentDir = await TempDir.create();
		stubCompressPhase();
		await writeConfig(agentDir.path(), ["gc:", "  compressAfterDays: 60", ""].join("\n"));
		await writeIdleSession(agentDir.path(), Bun.randomUUIDv7());

		const configured = await runGcCommand({ flags: { agentDir: agentDir.path(), compress: true } });
		const overridden = await runGcCommand({
			flags: { agentDir: agentDir.path(), compress: true, compressAfterDays: 7 },
		});

		expect(configured.compress?.wouldCompress).toBe(0);
		expect(overridden.compress?.wouldCompress).toBe(2);
	});

	test("--apply on a volume whose compression shrinks nothing leaves sessions alone", async () => {
		await using agentDir = await TempDir.create();
		const { file } = await writeIdleSession(agentDir.path(), Bun.randomUUIDv7());
		const before = await snapshot(file);
		vi.spyOn(gcCompress, "compressMethod").mockResolvedValue("apfs");
		vi.spyOn(gcCompress, "compressionWorks").mockResolvedValue(false);

		const result = await runGcCommand({ flags: { agentDir: agentDir.path(), compress: true, apply: true } });

		expect(result.compress).toMatchObject({ supported: true, scanned: 0, wouldCompress: 0, compressed: 0 });
		expect(result.compress?.probeFailure).toContain("stored a compressible probe file uncompressed");
		expect(await snapshot(file)).toEqual(before);
	});

	test("--apply reports a probe that throws as a gc error and leaves sessions alone", async () => {
		await using agentDir = await TempDir.create();
		const { file } = await writeIdleSession(agentDir.path(), Bun.randomUUIDv7());
		const before = await snapshot(file);
		vi.spyOn(gcCompress, "compressMethod").mockResolvedValue("apfs");
		vi.spyOn(gcCompress, "compressionWorks").mockRejectedValue(new Error("EACCES: sessions dir"));

		const result = await runGcCommand({ flags: { agentDir: agentDir.path(), compress: true, apply: true } });

		expect(result.compress).toMatchObject({ scanned: 0, compressed: 0 });
		expect(result.compress?.probeFailure).toBeUndefined();
		expect(collectGcErrors(result)).toEqual(["compress: compression probe: EACCES: sessions dir"]);
		expect(await snapshot(file)).toEqual(before);
	});
});
