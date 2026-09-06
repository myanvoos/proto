import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { getSessionsDir, TempDir } from "@oh-my-pi/pi-utils";
import { createSessionLiveHeartbeat, type SessionLiveHeartbeat } from "../session/session-liveness";
import { FileSessionStorage } from "../session/session-storage";
import { runGcCommand } from "./gc-cli";

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
		const originalWrite = Bun.write;
		vi.spyOn(Bun, "write").mockImplementation(async (destination, input, options?) => {
			const written = await originalWrite(
				destination,
				input instanceof Response ? await input.blob() : input,
				options,
			);
			if (typeof destination === "string" && destination.startsWith(`${root.archive}.`) && !heartbeat) {
				heartbeat = createSessionLiveHeartbeat(target === "root" ? root.file : child.file);
			}
			return written;
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
		const originalWrite = Bun.write;
		vi.spyOn(Bun, "write").mockImplementation(async (destination, input, options?) => {
			const written = await originalWrite(
				destination,
				input instanceof Response ? await input.blob() : input,
				options,
			);
			if (typeof destination === "string" && destination.startsWith(`${root.archive}.`) && !replaced) {
				replaced = true;
				const replacementFile = `${root.file}.replacement`;
				await originalWrite(replacementFile, replacement);
				await fs.utimes(replacementFile, sourceStat.atime, sourceStat.mtime);
				await fs.rename(replacementFile, root.file);
			}
			return written;
		});

		const result = await runGcCommand({ flags: { ...ARCHIVE_FLAGS, agentDir: agentDir.path(), apply: true } });
		expect(replaced).toBe(true);
		expect(await Bun.file(root.file).exists()).toBe(true);
		expect(result.archive).toMatchObject({ archived: 0, skippedActive: 1, errors: [] });
		expect(await Bun.file(root.file).text()).toBe(replacement);
		expect(await fs.readdir(path.dirname(root.archive))).toEqual([]);
	});
});
