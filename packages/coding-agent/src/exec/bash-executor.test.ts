import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process, Shell, type ShellRunResult } from "@oh-my-pi/pi-natives";
import {
	beginBashLaneControl,
	disposeAllBashSessions,
	disposeBashSessions,
	executeBash,
	LaneCancelledError,
	listBashLanes,
	registerBashSessionOwner,
	reserveBashLane,
} from "./bash-executor";

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

test("an interrupted persistent shell terminates its process and never reuses quarantined state", async () => {
	const sessionKey = `bash-shell-quarantine-${crypto.randomUUID()}`;
	const started = Promise.withResolvers<number>();
	const abort = new AbortController();
	let child: Process | null = null;
	let output = "";
	try {
		const result = executeBash(`export QUARANTINED_SHELL=stale; /bin/sh -c 'printf "%s\\n" "$$"; exec sleep 30'`, {
			sessionKey,
			signal: abort.signal,
			onChunk: chunk => {
				output += chunk;
				if (output.includes("\n")) started.resolve(Number.parseInt(output, 10));
			},
		});
		child = Process.fromPid(await started.promise);
		expect(child).not.toBeNull();
		abort.abort();
		expect((await result).cancelled).toBe(true);
		expect(await child!.waitForExit({ timeoutMs: 5_000 })).toBe(true);
		const replacement = await executeBash('printf "<%s>" "$QUARANTINED_SHELL"', { sessionKey });
		expect(replacement.output).toBe("<>");
	} finally {
		abort.abort();
		child?.killTree(9);
		await disposeBashSessions(sessionKey);
	}
}, 10_000);

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

test("retains background jobs from a replacement shell after cancellation", async () => {
	const sessionKey = `bash-shell-replacement-${crypto.randomUUID()}`;
	const firstRun = Promise.withResolvers<ShellRunResult>();
	const started = Promise.withResolvers<void>();
	const oldShellClosed = Promise.withResolvers<void>();
	let interruptedShell: Shell | undefined;
	let first = true;
	const originalRun = Shell.prototype.run;
	const originalClose = Shell.prototype.close;
	spyOn(Shell.prototype, "close").mockImplementation(async function (this: Shell) {
		const result = await originalClose.call(this);
		if (this === interruptedShell) oldShellClosed.resolve();
		return result;
	});
	spyOn(Shell.prototype, "run").mockImplementation(function (this: Shell, options, onChunk, dispatcher) {
		if (first) {
			first = false;
			interruptedShell = this;
			started.resolve();
			return firstRun.promise;
		}
		return originalRun.call(this, options, onChunk, dispatcher);
	});
	const abort = new AbortController();
	try {
		const interrupted = executeBash("sleep 30", { sessionKey, signal: abort.signal });
		await started.promise;
		abort.abort();
		expect((await interrupted).cancelled).toBe(true);

		await executeBash("sleep 30 &", { sessionKey });
		firstRun.resolve({
			exitCode: undefined,
			cancelled: true,
			timedOut: false,
			workingDir: process.cwd(),
			fsObservations: [],
			protolensDispatches: [],
			stageRecords: [],
		});
		await firstRun.promise;
		await oldShellClosed.promise;
		expect(listBashLanes(sessionKey)).toMatchObject([{ shell: "retained" }]);
	} finally {
		firstRun.resolve({
			exitCode: undefined,
			cancelled: true,
			timedOut: false,
			workingDir: process.cwd(),
			fsObservations: [],
			protolensDispatches: [],
			stageRecords: [],
		});
		await firstRun.promise;
		await disposeBashSessions(sessionKey);
	}
}, 15_000);

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
			protolensDispatches: [],
			stageRecords: [],
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

test("exit ends the command without losing the lane's variables and functions", async () => {
	const lane = `exit-${crypto.randomUUID()}`;
	const sessionKey = `bash-shell-exit-${crypto.randomUUID()}`;
	try {
		const exited = await executeBash('KEPT=preserved; kept_fn() { printf "%s" "$KEPT"; }; exit 3; KEPT=unreachable', {
			lane,
			sessionKey,
		});
		expect(exited.exitCode).toBe(3);
		const resumed = await executeBash("kept_fn", { lane, sessionKey });
		expect(resumed.exitCode).toBe(0);
		expect(resumed.output).toBe("preserved");
		expect(resumed.shellStateLost).toBeUndefined();
	} finally {
		await disposeBashSessions(sessionKey);
	}
});

test("only a session-owned lane reports cancellation loss, and only once", async () => {
	const lane = `lost-${crypto.randomUUID()}`;
	const sessionKey = `bash-shell-lost-${crypto.randomUUID()}`;
	try {
		for (const owner of [undefined, sessionKey]) {
			const abort = new AbortController();
			const interrupted = await executeBash("printf ready; sleep 30", {
				lane,
				sessionKey: owner,
				signal: abort.signal,
				onChunk: () => abort.abort(),
			});
			expect(interrupted.cancelled).toBe(true);
			const resumed = await executeBash("true", { lane, sessionKey: owner });
			if (owner) {
				expect(resumed.shellStateLost).toContain(`lane ${lane} shell was killed by a cancellation`);
			} else {
				// Shared lanes have no session owner to receive a loss notice.
				expect(resumed.shellStateLost).toBeUndefined();
			}
			expect((await executeBash("true", { lane, sessionKey: owner })).shellStateLost).toBeUndefined();
		}
	} finally {
		await disposeBashSessions(sessionKey);
	}
});

test("a lane control barrier cancels pre-barrier reservations and admits later ones only after it finishes", async () => {
	const sessionKey = `bash-lane-barrier-${crypto.randomUUID()}`;
	const active = reserveBashLane({ sessionKey, lane: "work" });
	const queued = reserveBashLane({ sessionKey, lane: "work" });
	await active.ready;
	const control = beginBashLaneControl(sessionKey, "work");
	const later = reserveBashLane({ sessionKey, lane: "work" });
	expect(control.pending()).toEqual({ active: 1, queued: 1 });

	expect(control.cancel("reset")).toEqual({ active: 1, queued: 1 });
	expect(active.signal.reason).toBeInstanceOf(LaneCancelledError);
	await expect(queued.ready).rejects.toThrow("lane work was reset");
	expect(later.signal.aborted).toBe(false);

	active.release();
	active.release();
	await control.drain();
	// The pre-barrier slot is gone, yet the later reservation still waits for the teardown to finish.
	expect(listBashLanes(sessionKey)).toMatchObject([{ lane: "work", queued: 1, controlling: true }]);
	expect(listBashLanes(sessionKey)[0].activeSince).toBeUndefined();

	control.finish();
	control.finish();
	await later.ready;
	expect(listBashLanes(sessionKey)).toMatchObject([{ lane: "work", queued: 0, controlling: false }]);
	later.release();
	queued.release();
	expect(listBashLanes(sessionKey)).toEqual([]);
});

test("an ephemeral lane leaves no shell behind once its command finishes", async () => {
	const sessionKey = `bash-ephemeral-lane-${crypto.randomUUID()}`;
	try {
		await executeBash("export EPHEMERAL=1", { sessionKey, lane: "async:job", ephemeral: true });
		expect(listBashLanes(sessionKey)).toEqual([]);
		await executeBash("export KEPT=1", { sessionKey, lane: "named" });
		expect(listBashLanes(sessionKey)).toMatchObject([{ lane: "named", shell: "live" }]);
	} finally {
		await disposeBashSessions(sessionKey);
	}
});

test("watchdog timeout flags output as possibly incomplete when the native shell never returns", async () => {
	const sessionKey = `bash-executor-wedged-${crypto.randomUUID()}`;
	const wedged = Promise.withResolvers<ShellRunResult>();
	spyOn(Shell.prototype, "run").mockImplementation(function (this: Shell, _options, onChunk) {
		onChunk?.(null, "streamed-before-timeout\n");
		return wedged.promise;
	});
	try {
		const result = await executeBash("sleep 30", { sessionKey, timeout: 1_000 });
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("streamed-before-timeout");
		expect(result.output).toContain("Command timed out after 1 seconds; the shell backend did not respond");
	} finally {
		wedged.resolve({
			exitCode: undefined,
			cancelled: true,
			timedOut: true,
			workingDir: process.cwd(),
			fsObservations: [],
			protolensDispatches: [],
			stageRecords: [],
		});
		await disposeBashSessions(sessionKey);
	}
}, 15_000);

test("non-interactive rebase defaults do not overwrite persistent shell git config exports", async () => {
	const sessionKey = `bash-git-config-${crypto.randomUUID()}`;
	try {
		await executeBash("export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=test.marker GIT_CONFIG_VALUE_0=preserved", {
			sessionKey,
		});
		const result = await executeBash(
			'printf "%s:%s:%s:%s" "$GIT_SEQUENCE_EDITOR" "$GIT_CONFIG_COUNT" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0"',
			{ sessionKey },
		);
		expect(result.output).toContain("true:1:test.marker:preserved");
	} finally {
		await disposeBashSessions(sessionKey);
	}
});
