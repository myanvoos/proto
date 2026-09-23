import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "./session-manager";
import * as sessionPaths from "./session-paths";
import { hasPositiveMovedProjectEvidence, readCwdIdentity } from "./session-paths";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function project(): Promise<{ root: string; cwd: string; sessionDir: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-continue-"));
	roots.push(root);
	const cwd = path.join(root, "work");
	const sessionDir = path.join(root, "sessions");
	await fs.mkdir(cwd);
	await fs.mkdir(sessionDir);
	return { root, cwd, sessionDir };
}

async function persisted(
	cwd: string,
	sessionDir: string,
	turns: { user?: string; assistant?: string },
	mtimeSec: number,
): Promise<string> {
	const manager = SessionManager.create(cwd, sessionDir);
	if (turns.user) manager.appendMessage({ role: "user", content: turns.user, timestamp: 1 });
	if (turns.assistant) {
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: turns.assistant }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
	}
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("expected a persisted session file");
	await manager.close();
	await fs.utimes(file, mtimeSec, mtimeSec);
	return file;
}

test("--continue and the pickers skip a newer 0-turn stub", async () => {
	vi.spyOn(sessionPaths, "readTerminalBreadcrumbEntry").mockResolvedValue(null);
	const { cwd, sessionDir } = await project();
	const answered = await persisted(cwd, sessionDir, { user: "fix the parser", assistant: "done" }, 1_000);
	const prompted = await persisted(cwd, sessionDir, { user: "a prompt that never got a reply" }, 2_000);
	const stub = await persisted(cwd, sessionDir, {}, 3_000);

	const listed = (await SessionManager.listForPicker(cwd, sessionDir)).map(session => session.path);
	expect(listed).toEqual([prompted, answered]);
	expect((await SessionManager.list(cwd, sessionDir)).map(session => session.path)).toContain(stub);

	const continued = await SessionManager.continueRecent(cwd, sessionDir, undefined, { claimOwnership: () => true });
	expect(continued.getSessionFile()).toBe(prompted);
});

test("an explicit session directory fences a breadcrumb recorded for another directory", async () => {
	const { root, cwd, sessionDir } = await project();
	const otherDir = path.join(root, "other-sessions");
	await fs.mkdir(otherDir);
	const foreign = await persisted(cwd, otherDir, { user: "elsewhere", assistant: "ok" }, 3_000);
	const local = await persisted(cwd, sessionDir, { user: "here", assistant: "ok" }, 1_000);
	const claim = { claimOwnership: () => true };

	const crumb = vi.spyOn(sessionPaths, "readTerminalBreadcrumbEntry");
	crumb.mockResolvedValue({ cwd, sessionFile: foreign, exists: true, fresh: false });
	expect((await SessionManager.continueRecent(cwd, sessionDir, undefined, claim)).getSessionFile()).toBe(local);

	// A fresh boundary recorded for another directory must not force a new session here either.
	crumb.mockResolvedValue({
		cwd,
		sessionFile: path.join(otherDir, "never-written.jsonl"),
		exists: false,
		fresh: true,
	});
	expect((await SessionManager.continueRecent(cwd, sessionDir, undefined, claim)).getSessionFile()).toBe(local);
});

test("moved-project evidence requires the same directory inode", async () => {
	const { root, cwd } = await project();
	const identity = readCwdIdentity(cwd);
	const sibling = path.join(root, "sibling");
	await fs.mkdir(sibling);
	expect(hasPositiveMovedProjectEvidence(identity, sibling)).toBe(false);

	const renamed = path.join(root, "renamed");
	await fs.rename(cwd, renamed);
	expect(hasPositiveMovedProjectEvidence(identity, renamed)).toBe(true);
	expect(hasPositiveMovedProjectEvidence(undefined, renamed)).toBe(false);
});

test("--continue re-roots a renamed project but not into an unrelated cwd after a delete", async () => {
	const claim = { claimOwnership: () => true };
	const crumb = vi.spyOn(sessionPaths, "readTerminalBreadcrumbEntry");

	const renamedCase = await project();
	const movedFile = await persisted(
		renamedCase.cwd,
		renamedCase.sessionDir,
		{ user: "before move", assistant: "ok" },
		1_000,
	);
	crumb.mockResolvedValue({
		cwd: renamedCase.cwd,
		sessionFile: movedFile,
		exists: true,
		fresh: false,
		cwdIdentity: readCwdIdentity(renamedCase.cwd),
	});
	const renamedCwd = path.join(renamedCase.root, "renamed");
	await fs.rename(renamedCase.cwd, renamedCwd);
	const targetDir = path.join(renamedCase.root, "target-sessions");
	const moved = await SessionManager.continueRecent(renamedCwd, targetDir, undefined, claim);
	expect(moved.getCwd()).toBe(renamedCwd);
	expect(moved.getEntries().some(entry => JSON.stringify(entry).includes("before move"))).toBe(true);
	await moved.close();

	const deletedCase = await project();
	const oldFile = await persisted(
		deletedCase.cwd,
		deletedCase.sessionDir,
		{ user: "original", assistant: "ok" },
		1_000,
	);
	crumb.mockResolvedValue({
		cwd: deletedCase.cwd,
		sessionFile: oldFile,
		exists: true,
		fresh: false,
		cwdIdentity: readCwdIdentity(deletedCase.cwd),
	});
	// Created before the delete so the filesystem cannot hand it the deleted directory's inode.
	const unrelated = path.join(deletedCase.root, "unrelated");
	await fs.mkdir(unrelated);
	await fs.rm(deletedCase.cwd, { recursive: true, force: true });
	const fresh = await SessionManager.continueRecent(
		unrelated,
		path.join(deletedCase.root, "unrelated-sessions"),
		undefined,
		claim,
	);
	expect(fresh.getSessionFile()).not.toBe(oldFile);
	expect(fresh.getEntries()).toHaveLength(0);
	expect(await Bun.file(oldFile).text()).toContain(JSON.stringify(deletedCase.cwd));
	await fresh.close();
});
