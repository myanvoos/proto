import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as launchClient from "../../launch/client";
import type { DaemonOperation, DaemonRpcResult } from "../../launch/protocol";
import type { ToolSession } from "..";
import { executeLaunch } from "./launch";

/** Captures the operation the fleet send asks the broker to perform (the broker writes `keys` verbatim). */
function captureBroker(): DaemonOperation[] {
	const requests: DaemonOperation[] = [];
	const client = {
		request: async (operation: DaemonOperation): Promise<DaemonRpcResult> => {
			requests.push(operation);
			return {
				op: "send",
				daemon: {
					name: "repl",
					id: "d1",
					state: "running",
					createdAt: 0,
					startedAt: 0,
					restartCount: 0,
					outputBytes: 0,
					persist: false,
					detached: false,
				},
			};
		},
	} as unknown as launchClient.DaemonBrokerClient;
	spyOn(launchClient, "daemonClientForProject").mockResolvedValue(client);
	return requests;
}

const session = { cwd: process.cwd() } as unknown as ToolSession;

describe("fleet send keys", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("control chords in every accepted spelling and case-insensitive named keys map to their bytes", async () => {
		const requests = captureBroker();
		await executeLaunch(session, {
			op: "send",
			name: "repl",
			keys: ["C-d", "ctrl+d", "Ctrl-D", "^D", "C-c", "ctrl-c", "CTRL_C", "c-z", "C-\\", "enter", "up"],
		});
		expect(requests).toHaveLength(1);
		const operation = requests[0];
		expect(operation.op === "send" ? operation.keys : undefined).toEqual([
			"\u0004",
			"\u0004",
			"\u0004",
			"\u0004",
			"\u0003",
			"\u0003",
			"\u0003",
			"\u001a",
			"\u001c",
			"\r",
			"\u001b[A",
		]);
	});

	test("unknown keys are rejected before reaching the broker, naming the accepted keys", async () => {
		const requests = captureBroker();
		await expect(executeLaunch(session, { op: "send", name: "repl", keys: ["C-1"] })).rejects.toThrow(
			/Unsupported key "C-1"; accepted: Enter, Tab, Escape.*C-c, ctrl\+d, \^D/,
		);
		await expect(executeLaunch(session, { op: "send", name: "repl", keys: ["ctrl+dd"] })).rejects.toThrow(
			/Unsupported key "ctrl\+dd"/,
		);
		expect(requests).toHaveLength(0);
	});
});

describe("fleet restart", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Runs `body` against a real broker isolated in a temporary runtime directory. */
	async function withBroker(body: (session: ToolSession) => Promise<void>): Promise<void> {
		await using dir = await TempDir.create("@proto-fleet-restart-");
		const client = await launchClient.createDaemonBrokerClient(dir.path(), { runtimeDir: dir.join("run") });
		spyOn(launchClient, "daemonClientForProject").mockResolvedValue(client);
		try {
			await body({ cwd: dir.path() } as unknown as ToolSession);
		} finally {
			await client.request({ op: "shutdown" }).finally(() => client.close());
		}
	}

	function launchService(session: ToolSession, name: string, script: string, timeoutMs: number) {
		return executeLaunch(session, {
			op: "start",
			name,
			application: process.execPath,
			args: ["-e", `${script} process.stdin.resume();`],
			pty: false,
			ready: { log: "READY", timeoutMs },
		});
	}

	function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
		return result.content.find(block => block.type === "text")?.text ?? "";
	}

	test("returns the relaunched process's post-readiness state", async () => {
		await withBroker(async session => {
			// The broker runs on the real clock in its own process; the delay makes every launch start out not ready.
			const started = await launchService(session, "svc", 'setTimeout(() => console.log("READY"), 200);', 10_000);
			expect(started.details?.daemon?.state).toBe("ready");

			const restarted = await executeLaunch(session, { op: "restart", name: "svc" });
			expect(restarted.details?.timedOut).toBe(false);
			expect(restarted.details?.daemon).toMatchObject({ state: "ready", readyMatch: "READY" });
			expect(restarted.details?.daemon?.pid).not.toBe(started.details?.daemon?.pid);
			expect(resultText(restarted)).toStartWith("Restarted svc: ready ");
		});
	}, 20_000);

	test("reports a readiness timeout with the retained conditions, as start does", async () => {
		await withBroker(async session => {
			const started = await launchService(session, "stuck", "", 500);
			const restarted = await executeLaunch(session, { op: "restart", name: "stuck" });
			expect(restarted.details?.timedOut).toBe(true);
			expect(restarted.details?.daemon?.state).toBe("starting");
			const report = resultText(restarted).split("\n").slice(1);
			expect(report.join("\n")).toContain("readiness timed out after 500ms: log pattern /READY/ never matched");
			expect(report).toEqual(resultText(started).split("\n").slice(1));
		});
	}, 20_000);
});
