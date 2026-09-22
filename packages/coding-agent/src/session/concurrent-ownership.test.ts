import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "../cli/args";
import { Settings } from "../config/settings";
import { createSessionManager, SessionResolutionError } from "../main";
import { getSessionLivePath } from "./session-liveness";
import { SessionManager } from "./session-manager";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function project(): Promise<{ cwd: string; sessionDir: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-wave5-concurrent-"));
	roots.push(root);
	const cwd = path.join(root, "work");
	const sessionDir = path.join(root, "sessions");
	await fs.mkdir(cwd);
	await fs.mkdir(sessionDir);
	return { cwd, sessionDir };
}

async function seededSession(cwd: string, sessionDir: string): Promise<SessionManager> {
	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendMessage({ role: "user", content: "owner turn", timestamp: Date.now() });
	await manager.ensureOnDisk();
	await manager.flush();
	return manager;
}

async function markLive(sessionFile: string, pid: number): Promise<void> {
	await Bun.write(getSessionLivePath(sessionFile), JSON.stringify({ pid, streaming: false, at: Date.now() }));
}

function args(overrides: Partial<Args>): Args {
	return { messages: [], unrecognizedFlags: [], ...overrides } as Args;
}

test("resuming a session owned by another live process is refused instead of silently dropped", async () => {
	const { cwd, sessionDir } = await project();
	const owner = await seededSession(cwd, sessionDir);
	const sessionFile = owner.getSessionFile()!;
	await markLive(sessionFile, process.ppid);

	const attempt = createSessionManager(args({ resume: sessionFile, sessionDir, cwd }), cwd, Settings.isolated());
	await expect(attempt).rejects.toThrow(SessionResolutionError);
	await expect(attempt).rejects.toThrow(`pid ${process.ppid}`);

	await fs.rm(getSessionLivePath(sessionFile), { force: true });
	const resumed = await createSessionManager(args({ resume: sessionFile, sessionDir, cwd }), cwd, Settings.isolated());
	expect(resumed?.getSessionFile()).toBe(sessionFile);
});

test("--continue starts a new session instead of joining the live owner's file", async () => {
	const { cwd, sessionDir } = await project();
	const owner = await seededSession(cwd, sessionDir);
	const sessionFile = owner.getSessionFile()!;
	await markLive(sessionFile, process.ppid);

	const continued = await SessionManager.continueRecent(cwd, sessionDir);
	expect(continued.getSessionFile()).not.toBe(sessionFile);
	expect(continued.getEntries()).toHaveLength(0);

	continued.appendMessage({ role: "user", content: "second cli turn", timestamp: Date.now() });
	await continued.ensureOnDisk();
	await continued.flush();
	const file = continued.getSessionFile()!;
	expect(file).not.toBe(sessionFile);
	expect(await Bun.file(file).text()).toContain("second cli turn");
	expect(await Bun.file(sessionFile).text()).not.toContain("second cli turn");
});

test("a locked session file reports the contention instead of discarding entries", async () => {
	const { cwd, sessionDir } = await project();
	const owner = await seededSession(cwd, sessionDir);
	const sessionFile = owner.getSessionFile()!;
	owner.appendMessage({ role: "user", content: "owner keeps the writer open", timestamp: Date.now() });
	await markLive(sessionFile, process.ppid);

	const second = await SessionManager.open(sessionFile, sessionDir);
	const failures: string[] = [];
	second.onPersistenceError(error => failures.push(error.message));
	second.appendMessage({ role: "user", content: "second cli turn", timestamp: Date.now() });
	await second.ensureOnDisk().catch(() => {});
	await second.flush().catch(() => {});

	expect(failures.join(" ")).toContain(`pid ${process.ppid}`);
	expect(second.getEntries().some(entry => JSON.stringify(entry).includes("second cli turn"))).toBe(true);
});
