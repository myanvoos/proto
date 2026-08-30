import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listSessions } from "./session-listing";
import { createSessionLiveHeartbeat } from "./session-liveness";
import { FileSessionStorage } from "./session-storage";

function writeSessionFile(dir: string, name: string, id: string): string {
	const file = path.join(dir, name);
	fs.writeFileSync(
		file,
		`${JSON.stringify({ type: "session", id, cwd: dir, timestamp: new Date().toISOString() })}\n`,
		{
			encoding: "utf8",
		},
	);
	return file;
}

describe("session listing liveness flags", () => {
	test("listSessions reports live markers even when the scan cache would hit", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-listing-"));
		const file = writeSessionFile(dir, "abc_session1.jsonl", "session1");
		const storage = new FileSessionStorage();

		const before = await listSessions(dir, storage);
		expect(before[0]?.liveOpen ?? false).toBe(false);
		expect(before[0]?.liveStreaming ?? false).toBe(false);

		const heartbeat = createSessionLiveHeartbeat(file);
		try {
			// The session file's mtime/size never change, so these hits go through the scan
			// cache: liveness must be recomputed per scan, not cached with the file data.
			const open = await listSessions(dir, storage);
			expect(open[0]?.liveOpen).toBe(true);
			expect(open[0]?.liveStreaming).toBe(false);

			heartbeat?.setStreaming(true);
			const streaming = await listSessions(dir, storage);
			expect(streaming[0]?.liveOpen).toBe(true);
			expect(streaming[0]?.liveStreaming).toBe(true);
		} finally {
			heartbeat?.dispose();
		}

		const after = await listSessions(dir, storage);
		expect(after[0]?.liveOpen ?? false).toBe(false);
		expect(after[0]?.liveStreaming ?? false).toBe(false);
	});
});
