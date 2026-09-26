import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TRANSCRIPT_WINDOW_BYTES, TRANSCRIPT_WINDOW_MESSAGES } from "../utils/transcript-window";
import { readTranscriptAfter, readTranscriptBefore, readTranscriptTail } from "./transcript-file-window";

test("includes a group exactly on the soft-byte tail boundary", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proto-transcript-window-"));
	try {
		const sessionFile = path.join(directory, "session.jsonl");
		const recordBytes = 8192;
		const records: string[] = [];
		for (let index = 0; index < 300; index++) {
			const base = JSON.stringify({ type: "message", message: { role: "user", content: `row-${index}` }, pad: "" });
			const padLength = recordBytes - 1 - Buffer.byteLength(base);
			const record = JSON.stringify({
				type: "message",
				message: { role: "user", content: `row-${index}` },
				pad: "x".repeat(padLength),
			});
			expect(Buffer.byteLength(record)).toBe(recordBytes - 1);
			records.push(record);
		}
		fs.writeFileSync(sessionFile, `${records.join("\n")}\n`);
		const size = fs.statSync(sessionFile).size;
		const window = readTranscriptTail(sessionFile, size, TRANSCRIPT_WINDOW_BYTES, TRANSCRIPT_WINDOW_MESSAGES);
		const rows = window.records.flatMap(record => record.text?.match(/row-\d+/gu) ?? []);
		expect(window.start).toBe(44 * recordBytes);
		expect(rows.length).toBe(TRANSCRIPT_WINDOW_MESSAGES);
		expect(rows[0]).toBe("row-44");
		expect(rows.at(-1)).toBe("row-299");
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("oversized groups keep navigable disk intervals without admitting their payload", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proto-transcript-oversized-"));
	try {
		const file = path.join(directory, "session.jsonl");
		const first = `${JSON.stringify({ type: "message", message: { role: "user", content: "first" } })}\n`;
		const huge = `${JSON.stringify({ type: "message", message: { role: "assistant", content: "界".repeat(100_000) } })}\n`;
		const last = `${JSON.stringify({ type: "message", message: { role: "user", content: "last" } })}\n`;
		await Bun.write(file, `${first + huge + last}{"unfinished":`);
		const latest = readTranscriptTail(file, fs.statSync(file).size, 4096, 32);
		expect(latest.records.map(record => record.text)).toEqual([last]);
		const omitted = readTranscriptBefore(file, latest.start, 4096, 32);
		expect(omitted.records).toEqual([{ start: Buffer.byteLength(first), end: latest.start }]);
		const earliest = readTranscriptBefore(file, omitted.start, 4096, 32);
		expect(earliest.records.map(record => record.text)).toEqual([first]);
		const forward = readTranscriptAfter(file, earliest.end, fs.statSync(file).size, 4096, 32);
		expect(forward).toEqual(omitted);
		expect(readTranscriptAfter(file, forward.end, fs.statSync(file).size, 4096, 32)).toEqual(latest);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("a single tool group cannot bypass record admission with thousands of tiny results", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proto-transcript-tool-group-"));
	try {
		const file = path.join(directory, "session.jsonl");
		const records = [
			{ type: "message", message: { role: "assistant", content: [] } },
			...Array.from({ length: 1000 }, () => ({ type: "message", message: { role: "toolResult", content: [] } })),
		];
		await Bun.write(file, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		for (const window of [
			readTranscriptTail(file, fs.statSync(file).size, 1024 * 1024, 16),
			readTranscriptAfter(file, 0, fs.statSync(file).size, 1024 * 1024, 16),
		]) {
			expect(window.records).toEqual([{ start: 0, end: fs.statSync(file).size }]);
		}
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("one small JSON record cannot expand into thousands of rich tool cards", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proto-transcript-card-fanout-"));
	try {
		const file = path.join(directory, "session.jsonl");
		await Bun.write(
			file,
			`${JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: Array.from({ length: 1000 }, (_, index) => ({
						type: "toolCall",
						id: String(index),
						name: "read",
						arguments: {},
					})),
				},
			})}\n`,
		);
		const size = fs.statSync(file).size;
		expect(size).toBeLessThan(1024 * 1024);
		expect(readTranscriptTail(file, size, 1024 * 1024, 256).records).toEqual([{ start: 0, end: size }]);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
