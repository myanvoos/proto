import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type SessionManagerStateSnapshot } from "../../session/session-manager";
import { initThemeSync } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { CommandController } from "./command-controller";

initThemeSync();

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

async function moveWith(applyCwdChange: (cwd: string) => Promise<boolean>) {
	const source = tempDir("proto-move-source-");
	const target = tempDir("proto-move-target-");
	const sourceStore = tempDir("proto-move-source-store-");
	const targetStore = tempDir("proto-move-target-store-");
	const sessionManager = SessionManager.create(source, sourceStore);
	sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	await sessionManager.ensureOnDisk();
	await sessionManager.flush();
	const originalFile = sessionManager.getSessionFile()!;
	const errors: string[] = [];
	const applied: string[] = [];
	let shutdowns = 0;
	let presented = false;
	const controller = new CommandController({
		session: {
			isStreaming: false,
			moveSession: (cwd: string) => sessionManager.moveTo(cwd, targetStore),
			rollbackMove: (snapshot: SessionManagerStateSnapshot) => sessionManager.rollbackMove(snapshot),
		},
		sessionManager,
		settings: { flush: async () => {} },
		applyCwdChange: async (cwd: string) => {
			applied.push(cwd);
			return applyCwdChange(cwd);
		},
		shutdown: async () => {
			shutdowns++;
		},
		updateEditorBorderColor: () => {},
		reloadChecklist: async () => {},
		ui: { requestRender: () => {} },
		present: () => {
			presented = true;
		},
		showError: (message: string) => errors.push(message),
	} as unknown as InteractiveModeContext);
	await controller.handleMoveCommand(target);
	await sessionManager.close();
	return { source, target, sessionManager, originalFile, errors, applied, shutdowns, presented };
}

test("a /move whose workspace cannot follow moves the session back to its project", async () => {
	const result = await moveWith(async () => false);

	expect(result.applied).toEqual([result.target]);
	expect(result.sessionManager.getCwd()).toBe(result.source);
	expect(result.sessionManager.getSessionFile()).toBe(result.originalFile);
	expect(fs.existsSync(result.originalFile)).toBe(true);
	expect(result.presented).toBe(false);
	expect(result.shutdowns).toBe(0);
});

test("a /move that leaves the process stranded shuts down when the source workspace cannot be restored", async () => {
	const result = await moveWith(async () => {
		throw new Error("workspace reload failed");
	});

	expect(result.applied).toEqual([result.target, result.source]);
	expect(result.sessionManager.getSessionFile()).toBe(result.originalFile);
	expect(result.errors.some(message => message.includes("workspace reload failed"))).toBe(true);
	expect(result.shutdowns).toBe(1);
});
