import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, TempDir } from "@oh-my-pi/pi-utils";
import { DaemonLog, readDaemonLogChunks } from "./broker";
import { createDaemonBrokerClient } from "./client";
import type { DaemonRpcResult } from "./protocol";

const MIB = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

test("stalled log storage bounds retained output and reports the ordered UTF-8 byte gap before resuming", async () => {
	await using dir = await TempDir.create("@proto-daemon-log-stall-");
	const file = Bun.file(dir.join("output.log"));
	const sink = file.writer();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<number>();
	let writes = 0;
	let flushed = false;
	const log = new DaemonLog(dir.join("output.log"), dir.join("output.previous.log"), file, {
		async write(chunk) {
			writes++;
			if (writes === 1) {
				started.resolve();
				await release.promise;
			}
			return sink.write(chunk);
		},
		flush() {
			flushed = true;
			return sink.flush();
		},
		end: () => sink.end(),
	});
	try {
		log.append("prefix\n");
		await started.promise;
		// A partly admitted multi-byte character cannot corrupt the saved prefix or the omitted-byte count.
		const flood = "🙂".repeat(MIB);
		for (let index = 0; index < 8; index++) log.append(flood);
		expect(writes).toBe(1);
		expect(flushed).toBe(false);
		release.resolve(0);
		await log.readTail(32 * MIB);
		log.append("\nresumed\n");
		await log.close();
		const text = await file.text();
		const prefixBytes = Buffer.byteLength("prefix\n");
		const keptFloodBytes = Math.floor((MIB - prefixBytes) / 4) * 4;
		const omitted = 32 * MIB - keptFloodBytes;
		expect(text).toBe(
			`prefix\n${"🙂".repeat(keptFloodBytes / 4)}\n[daemon log truncated: ${omitted} output bytes omitted while storage was backlogged]\n\nresumed\n`,
		);
		expect(writes).toBe(4);
	} finally {
		release.resolve(0);
		await log.close();
	}
});

test("a stalled flush does not enqueue later writes or hold up a producer pipe", async () => {
	await using dir = await TempDir.create("@proto-daemon-log-pipe-");
	const file = Bun.file(dir.join("output.log"));
	const sink = file.writer();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let writtenBytes = 0;
	let flushes = 0;
	const log = new DaemonLog(dir.join("output.log"), dir.join("output.previous.log"), file, {
		write(chunk) {
			writtenBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
			return sink.write(chunk);
		},
		async flush() {
			if (++flushes === 1) {
				started.resolve();
				await release.promise;
			}
			return sink.flush();
		},
		end: () => sink.end(),
	});
	const producer = Bun.spawn(
		[
			process.execPath,
			"-e",
			'import { writeSync } from "node:fs"; const chunk = Buffer.alloc(65536, "x"); for (let n = 0; n < 256; n++) writeSync(1, chunk);',
		],
		{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
	);
	try {
		log.append("prefix\n");
		await started.promise;
		let received = 0;
		for await (const chunk of producer.stdout) {
			received += chunk.byteLength;
			log.append(new TextDecoder().decode(chunk));
		}
		expect(await producer.exited).toBe(0);
		expect(received).toBe(16 * MIB);
		expect(writtenBytes).toBe(Buffer.byteLength("prefix\n"));
		release.resolve();
		await log.close();
		const text = await file.text();
		expect(text).toContain(`[daemon log truncated: ${received + 7 - MIB} output bytes omitted`);
		expect(Buffer.byteLength(text.slice(0, text.indexOf("\n[daemon log truncated:")))).toBe(MIB);
	} finally {
		release.resolve();
		producer.kill();
		await producer.exited;
		await log.close();
	}
}, 10_000);

test("incremental detached reads preserve UTF-8 across byte windows and separate polling snapshots", async () => {
	await using dir = await TempDir.create("@proto-daemon-log-chunks-");
	const file = Bun.file(dir.join("output.log"));
	const prefix = "x".repeat(CHUNK_BYTES - 1);
	const content = Buffer.from(`${prefix}🙂READY\n${"y".repeat(4 * MIB)}界`);
	await Bun.write(file, content);
	const decoder = new TextDecoder();
	let lastOffset = 0;
	let calls = 0;
	let marker = "";
	let chars = 0;
	const consume = (text: string, offset: number): boolean => {
		expect(offset - lastOffset).toBeLessThanOrEqual(CHUNK_BYTES);
		expect(text.length).toBeLessThanOrEqual(CHUNK_BYTES);
		expect(text).not.toContain("�");
		if (calls < 2 || offset === content.byteLength) marker += text.replace(/[xy]/g, "");
		lastOffset = offset;
		chars += text.length;
		calls++;
		return true;
	};
	await readDaemonLogChunks(file, 0, content.byteLength - 1, decoder, consume);
	await readDaemonLogChunks(file, lastOffset, content.byteLength, decoder, consume);
	expect(lastOffset).toBe(content.byteLength);
	expect(calls).toBeGreaterThan(64);
	expect(chars).toBe(content.toString().length);
	expect(marker).toBe("🙂READY\n界");
	expect(decoder.decode()).toBe("");
});

test("follow after overflow and disk rotation never replays the gap or a previous generation", async () => {
	await using dir = await TempDir.create("@proto-daemon-log-rotation-");
	let emitted = 0;
	const log = await DaemonLog.open(dir.path(), bytes => {
		emitted += bytes;
	});
	try {
		// Synchronous admission fills the bounded backlog before its first write can start.
		log.append("z".repeat(2 * MIB));
		await log.readTail(emitted);
		const notice = `\n[daemon log truncated: ${MIB} output bytes omitted while storage was backlogged]\n`;
		expect(emitted).toBe(MIB + Buffer.byteLength(notice));
		for (let index = 0; index < 27; index++) {
			log.append(`${String(index).padStart(2, "0")}${"x".repeat(MIB - 3)}\n`);
			await log.readTail(emitted);
		}
		const current = await fs.promises.stat(dir.join("output.log"));
		const previous = await fs.promises.stat(dir.join("output.previous.log"));
		expect(current.size).toBe(4 * MIB);
		expect(previous.size).toBe(24 * MIB + Buffer.byteLength(notice));
		const saved = await DaemonLog.readFiles(dir.join("output.log"), dir.join("output.previous.log"), {
			head: false,
			lines: 10,
			cursor: emitted,
			sinceBytes: 2 * MIB,
			currentEnd: emitted,
		});
		expect(saved.terminalOutput.startsWith("25")).toBe(true);
		expect(saved.terminalOutput.endsWith("x\n")).toBe(true);
		expect(saved.terminalOutput).not.toContain("daemon log truncated");
		const cursor = emitted;
		log.append("after-rotation\n");
		const followed = await log.read({
			head: false,
			lines: 10,
			cursor: emitted,
			sinceBytes: emitted - cursor,
			currentEnd: emitted,
		});
		expect(followed.text).toBe("after-rotation\n");
		expect(followed.cursor).toBe(cursor + Buffer.byteLength(followed.text));
		const unchanged = await log.read({ head: false, lines: 10, cursor: emitted, sinceBytes: 0, currentEnd: emitted });
		expect(unchanged.text).toBe("");
	} finally {
		await log.close();
	}
	const next = await DaemonLog.open(dir.path());
	try {
		next.append("new-generation\n");
		await next.close();
		expect(await next.readTail(15)).toBe("new-generation\n");
	} finally {
		await next.close();
	}
}, 10_000);

test("detached readiness preserves split UTF-8 and ANSI escapes before a large trailing burst", async () => {
	await using dir = await TempDir.create("@proto-daemon-log-ready-");
	const client = await createDaemonBrokerClient(dir.path(), { runtimeDir: dir.join("run") });
	try {
		for (const [prefixBytes, marker] of [
			[CHUNK_BYTES - 1, "🙂READY\n"],
			[CHUNK_BYTES - 7, "🙂RE\x1b[31mADY\n"],
		] as const) {
			const start = await client.request({
				op: "start",
				spec: {
					name: "burst",
					application: process.execPath,
					args: [
						"-e",
						`import { writeSync } from "node:fs"; writeSync(1, "x".repeat(${prefixBytes}) + ${JSON.stringify(marker)} + "y".repeat(8 * 1024 * 1024));`,
					],
					cwd: dir.path(),
					env: {},
					pty: false,
					persist: true,
					detached: true,
					restart: "no",
					ready: { log: "🙂READY", timeoutMs: 5_000 },
				},
			});
			if (start.op !== "start") throw new Error("Unexpected daemon start response");
			expect(start.readyTimedOut).toBe(false);
			expect(start.daemon.readyMatch).toBe("🙂READY");
			expect(start.daemon.readyAt).toBeDefined();
			const result = await client.request({ op: "wait", name: "burst", for: "exit", timeoutMs: 5_000 });
			if (result.op !== "wait") throw new Error("Unexpected daemon wait response");
			expect(result.timedOut).toBe(false);
			expect(result.daemon.exitCode).toBe(0);
			expect(result.daemon.outputBytes).toBe(prefixBytes + Buffer.byteLength(marker) + 8 * MIB);
		}
	} finally {
		await client.request({ op: "stop", name: "burst", timeoutMs: 1_000 }).catch(() => undefined);
		await client.request({ op: "shutdown" });
		client.close();
	}
}, 15_000);

interface StalledBrokerResult {
	beforeResume: { writes: number; bytes: number; readyMatch?: string };
	gap: Extract<DaemonRpcResult, { op: "logs" }>;
	next: Extract<DaemonRpcResult, { op: "logs" }>;
	end: Extract<DaemonRpcResult, { op: "logs" }>;
	savedBytes: number;
}

test("a stalled daemon disk cannot block readiness and follow cursors never replay the omitted interval", async () => {
	const child = Bun.spawn(
		[process.execPath, path.resolve(import.meta.dir, "../../test/fixtures/daemon-log-stalled.ts")],
		{
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0) throw new Error(`Stalled daemon fixture failed: ${stderr}`);
		const result = JSON.parse(stdout) as StalledBrokerResult;
		expect(result.beforeResume).toEqual({ writes: 1, bytes: MIB, readyMatch: "FLOOD_READY" });
		const notice = `[daemon log truncated: ${15 * MIB + Buffer.byteLength("\nFLOOD_READY\n")} output bytes omitted while storage was backlogged]`;
		expect(result.gap.text).toContain(notice);
		expect(result.gap.cursor).toBe(MIB + Buffer.byteLength(`\n${notice}\n`));
		expect(result.next.text).toBe("after-gap\n");
		expect(result.next.cursor).toBe(result.gap.cursor + Buffer.byteLength("after-gap\n"));
		expect(result.end.text).toBe("");
		expect(result.end.cursor).toBe(result.savedBytes);
	} finally {
		child.kill();
		await child.exited;
	}
}, 15_000);

test("detached file output survives broker shutdown and recovery without replaying the old cursor", async () => {
	await using dir = await TempDir.create("@proto-daemon-log-detached-");
	const runtimeDir = dir.join("run");
	let client = await createDaemonBrokerClient(dir.path(), { runtimeDir });
	try {
		const start = await client.request({
			op: "start",
			spec: {
				name: "survivor",
				application: process.execPath,
				args: [
					"-e",
					'import { watch, writeSync } from "node:fs"; let done = false; const events = watch(".", (_event, name) => { if (name !== "finish" || done) return; done = true; writeSync(1, "detached-tail\\n"); events.close(); }); writeSync(1, "detached-ready\\n");',
				],
				cwd: dir.path(),
				env: {},
				pty: false,
				persist: true,
				detached: true,
				restart: "no",
				ready: { log: "detached-ready", timeoutMs: 5_000 },
			},
		});
		if (start.op !== "start") throw new Error("Unexpected detached start response");
		const cursor = start.daemon.outputBytes;
		const removed = Promise.withResolvers<void>();
		const watcher = fs.watch(runtimeDir, (_event, filename) => {
			if (filename !== "broker.sock") return;
			void fs.promises.stat(path.join(runtimeDir, "broker.sock")).catch(error => {
				if (isEnoent(error)) removed.resolve();
				else removed.reject(error);
			});
		});
		try {
			await client.request({ op: "shutdown" });
			await removed.promise;
		} finally {
			watcher.close();
			client.close();
		}
		client = await createDaemonBrokerClient(dir.path(), { runtimeDir });
		const recovered = await client.request({ op: "describe", name: "survivor" });
		if (recovered.op !== "describe") throw new Error("Unexpected recovered daemon response");
		expect(recovered.daemon).toMatchObject({ id: start.daemon.id, pid: start.daemon.pid, state: "ready" });
		await Bun.write(dir.join("finish"), "done");
		const exit = await client.request({ op: "wait", name: "survivor", for: "exit", timeoutMs: 5_000 });
		if (exit.op !== "wait") throw new Error("Unexpected detached exit response");
		expect(exit.timedOut).toBe(false);
		const logs = await client.request({
			op: "logs",
			name: "survivor",
			lines: 10,
			head: false,
			cursor,
			follow: false,
			timeoutMs: 0,
		});
		if (logs.op !== "logs") throw new Error("Unexpected detached logs response");
		expect(logs.text).toBe("detached-tail\n");
		expect(logs.cursor).toBe(cursor + Buffer.byteLength(logs.text));
	} finally {
		await client.request({ op: "stop", name: "survivor", timeoutMs: 1_000 }).catch(() => undefined);
		await client.request({ op: "shutdown" }).catch(() => undefined);
		client.close();
	}
}, 15_000);
