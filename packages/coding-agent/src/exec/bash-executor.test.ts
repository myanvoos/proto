import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process, Shell } from "@oh-my-pi/pi-natives";
import { disposeAllBashSessions, disposeBashSessions, executeBash, registerBashSessionOwner } from "./bash-executor";

afterEach(() => {
	vi.restoreAllMocks();
});

test("disposes a persistent shell and force-kills a stubborn background child", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bash-shell-dispose-"));
	const sessionKey = `bash-shell-dispose-${crypto.randomUUID()}`;
	const pidFile = path.join(cwd, "child.pid");
	let child: Process | null = null;
	try {
		await executeBash(`sh -c 'trap "" TERM; sleep 60 & echo $! > "${pidFile}"; wait' &`, {
			cwd,
			sessionKey,
		});
		const pid = Number.parseInt(await Bun.file(pidFile).text(), 10);
		child = Process.fromPid(pid);
		expect(child).not.toBeNull();

		const started = performance.now();
		await disposeBashSessions(sessionKey);
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(await child!.waitForExit({ timeoutMs: 2_000 })).toBe(true);
	} finally {
		child?.killTree(9);
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("stalled retained-shell probes do not block owner disposal", async () => {
	const sessionKey = `bash-shell-probe-timeout-${crypto.randomUUID()}`;
	await executeBash("sleep 60 &", { sessionKey });
	const { promise: stalledProbe } = Promise.withResolvers<number>();
	const probe = spyOn(Shell.prototype, "liveBackgroundJobCount").mockImplementation(() => stalledProbe);
	try {
		const started = performance.now();
		await disposeBashSessions(sessionKey);

		expect(performance.now() - started).toBeLessThan(2_500);
	} finally {
		probe.mockRestore();
		await disposeAllBashSessions();
	}
});

test("revived session owners can create a new persistent shell after disposal", async () => {
	const sessionKey = `bash-shell-revive-${crypto.randomUUID()}`;
	try {
		await executeBash("export PROTO_REVIVED_SHELL=revived", { sessionKey });
		await disposeBashSessions(sessionKey);
		registerBashSessionOwner(sessionKey);

		await executeBash("export PROTO_REVIVED_SHELL=revived", { sessionKey });
		const result = await executeBash("printf '%s' \"$PROTO_REVIVED_SHELL\"", { sessionKey });

		expect(result.output).toContain("revived");
	} finally {
		await disposeBashSessions(sessionKey);
	}
});

test("rejects commands for a disposed session owner", async () => {
	const sessionKey = `bash-shell-reject-${crypto.randomUUID()}`;
	await disposeBashSessions(sessionKey);

	await expect(executeBash("printf rejected", { sessionKey })).rejects.toThrow("Bash session is disposed");
	registerBashSessionOwner(sessionKey);
	await disposeBashSessions(sessionKey);
});

test("keeps raw failure diagnostics when minimized output cannot be persisted", async () => {
	const rawOutput =
		"src/event-cache.ts:281:5 error TS2304 Cannot find name 'foo'\n" +
		"src/event-cache.ts:300:9 error TS2345 Argument of type 'string' is not assignable\n";
	spyOn(Shell.prototype, "run").mockImplementation(function (this: Shell, _options, onChunk) {
		onChunk?.(null, rawOutput);
		return Promise.resolve({
			exitCode: 1,
			cancelled: false,
			timedOut: false,
			workingDir: process.cwd(),
			fsObservations: [],
			xdDispatches: [],
			minimized: {
				filter: "lint",
				text: "src/event-cache.ts:281-405 multiple ... errors\n",
				originalText: rawOutput,
				inputBytes: Buffer.byteLength(rawOutput, "utf-8"),
				outputBytes: 52,
			},
		});
	});

	const result = await executeBash("pnpm lint", {
		sessionKey: `bash-executor-minimized-save-${crypto.randomUUID()}`,
		onMinimizedSave: async () => undefined,
	});

	expect(result.exitCode).toBe(1);
	expect(result.output).toContain("TS2304 Cannot find name 'foo'");
	expect(result.output).not.toContain("multiple ... errors");
});
