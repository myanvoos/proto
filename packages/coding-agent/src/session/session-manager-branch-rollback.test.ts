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

async function archivedSession(): Promise<{
	manager: SessionManager;
	archivedId: string;
	activeId: string;
	sourceFile: string;
}> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proto-branch-rollback-"));
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
	return { manager, archivedId, activeId, sourceFile };
}

function injectSpillFailure(restoreFailure?: Error): { restore(): void; getOriginal(): Error } {
	const originalFailure = new Error("injected retention spill failure");
	let spillFailed = false;
	let restoreFailed = false;
	const originalWrite = fs.writeFileSync;
	const spy = spyOn(fs, "writeFileSync").mockImplementation(((file: string | number | URL, ...args: never[]) => {
		if (String(file).endsWith(".entry.gz")) {
			if (!spillFailed) {
				spillFailed = true;
				throw originalFailure;
			}
			if (restoreFailure && !restoreFailed) {
				restoreFailed = true;
				throw restoreFailure;
			}
		}
		return Reflect.apply(originalWrite, fs, [file, ...args]);
	}) as typeof fs.writeFileSync);
	return { restore: () => spy.mockRestore(), getOriginal: () => originalFailure };
}

test("failed branch restores archived metadata, artifact manager, and force-file behavior", async () => {
	const { manager, archivedId, activeId, sourceFile } = await archivedSession();
	const artifactManager = manager.getArtifactManager();
	const before = manager.captureState();
	const sourceContents = fs.readFileSync(sourceFile, "utf8");
	const archiveContents = fs.readFileSync(sessionArchivePath(sourceFile), "utf8");
	const failure = injectSpillFailure();
	try {
		expect(() => manager.createBranchedSession(activeId)).toThrow(failure.getOriginal());
	} finally {
		failure.restore();
	}

	const after = manager.captureState();
	expect(after.header).toEqual(before.header);
	expect(after.sessionId).toBe(before.sessionId);
	expect(after.sessionFile).toBe(before.sessionFile);
	expect(after.archivedEntryIds).toEqual(before.archivedEntryIds);
	expect(after.entries).toEqual(before.entries);
	expect(after.forceFileCreation).toBe(before.forceFileCreation);
	expect(after.artifactManager).toBe(before.artifactManager);
	expect(after.artifactManagerSessionFile).toBe(before.artifactManagerSessionFile);
	expect(manager.getArtifactManager()).toBe(artifactManager);
	await manager.rewriteEntries();
	expect(fs.readFileSync(sourceFile, "utf8")).toBe(sourceContents);
	expect(fs.readFileSync(sessionArchivePath(sourceFile), "utf8")).toBe(archiveContents);
	expect(manager.getEntry(archivedId)?.type).toBe("message");
});

test("branch rollback preserves original error if raw-entry restoration fails", async () => {
	const { manager, activeId } = await archivedSession();
	const artifactManager = manager.getArtifactManager();
	const before = manager.captureState();
	const restoreFailure = new Error("injected restoration failure");
	const failure = injectSpillFailure(restoreFailure);
	try {
		expect(() => manager.createBranchedSession(activeId)).toThrow(failure.getOriginal());
	} finally {
		failure.restore();
	}
	const after = manager.captureState();
	expect(after.header).toEqual(before.header);
	expect(after.sessionId).toBe(before.sessionId);
	expect(after.sessionFile).toBe(before.sessionFile);
	expect(after.archivedEntryIds).toEqual(before.archivedEntryIds);
	expect(after.entries).toEqual(before.entries);
	expect(after.sessionName).toBe(before.sessionName);
	expect(after.titleSource).toBe(before.titleSource);
	expect(after.titleUpdatedAt).toBe(before.titleUpdatedAt);
	expect(after.hasTitleSlot).toBe(before.hasTitleSlot);
	expect(after.forceFileCreation).toBe(before.forceFileCreation);
	expect(after.artifactManager).toBe(before.artifactManager);
	expect(after.artifactManagerSessionFile).toBe(before.artifactManagerSessionFile);
	expect(manager.getArtifactManager()).toBe(artifactManager);
});
