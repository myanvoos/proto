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

	test("listSessions reports every concurrently streaming daemon session", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-listing-daemons-"));
		const files = [
			writeSessionFile(dir, "daemon_a.jsonl", "daemon-a"),
			writeSessionFile(dir, "daemon_b.jsonl", "daemon-b"),
		];
		const moduleUrl = JSON.stringify(new URL("./session-liveness.ts", import.meta.url).href);
		const source = `
import { createSessionLiveHeartbeat } from ${moduleUrl};
const heartbeat = createSessionLiveHeartbeat(process.env.PROTO_TEST_SESSION_FILE);
heartbeat?.setStreaming(true);
process.stdout.write("ready\\n");
// This integration test needs each child process alive while the parent lists its marker.
setInterval(() => {}, 1000);
`;
		const children = files.map(file =>
			Bun.spawn([process.execPath, "-e", source], {
				env: { ...Bun.env, PROTO_TEST_SESSION_FILE: file },
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		const waitForReady = async (child: Bun.Subprocess): Promise<void> => {
			const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
			let output = "";
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error(`daemon child exited before ready: ${output}`);
				output += new TextDecoder().decode(chunk.value);
				if (output.includes("ready\n")) return;
			}
		};
		try {
			await Promise.all(children.map(waitForReady));
			const sessions = await listSessions(dir, new FileSessionStorage());
			expect(
				sessions
					.filter(session => session.liveStreaming === true)
					.map(session => session.id)
					.sort(),
			).toEqual(["daemon-a", "daemon-b"]);
		} finally {
			for (const child of children) child.kill();
			await Promise.all(children.map(child => child.exited));
		}
	});
});
