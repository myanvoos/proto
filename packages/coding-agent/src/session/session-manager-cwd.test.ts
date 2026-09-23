import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "./session-manager";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

async function writeSession(cwd: string, sessionDir: string): Promise<string> {
	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile();
	await manager.close();
	if (!file) throw new Error("expected a persisted session file");
	return file;
}

async function readHeader(sessionFile: string, sessionDir: string) {
	const reopened = await SessionManager.open(sessionFile, sessionDir, undefined, { suppressBreadcrumb: true });
	try {
		return { ...reopened.getHeader()!, additionalDirectories: reopened.getAdditionalDirectories() };
	} finally {
		await reopened.close();
	}
}

/** Deny search permission on `dir` the way a macOS TCC-protected folder does, while it still stats as a directory. */
function denyEntry(dir: string) {
	const access = fs.promises.access.bind(fs.promises);
	return spyOn(fs.promises, "access").mockImplementation(async (target, mode) => {
		if (path.resolve(String(target)) === dir) throw Object.assign(new Error("denied"), { code: "EACCES" });
		return access(target, mode);
	});
}

test("a session whose project cannot be entered resumes in the launch cwd without persisting workspace edits", async () => {
	const launch = tempDir("proto-cwd-launch-");
	const project = tempDir("proto-cwd-denied-");
	const store = tempDir("proto-cwd-store-");
	const extra = tempDir("proto-cwd-extra-");
	const sessionFile = await writeSession(project, store);

	const denied = denyEntry(project);
	try {
		const manager = await SessionManager.open(sessionFile, store, undefined, {
			initialCwd: launch,
			suppressBreadcrumb: true,
		});
		expect(manager.getCwd()).toBe(launch);
		expect(manager.getRecordedCwd()).toBe(project);

		await manager.addWorkspaceDirectory(extra);
		await manager.flush();
		await manager.close();
		expect(manager.getAdditionalDirectories()).toEqual([extra]);
	} finally {
		denied.mockRestore();
	}
	const header = await readHeader(sessionFile, store);
	expect(header.cwd).toBe(project);
	expect(header.additionalDirectories).toEqual([]);
});

test("moving a fallback session into its runtime cwd re-records the project even when the file stays put", async () => {
	const launch = tempDir("proto-cwd-launch-");
	const project = tempDir("proto-cwd-denied-");
	const store = tempDir("proto-cwd-store-");
	const sessionFile = await writeSession(project, store);

	const denied = denyEntry(project);
	try {
		const manager = await SessionManager.open(sessionFile, store, undefined, {
			initialCwd: launch,
			suppressBreadcrumb: true,
		});
		await manager.moveTo(launch, store);
		await manager.close();
		expect(manager.getSessionFile()).toBe(sessionFile);
	} finally {
		denied.mockRestore();
	}
	expect((await readHeader(sessionFile, store)).cwd).toBe(launch);
});

test("rolling back a move restores the transcript location, header, and filtered workspace roots", async () => {
	const source = tempDir("proto-cwd-source-");
	const target = tempDir("proto-cwd-target-");
	const sourceStore = tempDir("proto-cwd-source-store-");
	const targetStore = tempDir("proto-cwd-target-store-");
	const manager = SessionManager.create(source, sourceStore);
	manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	// The move target is also a workspace root, which the forward move filters out of the header.
	await manager.addWorkspaceDirectory(target);
	await manager.ensureOnDisk();
	await manager.flush();
	const originalFile = manager.getSessionFile()!;
	const snapshot = manager.captureState();

	await manager.moveTo(target, targetStore);
	expect(fs.existsSync(originalFile)).toBe(false);
	await manager.rollbackMove(snapshot);
	await manager.close();

	expect(manager.getSessionFile()).toBe(originalFile);
	expect(manager.getCwd()).toBe(source);
	expect(fs.readdirSync(targetStore).filter(name => name.endsWith(".jsonl"))).toEqual([]);
	const header = await readHeader(originalFile, sourceStore);
	expect(header.cwd).toBe(source);
	expect(header.additionalDirectories).toEqual([target]);
});

test("a failed move rollback keeps the manager on the moved transcript and says where it is", async () => {
	const source = tempDir("proto-cwd-source-");
	const target = tempDir("proto-cwd-target-");
	const sourceStore = tempDir("proto-cwd-source-store-");
	const targetStore = tempDir("proto-cwd-target-store-");
	const manager = SessionManager.create(source, sourceStore);
	manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	await manager.ensureOnDisk();
	await manager.flush();
	const snapshot = manager.captureState();
	await manager.moveTo(target, targetStore);
	const movedFile = manager.getSessionFile()!;

	const moveTo = spyOn(manager, "moveTo").mockRejectedValueOnce(new Error("rename denied"));
	try {
		await expect(manager.rollbackMove(snapshot)).rejects.toThrow(`the session file remains at ${movedFile}`);
	} finally {
		moveTo.mockRestore();
	}
	expect(manager.getSessionFile()).toBe(movedFile);
	expect(manager.getCwd()).toBe(target);
	await manager.close();
});
