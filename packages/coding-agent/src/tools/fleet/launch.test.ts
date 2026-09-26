import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
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
