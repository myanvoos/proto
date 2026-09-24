import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { findMostRecentNonEmptySession, getRecentSessions, listSessions } from "./session-listing";
import { FileSessionStorage } from "./session-storage";

function archiveText(sessionId: string, sessionFile: string, entries: unknown[]): string {
	return Buffer.from(
		gzipSync(
			JSON.stringify({
				version: 1,
				sessionId,
				sessionFile,
				records: entries.map((entry, index) => ({
					id: `archived-${index}`,
					beforeId: index === 0 ? null : `archived-${index - 1}`,
					line: JSON.stringify(entry),
				})),
			}),
		),
	).toString("base64");
}

async function makeSession(): Promise<{ dir: string; file: string; storage: FileSessionStorage }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-listing-archive-"));
	const file = path.join(dir, "session_archived-session.jsonl");
	await Bun.write(
		file,
		`${JSON.stringify({ type: "session", id: "archived-session", cwd: dir, timestamp: "2026-09-01T00:00:00.000Z" })}\n`,
	);
	return { dir, file, storage: new FileSessionStorage() };
}

describe("session listing archived metadata", () => {
	test("discovers a title-less session whose messages exist only in its archive", async () => {
		const { dir, file, storage } = await makeSession();
		try {
			const user = {
				type: "message",
				id: "archived-0",
				message: { role: "user", content: "archived prompt", timestamp: 0 },
			};
			const assistant = {
				type: "message",
				id: "archived-1",
				message: { role: "assistant", content: "archived reply", timestamp: 1 },
			};
			await Bun.write(`${file}.archive.jsonl.gz`, archiveText("archived-session", file, [user, assistant]));

			expect(await findMostRecentNonEmptySession(dir, storage)).toBe(file);
			expect((await getRecentSessions(dir, 1, storage))[0]?.name).toBe("archived prompt");
			const listed = (await listSessions(dir, storage))[0];
			expect(listed?.firstMessage).toBe("archived prompt");
			expect(listed?.messageCount).toBe(2);
			expect(listed?.assistantTurns).toBe(1);
			expect(listed?.allMessagesText).toContain("archived reply");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("ignores malformed archive and retains empty-session discovery behavior", async () => {
		const { dir, file, storage } = await makeSession();
		try {
			await Bun.write(`${file}.archive.jsonl.gz`, "not base64 gzip");
			expect(await findMostRecentNonEmptySession(dir, storage)).toBeNull();
			expect(await getRecentSessions(dir, 1, storage)).toEqual([]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("does not read archives for a healthy active session", async () => {
		const { dir, file, storage } = await makeSession();
		try {
			const rows = [
				{ type: "session", id: "archived-session", cwd: dir, timestamp: "2026-09-01T00:00:00.000Z" },
				{ type: "message", id: "active-user", message: { role: "user", content: "active prompt", timestamp: 0 } },
			];
			await Bun.write(file, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
			await Bun.write(`${file}.archive.jsonl.gz`, "not base64 gzip");
			const readText = storage.readText.bind(storage);
			let archiveReads = 0;
			storage.readText = async (readPath: string) => {
				if (readPath.endsWith(".archive.jsonl.gz")) archiveReads++;
				return readText(readPath);
			};

			expect((await listSessions(dir, storage))[0]?.firstMessage).toBe("active prompt");
			expect(archiveReads).toBe(0);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
