import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as net from "node:net";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../async";
import { Settings } from "../../config/settings";
import type { ProcessRef, WatchRef } from "../../jobs/contracts";
import * as launchClient from "../../launch/client";
import { daemonBrokerEndpoint } from "../../launch/paths";
import { DaemonBrokerRejectedError } from "../../launch/protocol";
import { OrchestratorRuntime } from "../../orchestrator/runtime";
import type { ToolSession } from "..";
import { type JobsParams, type JobsResult, JobsTool } from ".";

afterEach(() => {
	vi.restoreAllMocks();
	OrchestratorRuntime.resetGlobalForTests();
});

/** Runs `body` against a real broker isolated in a temporary runtime directory. */
async function withBroker(
	body: (run: (params: JobsParams) => Promise<JobsResult>, client: launchClient.DaemonBrokerClient) => Promise<void>,
): Promise<void> {
	await using dir = await TempDir.create("@proto-jobs-process-");
	const client = await launchClient.createDaemonBrokerClient(dir.path(), { runtimeDir: dir.join("run") });
	spyOn(launchClient, "daemonClientForProject").mockResolvedValue(client);
	const manager = new AsyncJobManager({ retentionMs: 60_000 });
	// Automatic delivery must have a sink, or undelivered watch events are dead-lettered.
	manager.registerDeliverySink("jobs-process-session", () => {});
	const session = {
		cwd: dir.path(),
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionId: () => "jobs-process-session",
		getAsyncJobOwnerId: () => "jobs-process-session",
		asyncJobManager: manager,
	} as unknown as ToolSession;
	const jobs = new JobsTool(session);
	try {
		await body(params => jobs.execute("call", params), client);
	} finally {
		await manager.dispose({ timeoutMs: 3_000 });
		await client.request({ op: "shutdown" }).finally(() => client.close());
	}
}

function text(result: JobsResult): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

const SERVICE = `
console.log("READY");
for await (const line of console) {
	if (line === "flood") process.stdout.write(("y".repeat(1023) + "\\n").repeat(3000));
	else console.log("echo: " + line);
}`;

test("watching a process observes it without owning it, and a restart retires every old reference", async () => {
	await withBroker(async run => {
		const started = await run({
			op: "start",
			name: "svc",
			application: process.execPath,
			args: ["-e", SERVICE],
			pty: false,
			ready: { log: "READY", timeoutMs: 10_000 },
		});
		expect(started.details?.process?.daemon?.state).toBe("ready");
		const first = started.details!.ref as ProcessRef;

		const watched = await run({ op: "watch", source: first, match: "hit" });
		const watch = watched.details!.ref as WatchRef;
		await run({ op: "input", target: first, text: "miss" });
		await run({ op: "input", target: first, text: "hit one" });
		const woke = await run({ op: "wait", targets: [watch], timeoutMs: 10_000 });
		expect(woke.details?.jobs?.[0]?.events?.map(event => event.text)).toEqual(["echo: hit one"]);

		// Stopping the observation leaves the service running and controllable.
		const unwatched = await run({ op: "unwatch", target: watch });
		expect(unwatched.details?.receipt?.status).toBe("settled");
		const alive = await run({ op: "inspect", target: first });
		expect(alive.details?.process?.daemon?.state).toBe("ready");

		const pinned = (await run({ op: "watch", source: first })).details!.ref as WatchRef;
		const restarted = await run({ op: "restart", target: first });
		const second = restarted.details!.ref as ProcessRef;
		expect(second.name).toBe("svc");
		expect(second.id).not.toBe(first.id);

		// The old incarnation's reference can no longer control the replacement.
		const stale = await run({ op: "input", target: first, text: "hit stale" }).catch((error: unknown) => error);
		expect(stale).toBeInstanceOf(DaemonBrokerRejectedError);
		expect((stale as DaemonBrokerRejectedError).code).toBe("stale-reference");
		const ended = await run({ op: "wait", targets: [pinned], timeoutMs: 10_000 });
		expect(ended.details?.jobs?.[0]?.events?.map(event => event.kind)).toContain("replaced");

		const cancelled = await run({ op: "cancel", target: second });
		expect(cancelled.details?.receipt).toMatchObject({ status: "settled" });
		expect(cancelled.details?.process?.daemon?.state).toBe("exited");
	});
}, 60_000);

test("cursor reads report output that is no longer retained instead of skipping it silently", async () => {
	await withBroker(async (run, client) => {
		const started = await run({
			op: "start",
			name: "flood",
			application: process.execPath,
			args: ["-e", SERVICE],
			pty: false,
			ready: { log: "READY", timeoutMs: 10_000 },
		});
		const ref = started.details!.ref as ProcessRef;
		const before = started.details!.process!.daemon!.outputBytes;
		await run({ op: "input", target: ref, text: "flood" });
		let read = await client.request({
			op: "read",
			name: ref.name,
			expectedId: ref.id,
			cursor: 0,
			maxBytes: 1,
			timeoutMs: 0,
		});
		for (
			let i = 0;
			i < 100 && read.op === "read" && read.daemon.outputBytes < before + 1024 * 1024 + 64 * 1024;
			i++
		) {
			await Bun.sleep(50); // the broker drains the child's pipe asynchronously
			read = await client.request({
				op: "read",
				name: ref.name,
				expectedId: ref.id,
				cursor: 0,
				maxBytes: 1,
				timeoutMs: 0,
			});
		}
		if (read.op !== "read") throw new Error("unexpected result");
		expect(read.omittedBytes).toBeGreaterThan(0);
		expect(read.cursor).toBe(read.omittedBytes);
		expect(read.nextCursor).toBeGreaterThan(read.cursor);
		await run({ op: "cancel", target: ref });
	});
}, 60_000);

test("an old broker without process identity is refused before any pinned request reaches it", async () => {
	await using dir = await TempDir.create("@proto-jobs-old-broker-");
	const runtimeDir = dir.join("run");
	const client = await launchClient.createDaemonBrokerClient(dir.path(), { runtimeDir });
	const received: string[] = [];
	const server = net.createServer(socket => {
		let buffer = "";
		socket.on("data", chunk => {
			buffer += chunk.toString();
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const request = JSON.parse(buffer.slice(0, newline)) as { id: string; operation: { op: string } };
				buffer = buffer.slice(newline + 1);
				received.push(request.operation.op);
				// Protocol 1 answered ping with only its project directory.
				socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { projectDir: dir.path() } })}\n`);
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(daemonBrokerEndpoint(dir.path(), runtimeDir), listening.resolve);
	await listening.promise;
	try {
		const refused = await client
			.request({ op: "send", name: "web", expectedId: "incarnation", signal: "SIGTERM" })
			.catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(launchClient.DaemonBrokerIncompatibleError);
		expect((refused as Error).message).toContain("proto ps stop");
		expect(received).toEqual(["ping"]);
	} finally {
		client.close();
		server.close();
	}
});

test("process targets in wait report an exit once, claiming it from automatic completion delivery", async () => {
	await withBroker(async run => {
		const started = await run({
			op: "start",
			name: "short",
			application: process.execPath,
			args: ["-e", 'console.log("READY"); for await (const line of console) process.exit(3);'],
			pty: false,
			ready: { log: "READY", timeoutMs: 10_000 },
		});
		const ref = started.details!.ref as ProcessRef;
		const waiting = run({ op: "wait", targets: [ref], timeoutMs: 10_000 });
		await run({ op: "input", target: ref, text: "bye" });
		const woke = await waiting;
		expect(woke.details?.exited).toEqual([ref]);
		expect(text(woke)).toContain("with code 3");
		expect(text(woke)).not.toContain("already delivered");
	});
}, 60_000);

test("a detached process is watched through its captured file output", async () => {
	await withBroker(async run => {
		const started = await run({
			op: "start",
			name: "detached",
			application: process.execPath,
			args: ["-e", 'console.log("READY"); let n = 0; setInterval(() => console.log("tick " + ++n), 50);'],
			detached: true,
			ready: { log: "READY", timeoutMs: 10_000 },
		});
		const ref = started.details!.ref as ProcessRef;
		try {
			expect(started.details?.process?.daemon).toMatchObject({ state: "ready", detached: true, persist: true });
			const watch = (await run({ op: "watch", source: ref, match: "tick", maxEvents: 1 })).details!.ref as WatchRef;
			const woke = await run({ op: "wait", targets: [watch], timeoutMs: 10_000 });
			expect(woke.details?.jobs?.[0]?.events?.[0]?.text).toMatch(/^tick \d+$/);
		} finally {
			await run({ op: "cancel", target: ref });
		}
	});
}, 60_000);
