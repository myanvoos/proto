import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { sessionArchivePath, visitEntriesFromFile } from "./session-loader";
import { SessionManager } from "./session-manager";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("streamed visitation ignores invalid archive records and keeps active session rows", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-stream-archive-"));
	tempDirs.push(dir);
	const file = path.join(dir, "session.jsonl");
	const active = [
		{ type: "session", version: 3, id: "session-id", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir },
		{ type: "session_init", id: "init-id", task: "active init", tools: [] },
		{ type: "message", id: "large-id", parentId: "init-id", timestamp: 1, padding: "x".repeat(33 * 1024 * 1024) },
	];
	fs.writeFileSync(file, `${active.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	const records = [
		{ id: "bad-json", beforeId: "init-id", line: "{" },
		{ id: "wrong-id", beforeId: "init-id", line: JSON.stringify({ type: "message", id: "other-id" }) },
		{ id: "dangling", beforeId: "missing-active-id", line: JSON.stringify({ type: "message", id: "dangling" }) },
	];
	fs.writeFileSync(
		sessionArchivePath(file),
		gzipSync(JSON.stringify({ version: 1, sessionId: "session-id", sessionFile: file, records })).toString("base64"),
	);

	const visited: string[] = [];
	await expect(
		visitEntriesFromFile(file, entry => {
			if (typeof entry.id === "string") visited.push(entry.id);
		}),
	).resolves.toBeUndefined();
	expect(visited).toEqual(active.map(entry => entry.id));
	expect(await SessionManager.peekSessionInit(file)).toMatchObject({ cwd: dir, init: { task: "active init" } });
});
