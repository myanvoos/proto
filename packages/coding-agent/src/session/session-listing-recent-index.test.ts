import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getHistoryDbPath } from "@oh-my-pi/pi-utils";
import { recordSessionTitle } from "./session-index";
import { getRecentSessions } from "./session-listing";
import { FileSessionStorage } from "./session-storage";

class CountingFileSessionStorage extends FileSessionStorage {
	readTextSlicesCalls = 0;
	readTextRangeCalls = 0;

	override readTextSlices(file: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		this.readTextSlicesCalls++;
		return super.readTextSlices(file, prefixBytes, suffixBytes);
	}

	override readTextRange(file: string, start: number, end: number): Promise<string> {
		this.readTextRangeCalls++;
		return super.readTextRange(file, start, end);
	}
}

function writeSessionFile(dir: string, name: string, id: string): string {
	const file = path.join(dir, name);
	fs.writeFileSync(
		file,
		`${JSON.stringify({ type: "session", id, cwd: dir, timestamp: new Date().toISOString() })}\n`,
	);
	return file;
}

function deleteIndexedTitles(ids: string[]): void {
	const db = new Database(getHistoryDbPath());
	try {
		const statement = db.prepare("DELETE FROM session_titles WHERE session_id = ?");
		for (const id of ids) statement.run(id);
	} finally {
		db.close();
	}
}

test("getRecentSessions opens only the bounded newest candidates when title rows are populated", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-recent-index-bound-"));
	const ids: string[] = [];
	try {
		const newest = Date.now();
		for (let i = 0; i < 20; i++) {
			const id = `recent-bound-${crypto.randomUUID()}-${i}`;
			ids.push(id);
			const file = writeSessionFile(dir, `session_${id}.jsonl`, id);
			fs.appendFileSync(
				file,
				`${JSON.stringify({ type: "message", message: { role: "user", content: `prompt-${i}` } })}\n`,
			);
			fs.utimesSync(file, new Date(newest - i * 1000), new Date(newest - i * 1000));
			if (i < 12) recordSessionTitle(id, `Indexed title ${i}`);
		}

		const storage = new CountingFileSessionStorage();
		const recent = await getRecentSessions(dir, 4, storage);
		expect(recent.map(entry => path.basename(entry.path))).toEqual([0, 1, 2, 3].map(i => `session_${ids[i]}.jsonl`));
		expect(recent.map(entry => entry.name)).toEqual([
			"Indexed title 0",
			"Indexed title 1",
			"Indexed title 2",
			"Indexed title 3",
		]);
		expect(storage.readTextSlicesCalls + storage.readTextRangeCalls).toBe(0);
	} finally {
		deleteIndexedTitles(ids);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("getRecentSessions falls back to the full ordered scan when title rows cannot fill the limit", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-recent-index-fallback-"));
	const ids: string[] = [];
	try {
		const newest = Date.now();
		for (let i = 0; i < 14; i++) {
			const id = `recent-fallback-${crypto.randomUUID()}-${i}`;
			ids.push(id);
			const file = writeSessionFile(dir, `session_${id}.jsonl`, id);
			if (i === 0) {
				recordSessionTitle(id, "Indexed newest");
			} else if (i === 13) {
				fs.appendFileSync(
					file,
					`${JSON.stringify({ type: "message", message: { role: "user", content: "older usable" } })}\n`,
				);
			}
			fs.utimesSync(file, new Date(newest - i * 1000), new Date(newest - i * 1000));
		}

		const recent = await getRecentSessions(dir, 2, new CountingFileSessionStorage());
		expect(recent.map(entry => entry.name)).toEqual(["Indexed newest", "older usable"]);
		expect(recent.map(entry => path.basename(entry.path))).toEqual([
			`session_${ids[0]}.jsonl`,
			`session_${ids[13]}.jsonl`,
		]);
	} finally {
		deleteIndexedTitles(ids);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
