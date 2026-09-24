import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sessionArchivePath } from "./session-loader";
import { SessionManager } from "./session-manager";

const managers: SessionManager[] = [];
const directories: string[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close();
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("failed branch retention keeps the archived source session renderable", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proto-branch-failure-"));
	directories.push(cwd);
	const manager = SessionManager.create(cwd, cwd);
	managers.push(manager);
	const archivedId = manager.appendMessage({
		role: "user",
		content: "oversized archived context ".repeat(120_000),
		timestamp: 1,
	});
	const activeId = manager.appendMessage({ role: "user", content: "active context", timestamp: 2 });
	manager.appendCompaction("summary", undefined, activeId, 1000);
	await manager.ensureOnDisk();
	await manager.flush();
	await manager.archiveCompactedHistory(activeId);

	const sourceFile = manager.getSessionFile();
	if (!sourceFile) throw new Error("Expected persisted source file");
	const archiveFile = sessionArchivePath(sourceFile);
	const sourceContents = fs.readFileSync(sourceFile, "utf8");
	const archiveContents = fs.readFileSync(archiveFile, "utf8");
	const before = manager.captureState();
	const beforeEntries = manager.getEntries();
	let injected = false;
	const originalWrite = fs.writeFileSync;
	const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(((file: string | number | URL, ...args: never[]) => {
		if (String(file).endsWith(".entry.gz") && !injected) {
			injected = true;
			throw new Error("injected retention spill failure");
		}
		return Reflect.apply(originalWrite, fs, [file, ...args]);
	}) as typeof fs.writeFileSync);
	try {
		expect(() => manager.createBranchedSession(activeId)).toThrow("injected retention spill failure");
	} finally {
		writeSpy.mockRestore();
	}

	expect(injected).toBe(true);
	expect(manager.getSessionFile()).toBe(sourceFile);
	expect(manager.getSessionId()).toBe(before.sessionId);
	expect(manager.captureState().header).toEqual(before.header);
	expect(manager.captureState().archivedEntryIds).toEqual(before.archivedEntryIds);
	expect(manager.getEntries()).toEqual(beforeEntries);
	expect(fs.readFileSync(sourceFile, "utf8")).toBe(sourceContents);
	expect(fs.readFileSync(archiveFile, "utf8")).toBe(archiveContents);

	await manager.rewriteEntries();
	expect(fs.readFileSync(sourceFile, "utf8")).toBe(sourceContents);
	expect(fs.readFileSync(archiveFile, "utf8")).toBe(archiveContents);
	expect(manager.getEntry(archivedId)?.type).toBe("message");
});
