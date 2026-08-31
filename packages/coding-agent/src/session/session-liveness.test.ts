import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createSessionLiveHeartbeat,
	getSessionLivePath,
	readSessionLiveState,
	SESSION_LIVE_FRESH_WINDOW_MS,
} from "./session-liveness";

function makeTempSession(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-live-"));
	const file = path.join(dir, "session.jsonl");
	fs.writeFileSync(file, "", { encoding: "utf8" });
	return file;
}

describe("session liveness markers", () => {
	test("heartbeat writes a fresh marker and streaming flips are visible to readers", () => {
		const file = makeTempSession();
		const heartbeat = createSessionLiveHeartbeat(file);
		expect(heartbeat).toBeDefined();
		try {
			const initial = readSessionLiveState(file);
			expect(initial.fresh).toBe(true);
			expect(initial.streaming).toBe(false);
			expect(initial.pid).toBe(process.pid);

			heartbeat?.setStreaming(true);
			const streaming = readSessionLiveState(file);
			expect(streaming.fresh).toBe(true);
			expect(streaming.streaming).toBe(true);
		} finally {
			heartbeat?.dispose();
		}
		expect(readSessionLiveState(file).fresh).toBe(false);
	});

	test("marker without a heartbeat file reads as not live", () => {
		const file = makeTempSession();
		expect(readSessionLiveState(file)).toEqual({ fresh: false, streaming: false, pid: undefined });
	});

	test("stale markers read as not live", () => {
		const file = makeTempSession();
		writeSessionLiveMarkerForTest(file, true, process.pid);
		const stale = Date.now() - SESSION_LIVE_FRESH_WINDOW_MS - 1_000;
		fs.utimesSync(getSessionLivePath(file), new Date(stale), new Date(stale));
		expect(readSessionLiveState(file).fresh).toBe(false);
	});

	test("unparseable marker content stays fresh but reports no streaming state", () => {
		const file = makeTempSession();
		fs.writeFileSync(getSessionLivePath(file), "torn write", { encoding: "utf8" });
		const state = readSessionLiveState(file);
		expect(state.fresh).toBe(true);
		expect(state.streaming).toBe(false);
		expect(state.pid).toBeUndefined();
	});

	test("createSessionLiveHeartbeat skips in-memory sessions", () => {
		expect(createSessionLiveHeartbeat(null)).toBeUndefined();
		expect(createSessionLiveHeartbeat(undefined)).toBeUndefined();
	});
});

function writeSessionLiveMarkerForTest(sessionFile: string, streaming: boolean, pid: number): void {
	fs.writeFileSync(getSessionLivePath(sessionFile), JSON.stringify({ pid, streaming, at: Date.now() }), {
		encoding: "utf8",
		mode: 0o600,
	});
}
