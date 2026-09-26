import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, type AsyncJobEvent, AsyncJobManager } from "../async/job-manager";
import { Settings } from "../config/settings";
import { snapshotMonitor, startMonitor } from "./runner";
import type { MonitorStartSpec } from "./types";

const settings = Settings.isolated();

const managers: AsyncJobManager[] = [];

afterEach(async () => {
	while (managers.length > 0) await managers.pop()?.dispose();
});

function createManager(cwd = process.cwd(), maxTotalJobs?: number) {
	const events: AsyncJobEvent[] = [];
	const manager = new AsyncJobManager({ maxRunningJobs: 1, maxTotalJobs });
	manager.registerDeliverySink("owner", (_id, _text, _job, event) => {
		if (event) {
			events.push(event);
			manager.acknowledgeEvents([event]);
		}
	});
	managers.push(manager);
	return {
		manager,
		events,
		start: (spec: MonitorStartSpec, ownerId = "owner") => startMonitor(manager, spec, { ownerId, settings, cwd }),
		snapshot: (id: string) => snapshotMonitor(manager.getJob(id)!),
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for monitor events");
		// Real subprocess output is asynchronous outside the JS fake-timer clock.
		await Bun.sleep(20);
	}
}

test("stream mode reports only matching output lines, then reports process exit", async () => {
	const { manager, events, start, snapshot } = createManager();
	const started = start({
		command: "printf 'booting\\nERROR: disk full\\nbooted\\n'",
		label: "boot",
		match: "ERROR",
	});
	expect(started.mode).toBe("stream");

	await manager.getJob(started.id)!.promise;
	await waitFor(() => events.some(event => event.kind === "exit"));

	expect(events.map(event => event.kind)).toEqual(["output", "exit"]);
	expect(events[0]?.text).toBe("ERROR: disk full");
	expect(events[0]?.jobId).toBe(started.id);
	expect(events[0]?.label).toBe("boot");

	const stopped = snapshot(started.id);
	expect(stopped?.status).toBe("completed");
	expect(stopped?.stopReason).toBe("exit");
	expect(stopped?.exitCode).toBe(0);
	expect(manager.getRunningJobs()).toHaveLength(0);
});

test("stream mode stops itself once maxEvents output events are delivered", async () => {
	const { manager, events, start, snapshot } = createManager();
	const started = start({
		command: "printf 'a\\nb\\nc\\nd\\n'; sleep 5",
		maxEvents: 2,
	});

	await manager.getJob(started.id)!.promise;
	await waitFor(() => events.some(event => event.kind === "limit"));

	expect(events.map(event => event.text)).toEqual(["a", "b", "Event limit reached (2); the monitor stopped itself."]);
	const stopped = snapshot(started.id);
	expect(stopped?.stopReason).toBe("limit");
	expect(stopped?.status).toBe("completed");
});

for (const mode of ["stream", "poll"] as const) {
	test(`${mode} mode stops with an actionable error instead of retaining oversized output`, async () => {
		const { manager, events, start, snapshot } = createManager();
		const started = start({
			command: "printf '%2097152s' x",
			...(mode === "poll" ? { everySeconds: 1 } : {}),
		});
		await manager.getJob(started.id)!.promise;
		await waitFor(() => events.length > 0);
		expect(events.map(event => event.kind)).toEqual(["error"]);
		expect(events[0]?.text).toMatch(/output.*limit|line.*limit/i);
		expect(snapshot(started.id)?.stopReason).toBe("error");
		expect(manager.getRunningJobs()).toHaveLength(0);
	});
}

test("poll mode reports changed output once and skips identical repeats", async () => {
	const { events, start, snapshot } = createManager();
	const started = start({ command: "echo steady", everySeconds: 1, label: "ci" });
	expect(started.mode).toBe("poll");

	await waitFor(() => events.length > 0);
	// Exercise repeated real command executions; JS fake timers cannot advance subprocesses.
	await Bun.sleep(2_500);

	expect(events).toHaveLength(1);
	expect(events[0]?.text).toBe("steady");
	expect(snapshot(started.id)?.status).toBe("running");
});

test("poll mode lets a healthy slow command finish instead of timing it out", async () => {
	const { events, start, snapshot } = createManager();
	const started = start({ command: "sleep 4; echo steady", everySeconds: 1 });

	await waitFor(() => events.some(event => event.kind === "output"));

	expect(events).toEqual([expect.objectContaining({ jobId: started.id, kind: "output", text: "steady" })]);
	expect(snapshot(started.id)?.status).toBe("running");
	expect(snapshot(started.id)?.stopReason).toBeUndefined();
});

test("stop halts delivery and records the manual stop reason", async () => {
	const { manager, events, start, snapshot } = createManager();
	const started = start({
		command: "while true; do echo tick; sleep 0.05; done",
		maxEvents: 1_000,
	});

	await waitFor(() => events.length >= 2);
	expect(manager.cancel(started.id, { ownerId: "owner" })).toBe(true);
	await manager.getJob(started.id)!.promise;
	expect(snapshot(started.id)?.stopReason).toBe("manual");
	expect(snapshot(started.id)?.status).toBe("cancelled");

	const seen = events.length;
	// Observe a real subprocess delivery quiet period after cancellation/shutdown.
	await Bun.sleep(400);
	expect(events).toHaveLength(seen);
	expect(manager.getRunningJobs()).toHaveLength(0);
});

test("start rejects an invalid match pattern before spawning anything", () => {
	const { manager, start } = createManager();
	expect(() => start({ command: "true", match: "(" })).toThrow(/not a valid regular expression/);
	expect(manager.getAllJobs()).toHaveLength(0);
});

test("dispose stops every running monitor without delivering further events", async () => {
	const { manager, events, start } = createManager();
	const started = start({ command: "while true; do echo tick; sleep 0.05; done", maxEvents: 1_000 });

	await waitFor(() => events.length >= 1);
	const job = manager.getJob(started.id)!;
	await manager.dispose();
	expect(job.monitor?.stopReason).toBe("session");

	const seen = events.length;
	// Observe a real subprocess delivery quiet period after cancellation/shutdown.
	await Bun.sleep(400);
	expect(events).toHaveLength(seen);
	expect(manager.getRunningJobs()).toHaveLength(0);
});

test("dispose waits for a monitor process that ignores graceful termination", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proto-monitor-dispose-"));
	const pidFile = path.join(directory, "pid");
	try {
		const { manager, start } = createManager();
		start({
			command: `printf '%s' "$$" > "${pidFile}"; trap '' TERM; while :; do sleep 1; done`,
		});
		await waitFor(() => fs.existsSync(pidFile));
		const pid = Number(await Bun.file(pidFile).text());
		expect(Number.isInteger(pid)).toBe(true);
		expect(Process.fromPid(pid)).not.toBeNull();

		await manager.dispose();

		const process = Process.fromPid(pid);
		expect(process === null || process.status() !== "running").toBe(true);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("monitor owner concurrency is independent of runnable-job capacity within total admission", async () => {
	const limit = settings.get("monitor.maxConcurrent");
	const { manager, start } = createManager(process.cwd(), limit + 2);
	const finish = Promise.withResolvers<string>();
	manager.register("bash", "finite", () => finish.promise);
	try {
		for (let i = 0; i < limit; i++) start({ command: "sleep 30" });
		expect(() => start({ command: "sleep 30" })).toThrow(/Too many monitors/);
		const other = start({ command: "sleep 30" }, "other-owner");
		expect(manager.getJob(other.id)?.ownerId).toBe("other-owner");
		expect(manager.atCapacity).toBe(true);
	} finally {
		finish.resolve("done");
	}
});

for (const mode of ["stream", "poll"] as const) {
	test(`${mode} timeout cleans up the process before settling`, async () => {
		const { manager, events, start, snapshot } = createManager();
		const started = start({
			command: "sleep 30",
			timeoutSeconds: 1,
			...(mode === "poll" ? { everySeconds: 1 } : {}),
		});
		await manager.getJob(started.id)!.promise;
		await waitFor(() => events.length > 0);
		expect(snapshot(started.id)?.stopReason).toBe("timeout");
		expect(snapshot(started.id)?.status).toBe("completed");
		expect(events.map(event => event.kind)).toEqual(["timeout"]);
	});
}

test("spawn failures emit one error and fail the shared job", async () => {
	const { manager, events, start, snapshot } = createManager("/nonexistent/proto-monitor-cwd");
	const started = start({ command: "true" });
	await manager.getJob(started.id)!.promise;
	await waitFor(() => events.length > 0);
	expect(events.map(event => event.kind)).toEqual(["error"]);
	expect(snapshot(started.id)?.status).toBe("failed");
	expect(snapshot(started.id)?.stopReason).toBe("error");
});

test("event text is sanitized, truncated and sequenced", async () => {
	const { manager, events, start, snapshot } = createManager();
	const started = start({ command: "printf '\\033[31mred\\033[0m\n'; printf '%2000s\n' x" });
	await manager.getJob(started.id)!.promise;
	await waitFor(() => events.length === 3);
	expect(events[0]?.text).toBe("red");
	expect(events[1]?.text).toEndWith("… (+800 chars)");
	expect(events.map(event => event.sequence)).toEqual([1, 2, 3]);
	expect(snapshot(started.id)?.eventCount).toBe(3);
});

test("shutdown reason is scoped to the cancelled owner", async () => {
	const { manager, start, snapshot } = createManager();
	const first = start({ command: "sleep 30" });
	const second = start({ command: "sleep 30" }, "other-owner");
	manager.cancelAll({ ownerId: "owner" }, ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
	await manager.getJob(first.id)!.promise;
	expect(snapshot(first.id)?.stopReason).toBe("session");
	expect(snapshot(second.id)?.status).toBe("running");
});

for (const parentExits of [false, true]) {
	test(`cancellation reaps descendants when the shell ${parentExits ? "has exited" : "is running"}`, async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proto-monitor-group-"));
		const pidFile = path.join(directory, "child-pid");
		try {
			const { manager, start } = createManager();
			const started = start({
				command: `sleep 30 & printf '%s' "$!" > "${pidFile}"; ${parentExits ? "exit" : "wait"}`,
			});
			await waitFor(() => fs.existsSync(pidFile));
			const pid = Number(await Bun.file(pidFile).text());
			expect(Process.fromPid(pid)).not.toBeNull();
			manager.cancel(started.id, { ownerId: "owner" });
			await manager.getJob(started.id)!.promise;
			const child = Process.fromPid(pid);
			// An orphan is reaped by the OS rather than Bun's child.exited promise.
			expect(child === null || (await child.waitForExit({ timeoutMs: 1_000 }))).toBe(true);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
}

test("poll output can match again after an intervening nonmatching value", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proto-monitor-poll-"));
	const valueFile = path.join(directory, "value");
	try {
		await Bun.write(valueFile, "ready");
		const { manager, events, start } = createManager(directory);
		const started = start({
			command: "value=$(cat value); printf '%s' \"$value\"; printf '%s' \"$value\" > observed",
			everySeconds: 1,
			match: "ready",
			maxEvents: 2,
		});
		await waitFor(() => events.length === 1);
		await Bun.write(valueFile, "pending");
		await waitFor(
			() =>
				fs.existsSync(path.join(directory, "observed")) &&
				fs.readFileSync(path.join(directory, "observed"), "utf8") === "pending",
		);
		await Bun.write(valueFile, "ready");
		await manager.getJob(started.id)!.promise;
		await waitFor(() => events.length === 3);
		expect(events.map(event => event.kind)).toEqual(["output", "output", "limit"]);
		expect(events.filter(event => event.kind === "output").map(event => event.text)).toEqual(["ready", "ready"]);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("nonzero process exit is a terminal exit event, not a runner failure", async () => {
	const { manager, events, start, snapshot } = createManager();
	const started = start({ command: "exit 7" });
	await manager.getJob(started.id)!.promise;
	await waitFor(() => events.length > 0);
	expect(events[0]?.kind).toBe("exit");
	expect(snapshot(started.id)?.exitCode).toBe(7);
	expect(snapshot(started.id)?.status).toBe("completed");
});

test("invalid options do not register jobs", () => {
	const { manager, start } = createManager();
	for (const spec of [
		{ command: " " },
		{ command: "true", everySeconds: 0 },
		{ command: "true", timeoutSeconds: Number.POSITIVE_INFINITY },
		{ command: "true", maxEvents: Number.NaN },
	])
		expect(() => start(spec)).toThrow();
	expect(() => start({ command: "true" }, "")).toThrow(/owner/);
	expect(manager.getAllJobs()).toHaveLength(0);
});
