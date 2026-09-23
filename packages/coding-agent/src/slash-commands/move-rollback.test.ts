import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import { SessionManager, type SessionManagerStateSnapshot } from "../session/session-manager";
import { executeAcpBuiltinSlashCommand } from "./acp-builtins";
import type { SlashCommandRuntime } from "./types";

const tempDirs: string[] = [];
const launchDir = getProjectDir();

afterEach(() => {
	setProjectDir(launchDir);
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

async function headlessMove(reloadFails: (cwd: string) => boolean) {
	const source = tempDir("proto-headless-move-source-");
	const target = tempDir("proto-headless-move-target-");
	const sourceStore = tempDir("proto-headless-move-source-store-");
	const targetStore = tempDir("proto-headless-move-target-store-");
	setProjectDir(source);
	const sessionManager = SessionManager.create(source, sourceStore);
	sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	await sessionManager.ensureOnDisk();
	await sessionManager.flush();
	const originalFile = sessionManager.getSessionFile()!;
	const settings = Settings.isolated({});
	spyOn(settings, "reloadForCwd").mockImplementation(async cwd => {
		if (reloadFails(cwd)) throw new Error(`settings reload failed in ${cwd}`);
	});
	const output: string[] = [];
	let disposed = 0;
	const session = {
		isStreaming: false,
		moveSession: (cwd: string) => sessionManager.moveTo(cwd, targetStore),
		rollbackMove: (snapshot: SessionManagerStateSnapshot) => sessionManager.rollbackMove(snapshot),
		dispose: async () => {
			disposed++;
		},
	} as unknown as AgentSession;
	const runtime: SlashCommandRuntime = {
		session,
		sessionManager,
		settings,
		cwd: source,
		output: text => {
			output.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	};
	const result = await executeAcpBuiltinSlashCommand(`/move ${target}`, runtime);
	const processCwd = getProjectDir();
	await sessionManager.close();
	return { source, target, sessionManager, originalFile, output, disposed, result, processCwd };
}

test("a headless /move whose workspace cannot follow moves session and process back", async () => {
	let target: string | undefined;
	const moved = await headlessMove(cwd => {
		target ??= cwd;
		return cwd === target;
	});

	expect(moved.result).toEqual({ consumed: true });
	expect(moved.sessionManager.getSessionFile()).toBe(moved.originalFile);
	expect(moved.sessionManager.getCwd()).toBe(moved.source);
	expect(moved.processCwd).toBe(moved.source);
	expect(moved.output).toEqual([`Move failed: settings reload failed in ${moved.target}`]);
	expect(moved.disposed).toBe(0);
});

test("a headless /move that cannot re-align any workspace closes the session", async () => {
	const moved = await headlessMove(() => true);

	expect(moved.result).toEqual({ consumed: true });
	expect(moved.disposed).toBe(1);
	expect(moved.output.some(text => text.includes("failed to re-align workspace"))).toBe(true);
});
