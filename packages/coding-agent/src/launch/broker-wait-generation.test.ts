import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDaemonBrokerClient } from "./client";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "proto-broker-wait-generation-"));
const project = path.join(tmp, "project");
await fs.mkdir(project);
const client = await createDaemonBrokerClient(project, { runtimeDir: path.join(tmp, "run") });

// A wait is bound to the launch generation it observed: an auto-restarting process that exits must answer an exit
// wait instead of the wait running on into the replacement until its timeout.
test("an exit wait settles when an auto-restarting generation exits", async () => {
	const scriptPath = path.join(project, "crash.ts");
	await Bun.write(scriptPath, `await Bun.sleep(200);\nprocess.exit(3);\n`);
	await client.request({
		op: "start",
		spec: {
			name: "crash-loop",
			application: process.execPath,
			args: [scriptPath],
			env: {},
			cwd: project,
			pty: false,
			restart: "always",
			persist: false,
			detached: false,
		},
	});

	const startedAt = Date.now();
	const exited = await client.request({ op: "wait", name: "crash-loop", for: "exit", timeoutMs: 20_000 });
	if (exited.op !== "wait") throw new Error("unexpected wait result");
	expect(exited.timedOut).toBe(false);
	expect(exited.daemon.exitCode).toBe(3);
	expect(Date.now() - startedAt).toBeLessThan(10_000);

	const pattern = await client.request({
		op: "wait",
		name: "crash-loop",
		for: "ready",
		pattern: "never printed",
		timeoutMs: 20_000,
	});
	if (pattern.op !== "wait") throw new Error("unexpected wait result");
	expect(pattern.timedOut).toBe(true);
	expect(pattern.matched).toBeUndefined();
	expect(Date.now() - startedAt).toBeLessThan(15_000);

	await client.request({ op: "stop", name: "crash-loop", timeoutMs: 5_000 });
}, 60_000);

test("a pattern wait returns when the process exits without printing the pattern", async () => {
	const scriptPath = path.join(project, "quiet.ts");
	await Bun.write(scriptPath, `console.log("booting");\n`);
	await client.request({
		op: "start",
		spec: {
			name: "quiet-exit",
			application: process.execPath,
			args: [scriptPath],
			env: {},
			cwd: project,
			pty: false,
			restart: "no",
			persist: false,
			detached: false,
		},
	});

	const startedAt = Date.now();
	const result = await client.request({
		op: "wait",
		name: "quiet-exit",
		for: "ready",
		pattern: "never printed",
		timeoutMs: 30_000,
	});
	if (result.op !== "wait") throw new Error("unexpected wait result");
	expect(result.matched).toBeUndefined();
	expect(result.daemon.state).toBe("exited");
	expect(Date.now() - startedAt).toBeLessThan(15_000);
}, 60_000);

afterAll(async () => {
	await client.request({ op: "shutdown" }).catch(() => undefined);
	client.close();
	await fs.rm(tmp, { recursive: true, force: true });
});
