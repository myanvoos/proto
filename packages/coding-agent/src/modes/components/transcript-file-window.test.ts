import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TRANSCRIPT_WINDOW_SOFT_BYTES, TRANSCRIPT_WINDOW_SOFT_MESSAGES } from "../utils/transcript-window";
import { readTranscriptTail } from "./transcript-file-window";

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
		const window = readTranscriptTail(
			sessionFile,
			size,
			TRANSCRIPT_WINDOW_SOFT_BYTES,
			TRANSCRIPT_WINDOW_SOFT_MESSAGES,
		);
		const rows = window.text.match(/row-\d+/gu) ?? [];
		expect(window.start).toBe(44 * recordBytes);
		expect(rows.length).toBe(TRANSCRIPT_WINDOW_SOFT_MESSAGES);
		expect(rows[0]).toBe("row-44");
		expect(rows.at(-1)).toBe("row-299");
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
