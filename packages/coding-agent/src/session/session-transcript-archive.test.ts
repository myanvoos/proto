import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { loadSessionFile, visitEntriesFromFile } from "./session-loader";
import { SessionManager } from "./session-manager";
import { FileSessionStorage, type WriteTextAtomicOptions } from "./session-storage";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function makeCompactedSession() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-transcript-archive-"));
	tempDirs.push(dir);
	const manager = SessionManager.create(dir, dir);
	const first = manager.appendMessage({ role: "user", content: "old transcript ".repeat(200), timestamp: 1 });
	manager.appendMessage({ role: "user", content: "old response", timestamp: 2 });
	const kept = manager.appendMessage({ role: "user", content: "kept context", timestamp: 3 });
	manager.appendMessage({ role: "user", content: "kept response", timestamp: 4 });
	manager.appendCompaction("summary", undefined, kept, 1000);
	await manager.ensureOnDisk();
	await manager.flush();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	return { dir, manager, sessionFile, first, kept };
}

test("compaction archive hydrates entries identically to the unpruned manager", async () => {
	const { dir, manager, sessionFile, kept } = await makeCompactedSession();
	try {
		const before = manager.getEntries();
		await manager.archiveCompactedHistory(kept);
		const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
			initialCwd: dir,
			suppressBreadcrumb: true,
		});
		try {
			expect(reopened.getEntries()).toEqual(before);
			const visitedIds: string[] = [];
			await visitEntriesFromFile(sessionFile, entry => {
				if (entry.type !== "session") visitedIds.push(entry.id);
			});
			expect(visitedIds).toEqual(before.map(entry => entry.id));
		} finally {
			await reopened.close();
		}
	} finally {
		await manager.close();
	}
});

test("compaction archive shrinks active JSONL and ordinary rewrites do not re-expand it", async () => {
	const { manager, sessionFile, kept } = await makeCompactedSession();
	try {
		const beforeText = fs.readFileSync(sessionFile, "utf8");
		const originalMessageRows = beforeText.split("\n").filter(line => {
			try {
				return JSON.parse(line).type === "message";
			} catch {
				return false;
			}
		});
		const beforeBytes = Buffer.byteLength(beforeText, "utf8");
		await manager.archiveCompactedHistory(kept);
		if (!fs.existsSync(`${sessionFile}.archive.jsonl.gz`)) throw new Error("Expected archive sidecar to be written");
		const afterBytes = fs.statSync(sessionFile).size;
		expect(afterBytes).toBeLessThan(beforeBytes);
		const archived = JSON.parse(
			gunzipSync(Buffer.from(fs.readFileSync(`${sessionFile}.archive.jsonl.gz`, "utf8"), "base64")).toString("utf8"),
		) as {
			records: Array<{ line: string }>;
		};
		expect(archived.records.map(record => record.line)).toEqual(originalMessageRows.slice(0, 2));
		manager.appendCustomEntry("after-archive", { ok: true });
		await manager.rewriteEntries();
		expect(fs.statSync(sessionFile).size).toBeLessThan(beforeBytes);
		expect(manager.getEntries().some(entry => entry.id === kept)).toBe(true);
	} finally {
		await manager.close();
	}
});

test("rewind and branch retain access to archived entries", async () => {
	const { dir, manager, sessionFile, first, kept } = await makeCompactedSession();
	try {
		await manager.archiveCompactedHistory(kept);
		manager.branch(first);
		expect(manager.getLeafId()).toBe(first);
		expect(
			manager.getTree().flatMap(function flatten(node): string[] {
				return [node.entry.id, ...node.children.flatMap(flatten)];
			}),
		).toContain(first);
		const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
			initialCwd: dir,
			suppressBreadcrumb: true,
		});
		try {
			reopened.branch(first);
			expect(reopened.getLeafId()).toBe(first);
		} finally {
			await reopened.close();
		}
	} finally {
		await manager.close();
	}
});

test("archive is complete before a failed active-file publish and recovers the old transcript", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-transcript-archive-crash-"));
	tempDirs.push(dir);
	class CrashOnPublishStorage extends FileSessionStorage {
		sessionFile = "";
		armed = false;
		override async writeTextAtomic(file: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
			if (this.armed && file === this.sessionFile) {
				this.armed = false;
				throw new Error("simulated crash before active transcript publish");
			}
			await super.writeTextAtomic(file, content, options);
		}
	}
	const storage = new CrashOnPublishStorage();
	const manager = SessionManager.create(dir, dir, storage);
	const oldId = manager.appendMessage({ role: "user", content: "durable old message", timestamp: 1 });
	manager.appendMessage({ role: "user", content: "old answer", timestamp: 2 });
	const keptId = manager.appendMessage({ role: "user", content: "kept", timestamp: 3 });
	manager.appendCompaction("summary", undefined, keptId, 10);
	await manager.ensureOnDisk();
	await manager.flush();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	storage.sessionFile = sessionFile;
	storage.armed = true;
	try {
		let publishError: unknown;
		try {
			await manager.archiveCompactedHistory(keptId);
		} catch (error) {
			publishError = error;
		}
		expect(publishError).toBeInstanceOf(Error);
		expect((publishError as Error).message).toContain("simulated crash");
		const archivePath = `${sessionFile}.archive.jsonl.gz`;
		expect(fs.existsSync(archivePath)).toBe(true);
		const archive = JSON.parse(
			gunzipSync(Buffer.from(fs.readFileSync(archivePath, "utf8"), "base64")).toString("utf8"),
		) as {
			records: Array<{ id: string; line: string }>;
		};
		expect(archive.records.map(record => record.id)).toEqual([oldId, manager.getEntries()[1]!.id]);
		const activeText = fs.readFileSync(sessionFile, "utf8");
		const headerId = JSON.parse(activeText.split("\n")[1]!).id;
		const archiveHeader = JSON.parse(
			gunzipSync(Buffer.from(fs.readFileSync(archivePath, "utf8"), "base64")).toString("utf8"),
		) as { sessionId: string };
		expect(archiveHeader.sessionId).toBe(headerId);
		const activeIds = activeText.split("\n").flatMap(line => {
			try {
				return [JSON.parse(line).id];
			} catch {
				return [];
			}
		});
		expect(activeIds).toContain(oldId);
		const loaded = await loadSessionFile(sessionFile, storage);
		expect(loaded.entries.slice(1).map(entry => entry.id)).toEqual(manager.getEntries().map(entry => entry.id));
		const recovered = await SessionManager.open(sessionFile, undefined, storage, {
			initialCwd: dir,
			suppressBreadcrumb: true,
		});
		try {
			expect(recovered.getEntries().map(entry => entry.id)).toEqual(manager.getEntries().map(entry => entry.id));
		} finally {
			await recovered.close();
		}
	} finally {
		// The injected publish failure is latched as the manager's disk error, like a process interruption.
		await manager.close().catch(() => undefined);
	}
});

test("repeated compaction preserves archived order when the former anchor is archived", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-transcript-archive-anchor-"));
	tempDirs.push(dir);
	const manager = SessionManager.create(dir, dir);
	const ids = [1, 2, 3, 4].map(index =>
		manager.appendMessage({ role: "user", content: `message ${index}`, timestamp: index }),
	);
	manager.appendCompaction("first summary", undefined, ids[2]!, 40);
	await manager.ensureOnDisk();
	await manager.flush();
	await manager.archiveCompactedHistory(ids[2]!);
	manager.appendCompaction("second summary", undefined, ids[3]!, 30);
	await manager.flush();
	await manager.archiveCompactedHistory(ids[3]!);
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
		initialCwd: dir,
		suppressBreadcrumb: true,
	});
	try {
		expect(reopened.getEntries().map(entry => entry.id)).toEqual(manager.getEntries().map(entry => entry.id));
	} finally {
		await reopened.close();
		await manager.close();
	}
});

test("relocating a compacted session moves its archive sidecar with the transcript", async () => {
	const { dir, manager, sessionFile, kept } = await makeCompactedSession();
	const destination = path.join(dir, "moved-sessions");
	try {
		const expected = manager.getEntries().map(entry => entry.id);
		await manager.archiveCompactedHistory(kept);
		await manager.moveTo(dir, destination);
		const movedFile = manager.getSessionFile();
		if (!movedFile) throw new Error("Expected a relocated session file");
		expect(fs.existsSync(`${sessionFile}.archive.jsonl.gz`)).toBe(false);
		expect(fs.existsSync(`${movedFile}.archive.jsonl.gz`)).toBe(true);
		const reopened = await SessionManager.open(movedFile, undefined, undefined, {
			initialCwd: dir,
			suppressBreadcrumb: true,
		});
		try {
			expect(reopened.getEntries().map(entry => entry.id)).toEqual(expected);
		} finally {
			await reopened.close();
		}
	} finally {
		await manager.close();
	}
});
