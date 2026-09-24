import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import type { FileEntry } from "./session-entries";
import { loadSessionFile, sessionArchivePath, visitEntriesFromFile } from "./session-loader";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function createArchivedSession(activePadding = ""): {
	file: string;
	archivedLine: string;
	archivedEntry: Record<string, unknown>;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-archive-parse-once-"));
	tempDirs.push(dir);
	const file = path.join(dir, "session.jsonl");
	const active = [
		{ type: "session", version: 3, id: "session-id", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir },
		{ type: "session_init", id: "init-id", task: "active init", tools: [] },
		...(activePadding ? [{ type: "message", id: "padding-id", parentId: "init-id", padding: activePadding }] : []),
	];
	fs.writeFileSync(file, `${active.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	const archivedEntry = {
		type: "message",
		id: "archived-id",
		parentId: "init-id",
		timestamp: 1,
		content: "archived",
	};
	const archivedLine = JSON.stringify(archivedEntry);
	const records = [{ id: "archived-id", beforeId: "init-id", line: archivedLine }];
	fs.writeFileSync(
		sessionArchivePath(file),
		gzipSync(JSON.stringify({ version: 1, sessionId: "session-id", sessionFile: file, records })).toString("base64"),
	);
	return { file, archivedLine, archivedEntry };
}

function countRecordParses(archivedLine: string): { calls: number[]; restore: () => void } {
	const original = JSON.parse;
	const calls: number[] = [];
	const spy = spyOn(JSON, "parse").mockImplementation(
		(text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
			if (text === archivedLine) calls.push(1);
			return original(text, reviver);
		},
	);
	return { calls, restore: () => spy.mockRestore() };
}

test("archive entry lines are parsed once while loading and hydrating a session", async () => {
	const { file, archivedLine, archivedEntry } = createArchivedSession();
	const counted = countRecordParses(archivedLine);
	try {
		const first = await loadSessionFile(file);
		expect(counted.calls).toHaveLength(1);
		expect(first.entries).toContainEqual(archivedEntry as unknown as FileEntry);
		expect(JSON.stringify(first.entries)).toBe(
			JSON.stringify([
				{
					type: "session",
					version: 3,
					id: "session-id",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: path.dirname(file),
				},
				archivedEntry,
				{ type: "session_init", id: "init-id", task: "active init", tools: [] },
			]),
		);

		counted.calls.length = 0;
		await loadSessionFile(file);
		expect(counted.calls).toHaveLength(1);
	} finally {
		counted.restore();
	}
});

test("streamed archive visitation parses each record line once", async () => {
	const { file, archivedLine } = createArchivedSession("x".repeat(33 * 1024 * 1024));
	const counted = countRecordParses(archivedLine);
	try {
		const visited: string[] = [];
		await visitEntriesFromFile(file, entry => {
			if (typeof entry.id === "string") visited.push(entry.id);
		});
		expect(visited).toEqual(["session-id", "archived-id", "init-id", "padding-id"]);
		expect(counted.calls).toHaveLength(1);
	} finally {
		counted.restore();
	}
});
