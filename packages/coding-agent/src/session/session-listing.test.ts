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

test("listSessions counts and searches messages beyond the prefix window", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-listing-full-transcript-"));
	try {
		const sessionFile = path.join(dir, "long_session.jsonl");
		const records = [
			{
				type: "session",
				id: "long-session",
				cwd: dir,
				timestamp: "2026-09-19T00:00:00.000Z",
			},
			{
				type: "message",
				id: "large-first-message",
				parentId: null,
				timestamp: "2026-09-19T00:00:01.000Z",
				message: { role: "user", content: "x".repeat(5_000), timestamp: 0 },
			},
			{
				type: "message",
				id: "message-after-prefix",
				parentId: "large-first-message",
				timestamp: "2026-09-19T00:00:02.000Z",
				message: { role: "assistant", content: "unique-search-text-after-prefix", timestamp: 1 },
			},
		];
		await Bun.write(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);

		const [session] = await listSessions(dir, new FileSessionStorage());
		expect(session?.messageCount).toBe(2);
		expect(session?.allMessagesText).toContain("unique-search-text-after-prefix");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("session listing incremental rescan", () => {
	function messageLine(text: string): string {
		const message = { role: "user", content: text, timestamp: new Date().toISOString() };
		return `${JSON.stringify({ type: "message", message })}\n`;
	}

	test("appending messages updates the count and search text without losing earlier messages", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-listing-append-"));
		const file = writeSessionFile(dir, "abc_append.jsonl", "append1");
		const storage = new FileSessionStorage();
		fs.appendFileSync(file, messageLine("first question"));

		const initial = await listSessions(dir, storage);
		expect(initial[0]?.messageCount).toBe(1);

		fs.appendFileSync(file, messageLine("second question"));
		fs.appendFileSync(file, messageLine("third question"));
		const grown = await listSessions(dir, storage);

		expect(grown[0]?.messageCount).toBe(3);
		expect(grown[0]?.allMessagesText).toContain("first question");
		expect(grown[0]?.allMessagesText).toContain("third question");
		expect(grown[0]?.firstMessage).toBe("first question");
	});

	test("a rewritten file is rescanned instead of folded as an append", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-listing-rewrite-"));
		const file = writeSessionFile(dir, "abc_rewrite.jsonl", "rewrite1");
		const storage = new FileSessionStorage();
		const header = fs.readFileSync(file, "utf8");
		for (let i = 0; i < 5; i++) fs.appendFileSync(file, messageLine(`original ${i}`));

		const before = await listSessions(dir, storage);
		expect(before[0]?.messageCount).toBe(5);
		const originalSize = fs.statSync(file).size;

		const replacement = "compacted ".repeat(400);
		fs.writeFileSync(file, header + messageLine(replacement) + messageLine(`${replacement}tail`), "utf8");
		expect(fs.statSync(file).size).toBeGreaterThan(originalSize);

		const after = await listSessions(dir, storage);
		expect(after[0]?.messageCount).toBe(2);
		expect(after[0]?.allMessagesText).not.toContain("original 0");
		expect(after[0]?.allMessagesText).toContain("compacted");
	});

	test("a truncated file is rescanned rather than reported with stale counts", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-listing-truncate-"));
		const file = writeSessionFile(dir, "abc_truncate.jsonl", "truncate1");
		const storage = new FileSessionStorage();
		const header = fs.readFileSync(file, "utf8");
		for (let i = 0; i < 6; i++) fs.appendFileSync(file, messageLine(`entry ${i}`));
		expect((await listSessions(dir, storage))[0]?.messageCount).toBe(6);

		fs.writeFileSync(file, header + messageLine("entry 0"), "utf8");
		const after = await listSessions(dir, storage);

		expect(after[0]?.messageCount).toBe(1);
		expect(after[0]?.allMessagesText).not.toContain("entry 5");
	});
});
