import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSessionManager } from "../main";
import { CURRENT_SESSION_VERSION } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import { parseArgs } from "./args";

test.each(["path", "id", "continue"] as const)("--no-session resumes %s without enabling persistence", async mode => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "proto-no-session-resume-"));
	const id = "00000000-0000-4000-8000-000000000077";
	const file = path.join(cwd, "saved.jsonl");
	const source = [
		JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id,
			cwd,
			timestamp: "2026-09-22T00:00:00.000Z",
		}),
		JSON.stringify({
			type: "message",
			id: "message-one",
			parentId: null,
			timestamp: "2026-09-22T00:00:00.000Z",
			message: { role: "user", content: "STARTUP_RESUMED_HISTORY", timestamp: 1 },
		}),
		"",
	].join("\n");
	await Bun.write(file, source);
	let manager: SessionManager | undefined;
	try {
		const flags = mode === "continue" ? ["--continue"] : ["--resume", mode === "path" ? file : id];
		manager = await createSessionManager(parseArgs(["--no-session", "--session-dir", cwd, ...flags]), cwd);
		expect(manager).toBeDefined();
		expect(manager?.getSessionId()).toBe(id);
		expect(manager?.getSessionFile()).toBeUndefined();
		expect(manager?.getCwd()).toBe(cwd);
		expect(JSON.stringify(manager?.buildSessionContext({ transcript: true }).messages)).toContain(
			"STARTUP_RESUMED_HISTORY",
		);
		manager?.appendMessage({ role: "user", content: "UNSAVED_STARTUP_CONTINUATION", timestamp: 2 });
		await manager?.flush();
		await manager?.close();
		expect(await Bun.file(file).text()).toBe(source);
		expect(await fs.readdir(cwd)).toEqual(["saved.jsonl"]);
	} finally {
		await manager?.close();
		await fs.rm(cwd, { recursive: true, force: true });
	}
});
