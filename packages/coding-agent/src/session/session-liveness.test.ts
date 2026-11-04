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

	test("fresh marker stops reporting live as soon as its owner process exits", async () => {
		const file = makeTempSession();
		const moduleUrl = JSON.stringify(new URL("./session-liveness.ts", import.meta.url).href);
		const source = `
import { createSessionLiveHeartbeat } from ${moduleUrl};
createSessionLiveHeartbeat(process.env.PROTO_TEST_SESSION_FILE);
`;
		const child = Bun.spawn([process.execPath, "-e", source], {
			env: { ...Bun.env, PROTO_TEST_SESSION_FILE: file },
			stdout: "ignore",
			stderr: "pipe",
		});

		expect(await child.exited).toBe(0);
		const marker = JSON.parse(fs.readFileSync(getSessionLivePath(file), "utf8")) as { pid?: unknown };
		expect(marker.pid).toBe(child.pid);
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

test("a live selecting process can hand ownership to its host without leaving a blocking heartbeat", async () => {
	const sessionFile = makeTempSession();
	const moduleUrl = JSON.stringify(new URL("./session-liveness.ts", import.meta.url).href);
	const contenderSource = `import { claimSessionOwnership, releaseSessionOwnership } from ${moduleUrl};
const accepted = claimSessionOwnership(process.argv[1]);
releaseSessionOwnership({ removeMarker: true });
process.stdout.write(String(accepted));`;
	const selectingSource = `import { claimSessionOwnership, releaseSessionOwnership } from ${moduleUrl};
if (!claimSessionOwnership(process.argv[1])) throw new Error("selection did not own session");
releaseSessionOwnership({ removeMarker: true });
const child = Bun.spawnSync([process.execPath, "-e", ${JSON.stringify(contenderSource)}, process.argv[1]], { stdout: "pipe", stderr: "pipe" });
process.stdout.write(child.stdout);
process.stderr.write(child.stderr);
process.exitCode = child.exitCode;`;
	try {
		const child = Bun.spawn([process.execPath, "-e", selectingSource, sessionFile], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [output, errors, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ code, errors, output }).toEqual({ code: 0, errors: "", output: "true" });
		expect(readSessionLiveState(sessionFile).fresh).toBe(false);
	} finally {
		await fs.promises.rm(path.dirname(sessionFile), { recursive: true, force: true });
	}
});
