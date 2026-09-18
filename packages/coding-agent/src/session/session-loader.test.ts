import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadEntriesFromFileStream, parseSessionContent } from "./session-loader";

test("stream loading distinguishes a malformed complete record from a torn final record", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-stream-session-load-"));
	try {
		const completeFile = path.join(dir, "complete.jsonl");
		await Bun.write(completeFile, '{"type":"session","id":"complete"}\n{broken}\n');
		const complete = await loadEntriesFromFileStream(completeFile);
		expect(complete.entries.map(entry => entry.type)).toEqual(["session"]);
		expect(complete.malformedRecords).toBe(1);
		expect(complete.malformedCompleteRecords).toBe(1);

		const tornFile = path.join(dir, "torn.jsonl");
		await Bun.write(tornFile, '{"type":"session","id":"torn"}\n{broken');
		const torn = await loadEntriesFromFileStream(tornFile);
		expect(torn.entries.map(entry => entry.type)).toEqual(["session"]);
		expect(torn.malformedRecords).toBe(1);
		expect(torn.malformedCompleteRecords).toBe(0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("large streamed resumes preserve every message exactly across parse batches", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-stream-session-batches-"));
	try {
		const file = path.join(dir, "large.jsonl");
		const records: unknown[] = [
			{ type: "session", version: 3, id: "large", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
		];
		for (let index = 0; index < 2_000; index++) {
			records.push({
				type: "message",
				id: `entry-${index}`,
				parentId: index === 0 ? null : `entry-${index - 1}`,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: {
					role: index % 2 === 0 ? "user" : "developer",
					content: [{ type: "text", text: `${index}: λ界🙂 ${"payload ".repeat(80)}` }],
					timestamp: index,
				},
			});
		}
		const content = `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
		await Bun.write(file, content);

		const streamed = await loadEntriesFromFileStream(file);
		const fullText = parseSessionContent(content);
		expect(streamed).toEqual(fullText);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
