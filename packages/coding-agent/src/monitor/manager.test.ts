import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { Settings } from "../config/settings";
import { MonitorManager } from "./manager";
import type { MonitorEvent } from "./types";

const settings = await Settings.init();

const managers: MonitorManager[] = [];

afterEach(async () => {
	while (managers.length > 0) await managers.pop()?.dispose();
});

function createManager(cwd = process.cwd()): { manager: MonitorManager; events: MonitorEvent[] } {
	const events: MonitorEvent[] = [];
	const manager = new MonitorManager({
		deliver: event => {
			events.push(event);
		},
		settings,
		cwd: () => cwd,
	});
	managers.push(manager);
	return { manager, events };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for monitor events");
		await Bun.sleep(20);
	}
}

test("stream mode reports only matching output lines, then reports process exit", async () => {
	const { manager, events } = createManager();
	const started = manager.start({
		command: "printf 'booting\\nERROR: disk full\\nbooted\\n'",
		label: "boot",
		match: "ERROR",
	});
	expect(started.mode).toBe("stream");

	await waitFor(() => events.some(event => event.kind === "exit"));

	expect(events.map(event => event.kind)).toEqual(["output", "exit"]);
	expect(events[0]?.text).toBe("ERROR: disk full");
	expect(events[0]?.monitorId).toBe(started.id);
	expect(events[0]?.label).toBe("boot");

	const snapshot = manager.get(started.id);
	expect(snapshot?.status).toBe("stopped");
	expect(snapshot?.stopReason).toBe("exit");
	expect(snapshot?.exitCode).toBe(0);
	expect(manager.hasActive()).toBe(false);
});

test("stream mode stops itself once maxEvents output events are delivered", async () => {
	const { manager, events } = createManager();
	const started = manager.start({
		command: "printf 'a\\nb\\nc\\nd\\n'; sleep 5",
		maxEvents: 2,
	});

	await waitFor(() => events.some(event => event.kind === "limit"));

	expect(events.map(event => event.text)).toEqual(["a", "b", "Event limit reached (2); the monitor stopped itself."]);
	const snapshot = manager.get(started.id);
	expect(snapshot?.stopReason).toBe("limit");
	expect(snapshot?.status).toBe("stopped");
});

test("poll mode reports changed output once and skips identical repeats", async () => {
	const { manager, events } = createManager();
	const started = manager.start({ command: "echo steady", everySeconds: 1, label: "ci" });
	expect(started.mode).toBe("poll");

	await waitFor(() => events.length > 0);
	await Bun.sleep(2_500);

	expect(events).toHaveLength(1);
	expect(events[0]?.text).toBe("steady");
	expect(manager.get(started.id)?.status).toBe("running");
});

test("poll mode lets a healthy slow command finish instead of timing it out", async () => {
	const { manager, events } = createManager();
	const started = manager.start({ command: "sleep 4; echo steady", everySeconds: 1 });

	await waitFor(() => events.some(event => event.kind === "output"));

	expect(events).toEqual([expect.objectContaining({ monitorId: started.id, kind: "output", text: "steady" })]);
	expect(manager.get(started.id)?.status).toBe("running");
	expect(manager.get(started.id)?.stopReason).toBeUndefined();
});

test("stop halts delivery and records the manual stop reason", async () => {
	const { manager, events } = createManager();
	const started = manager.start({
		command: "while true; do echo tick; sleep 0.05; done",
		maxEvents: 1_000,
	});

	await waitFor(() => events.length >= 2);
	const stopped = manager.stop([started.id]);
	expect(stopped.map(snapshot => snapshot.stopReason)).toEqual(["manual"]);

	const seen = events.length;
	await Bun.sleep(400);
	expect(events).toHaveLength(seen);
	expect(manager.hasActive()).toBe(false);
});

test("start rejects an invalid match pattern before spawning anything", () => {
	const { manager } = createManager();
	expect(() => manager.start({ command: "true", match: "(" })).toThrow(/not a valid regular expression/);
	expect(manager.list()).toHaveLength(0);
});

test("dispose stops every running monitor without delivering further events", async () => {
	const { manager, events } = createManager();
	manager.start({ command: "while true; do echo tick; sleep 0.05; done", maxEvents: 1_000 });

	await waitFor(() => events.length >= 1);
	await manager.dispose();

	const seen = events.length;
	await Bun.sleep(400);
	expect(events).toHaveLength(seen);
	expect(manager.hasActive()).toBe(false);
});

test("dispose waits for a monitor process that ignores graceful termination", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proto-monitor-dispose-"));
	const pidFile = path.join(directory, "pid");
	try {
		const { manager } = createManager();
		manager.start({
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
