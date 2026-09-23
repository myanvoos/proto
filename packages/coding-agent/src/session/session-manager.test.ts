import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION, type SessionEntry } from "./session-entries";
import { SessionManager } from "./session-manager";
import { FileSessionStorage, MemorySessionStorage, SessionStorageLockError } from "./session-storage";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("open rejects a corrupt session header without overwriting recoverable transcript bytes", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proto-corrupt-session-header-"));
	tempDirs.push(cwd);
	const sessionFile = path.join(cwd, "corrupt-session.jsonl");
	const original = [
		"{broken header",
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-08-27T00:00:00.000Z",
			message: { role: "user", content: "recover me", timestamp: 0 },
		}),
		"",
	].join("\n");
	await Bun.write(sessionFile, original);

	let opened: SessionManager | undefined;
	let openError: unknown;
	try {
		opened = await SessionManager.open(sessionFile, undefined, undefined, {
			initialCwd: cwd,
			suppressBreadcrumb: true,
		});
	} catch (error) {
		openError = error;
	}
	const persisted = await Bun.file(sessionFile).text();
	await opened?.close();

	expect(persisted).toBe(original);
	expect(openError).toBeInstanceOf(Error);
	expect((openError as Error).message).toContain("session header is missing or malformed");
});
test("open refuses a malformed complete middle record without rewriting transcript bytes", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proto-corrupt-session-middle-"));
	tempDirs.push(cwd);
	const sessionFile = path.join(cwd, "corrupt-session.jsonl");
	const original = [
		JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "session-corrupt-middle",
			timestamp: "2026-09-19T00:00:00.000Z",
			cwd,
		}),
		JSON.stringify({
			type: "custom",
			id: "before-corruption",
			parentId: null,
			timestamp: "2026-09-19T00:00:01.000Z",
			customType: "preserved-before",
			data: { value: "before" },
		}),
		'{"type":"custom","id":"damaged",BROKEN}',
		JSON.stringify({
			type: "custom",
			id: "after-corruption",
			parentId: "before-corruption",
			timestamp: "2026-09-19T00:00:02.000Z",
			customType: "preserved-after",
			data: { value: "after" },
		}),
		"",
	].join("\n");
	await Bun.write(sessionFile, original);

	let manager: SessionManager | undefined;
	let resumeError: unknown;
	try {
		manager = await SessionManager.open(sessionFile, undefined, undefined, {
			initialCwd: cwd,
			suppressBreadcrumb: true,
		});
		manager.appendCustomEntry("would-trigger-rewrite", { value: "new" });
		manager.flushSync();
	} catch (error) {
		resumeError = error;
	} finally {
		try {
			await manager?.close();
		} catch (error) {
			resumeError ??= error;
		}
	}

	expect(await Bun.file(sessionFile).text()).toBe(original);
	expect(resumeError).toBeInstanceOf(Error);
	expect((resumeError as Error).message).toContain("malformed");
});

test("resume recovers only a malformed unterminated final record", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proto-torn-final-session-"));
	tempDirs.push(cwd);
	const sessionFile = path.join(cwd, "torn-final-session.jsonl");
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "torn-final-session",
		timestamp: "2026-09-19T00:00:00.000Z",
		cwd,
	};
	const existing = {
		type: "custom",
		id: "existing-before-torn-tail",
		parentId: null,
		timestamp: "2026-09-19T00:00:01.000Z",
		customType: "existing",
		data: { value: "kept" },
	};
	await Bun.write(
		sessionFile,
		`${JSON.stringify(header)}\n${JSON.stringify(existing)}\n{"type":"custom","id":"torn-tail"`,
	);

	const resumed = await SessionManager.open(sessionFile, undefined, undefined, {
		initialCwd: cwd,
		suppressBreadcrumb: true,
	});
	expect(resumed.getEntries().map(entry => entry.id)).toEqual(["existing-before-torn-tail"]);
	const appendedId = resumed.appendCustomEntry("after-torn-tail", { value: "persisted" });
	await resumed.flush();
	await resumed.close();

	const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
		initialCwd: cwd,
		suppressBreadcrumb: true,
	});
	try {
		expect(reopened.getEntries().map(entry => entry.id)).toEqual(["existing-before-torn-tail", appendedId]);
		expect(await Bun.file(sessionFile).text()).not.toContain('"id":"torn-tail"');
	} finally {
		await reopened.close();
	}
});

test("healthy sessions still resume, append, and resume again", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proto-healthy-session-resume-"));
	tempDirs.push(cwd);
	const sessionFile = path.join(cwd, "healthy-session.jsonl");
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "healthy-session",
		timestamp: "2026-09-19T00:00:00.000Z",
		cwd,
	};
	const existing = {
		type: "custom",
		id: "existing-entry",
		parentId: null,
		timestamp: "2026-09-19T00:00:01.000Z",
		customType: "existing",
		data: { value: "kept" },
	};
	await Bun.write(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(existing)}\n`);

	const resumed = await SessionManager.open(sessionFile, undefined, undefined, {
		initialCwd: cwd,
		suppressBreadcrumb: true,
	});
	expect(resumed.getEntries().map(entry => entry.id)).toEqual(["existing-entry"]);
	const appendedId = resumed.appendCustomEntry("after-resume", { value: "persisted" });
	await resumed.flush();
	await resumed.close();

	const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
		initialCwd: cwd,
		suppressBreadcrumb: true,
	});
	try {
		expect(reopened.getEntries().map(entry => entry.id)).toEqual(["existing-entry", appendedId]);
	} finally {
		await reopened.close();
	}
});

test("an in-memory session resumes disk content without acquiring a persistence target", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proto-memory-resume-"));
	tempDirs.push(cwd);
	const sessionFile = path.join(cwd, "resumable.jsonl");
	const original = [
		JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "disk-resume",
			cwd,
			timestamp: "2026-09-22T00:00:00.000Z",
			title: "Persisted title",
		}),
		JSON.stringify({
			type: "message",
			id: "user-one",
			parentId: null,
			timestamp: "2026-09-22T00:00:00.000Z",
			message: { role: "user", content: "VISIBLE_RESUMED_MESSAGE", timestamp: 1 },
		}),
		"",
	].join("\n");
	await Bun.write(sessionFile, original);
	const before = fs.readdirSync(cwd);
	const manager = SessionManager.inMemory(cwd);
	try {
		await manager.setSessionFile(sessionFile);
		expect(manager.getSessionId()).toBe("disk-resume");
		expect(manager.getSessionName()).toBe("Persisted title");
		expect(JSON.stringify(manager.buildSessionContext({ transcript: true }).messages)).toContain(
			"VISIBLE_RESUMED_MESSAGE",
		);
		expect(manager.getSessionFile()).toBeUndefined();
		expect(manager.getArtifactsDir()).toBeNull();
		expect(manager.isSessionOnDisk()).toBe(false);
		manager.appendMessage({ role: "user", content: "UNSAVED_CONTINUATION", timestamp: 2 });
		await manager.setSessionName("Unsaved title");
		expect(manager.getSessionName()).toBe("Unsaved title");
		await manager.saveDraft("unsaved editor draft");
		await manager.ensureOnDisk();
		await manager.flush();
		expect(JSON.stringify(manager.buildSessionContext({ transcript: true }).messages)).toContain(
			"UNSAVED_CONTINUATION",
		);
		await manager.setSessionFile(sessionFile);
		expect(JSON.stringify(manager.buildSessionContext({ transcript: true }).messages)).not.toContain(
			"UNSAVED_CONTINUATION",
		);
		expect(manager.getSessionFile()).toBeUndefined();
	} finally {
		await manager.close();
	}
	expect(await Bun.file(sessionFile).text()).toBe(original);
	expect(fs.readdirSync(cwd)).toEqual(before);
});

test("in-memory resume still accepts explicitly supplied memory-backed transcripts", async () => {
	const storage = new MemorySessionStorage();
	const file = path.resolve("memory-only-resume.jsonl");
	storage.writeTextSync(
		file,
		`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "memory-source", cwd: process.cwd(), timestamp: "2026-09-22T00:00:00.000Z" })}\n`,
	);
	const manager = SessionManager.inMemory(process.cwd(), storage);
	try {
		await manager.setSessionFile(file);
		expect(manager.getSessionId()).toBe("memory-source");
		expect(manager.getSessionFile()).toBeUndefined();
	} finally {
		await manager.close();
	}
});

test("close releases retained entries after sealing an in-memory session", async () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("retained", { payload: "x".repeat(100_000) });

	await manager.close();

	expect(manager.getEntries()).toEqual([]);
	expect(manager.getBranch()).toEqual([]);
});

function customMessageImageData(entry: SessionEntry | undefined): string | undefined {
	if (entry?.type !== "custom_message" || !Array.isArray(entry.content)) return undefined;
	const image = entry.content.find(block => block.type === "image");
	return image?.data;
}

test("blob-backed history stays exact across cache eviction, navigation, context, and resume", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proto-lazy-session-history-"));
	tempDirs.push(cwd);
	const manager = SessionManager.create(cwd, cwd);
	const records: Array<{ id: string; data: string }> = [];

	for (let index = 0; index < 80; index++) {
		const bytes = Buffer.alloc(2_048, index);
		bytes.writeUInt32LE(index, 0);
		const data = bytes.toString("base64");
		const id = manager.appendCustomMessageEntry("image", [{ type: "image", data, mimeType: "image/png" }], true);
		records.push({ id, data });
	}

	const first = records[0];
	const last = records.at(-1);
	if (!first || !last) throw new Error("Expected image history fixtures");
	expect(customMessageImageData(manager.getEntry(first.id))).toBe(first.data);
	expect(customMessageImageData(manager.getEntries()[0])).toBe(first.data);
	expect(customMessageImageData(manager.getBranch()[0])).toBe(first.data);
	expect(customMessageImageData(manager.getTree()[0]?.entry)).toBe(first.data);
	expect(JSON.stringify(manager.buildSessionContext({ transcript: true }))).toContain(first.data);

	const clone = manager.cloneCurrentSession({ persist: false });
	try {
		expect(customMessageImageData(clone.getEntry(first.id))).toBe(first.data);
	} finally {
		await clone.close();
	}
	const exported = await manager.persistCopy({ sessionDir: "/sessions" }, new MemorySessionStorage());
	try {
		expect(customMessageImageData(exported.getEntry(first.id))).toBe(first.data);
	} finally {
		await exported.close();
	}

	manager.branch(first.id);
	expect(manager.getBranch().map(entry => entry.id)).toEqual([first.id]);
	expect(customMessageImageData(manager.getLeafEntry())).toBe(first.data);
	manager.branch(last.id);

	await manager.ensureOnDisk();
	await manager.flush();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	const persisted = await Bun.file(sessionFile).text();
	expect(persisted).toContain("blob:sha256:");
	expect(persisted).not.toContain(first.data);
	const rawEntryDirectory = manager.captureState().rawEntryDirectory;
	expect(rawEntryDirectory?.startsWith(os.tmpdir())).toBe(true);
	await manager.close();
	expect(rawEntryDirectory ? fs.existsSync(rawEntryDirectory) : true).toBe(false);

	const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
		initialCwd: cwd,
		suppressBreadcrumb: true,
	});
	try {
		expect(customMessageImageData(reopened.getEntry(first.id))).toBe(first.data);
		expect(customMessageImageData(reopened.getEntries()[0])).toBe(first.data);
		expect(customMessageImageData(reopened.getBranch()[0])).toBe(first.data);
	} finally {
		await reopened.close();
	}
});

test("title lock contention is retryable without latching a disk failure", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proto-retry-session-title-"));
	tempDirs.push(cwd);
	const storage = new FileSessionStorage();
	const manager = SessionManager.create(cwd, cwd, storage);
	await manager.ensureOnDisk();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	const competingWriter = storage.openWriter(sessionFile);

	try {
		await expect(manager.setSessionName("Recovered title", "user")).rejects.toBeInstanceOf(SessionStorageLockError);
	} finally {
		await competingWriter.close();
	}
	await manager.ensureOnDisk();
	await manager.close();

	const reopened = await SessionManager.open(sessionFile, undefined, storage, {
		initialCwd: cwd,
		suppressBreadcrumb: true,
	});
	try {
		expect(reopened.getSessionName()).toBe("Recovered title");
	} finally {
		await reopened.close();
	}
});

test("atomic title replacement keeps subsequent appends on the replaced file", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proto-atomic-session-title-"));
	tempDirs.push(cwd);
	const manager = SessionManager.create(cwd, cwd);
	await manager.ensureOnDisk();
	expect(await manager.setSessionName("Crash-atomic title", "user")).toBe(true);
	const afterTitleId = manager.appendCustomEntry("after-title", { preserved: true });
	await manager.flush();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	await manager.close();

	const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
		initialCwd: cwd,
		suppressBreadcrumb: true,
	});
	try {
		expect(reopened.getSessionName()).toBe("Crash-atomic title");
		expect(reopened.getEntry(afterTitleId)?.type).toBe("custom");
	} finally {
		await reopened.close();
	}
});

test("getTree materializes a deep linear history instead of overflowing the stack", () => {
	// Sessions are near-linear chains, so tree depth tracks entry count. The rewind
	// selector materializes the whole tree, so a recursive walk crashed the TUI with
	// "Maximum call stack size exceeded" once a history grew past ~10k entries.
	const manager = SessionManager.inMemory();
	const depth = 25_000;
	for (let index = 0; index < depth; index++) {
		manager.appendMessage({ role: "user", content: `message ${index}`, timestamp: index });
	}

	const roots = manager.getTree();
	expect(roots).toHaveLength(1);

	let node = roots[0];
	let walked = 1;
	while (node && node.children.length > 0) {
		node = node.children[0];
		walked++;
	}
	expect(walked).toBe(depth);
	const leafId = manager.getLeafId();
	if (!leafId) throw new Error("Expected a leaf entry");
	expect(node?.entry.id).toBe(leafId);
});

test("getTree keeps sibling branches in the order the index sorted them", () => {
	const manager = SessionManager.inMemory();
	const rootId = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
	const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 2 });
	manager.branch(rootId);
	const secondId = manager.appendMessage({ role: "user", content: "second", timestamp: 3 });

	const root = manager.getTree()[0];
	expect(root?.entry.id).toBe(rootId);
	expect(root?.children.map(child => child.entry.id)).toEqual([firstId, secondId]);
});
