import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { fsObservationLedger } from "../eval/fs-observations";
import { EvalRunner, type EvalRunnerHost } from "./eval-runner";
import type { PythonExecutionMessage } from "./messages";
import { SessionManager } from "./session-manager";

function runner(sessionId: string, ownerId: string): EvalRunner {
	const host = {
		sessionManager: SessionManager.inMemory("/tmp"),
	} as unknown as EvalRunnerHost;
	return new EvalRunner(host, { kernelOwnerId: ownerId, parentSessionId: sessionId });
}

function readObservation(path: string) {
	return { path, kind: "read" as const, mtimeNs: null, size: null };
}

test("eval runner releases observations only after the last shared session owner", () => {
	const sessionId = `eval-runner-shared-${crypto.randomUUID()}`;
	const first = runner(sessionId, "owner-a");
	const second = runner(sessionId, "owner-b");
	first.getSessionId();
	second.getSessionId();
	fsObservationLedger(sessionId).record(readObservation("/shared-observation"));

	first.beginDispose();
	first.disposeObservations();
	expect(fsObservationLedger(sessionId).drain()).toEqual([readObservation("/shared-observation")]);

	fsObservationLedger(sessionId).record(readObservation("/discard-on-final-release"));
	second.beginDispose();
	second.disposeObservations();
	expect(fsObservationLedger(sessionId).drain()).toEqual([]);
});

test("eval runner discards the previous ledger when its session changes", async () => {
	using directory = TempDir.createSync("@eval-runner-session-");
	const manager = SessionManager.create("/tmp", directory.path());
	const host = {
		sessionManager: manager,
	} as unknown as EvalRunnerHost;
	const evalRunner = new EvalRunner(host, { kernelOwnerId: "switching-owner", parentSessionId: undefined });
	const previousSessionId = evalRunner.getSessionId();
	if (previousSessionId === null) throw new Error("expected an eval session id");
	fsObservationLedger(previousSessionId).record(readObservation("/previous-session"));

	await manager.newSession();
	evalRunner.syncObservationSession();

	expect(fsObservationLedger(previousSessionId).drain()).toEqual([]);
	evalRunner.beginDispose();
	evalRunner.disposeObservations();
	await manager.close();
});

test("aborting a user-python hook discards its late displays and persistence", async () => {
	const hookStarted = Promise.withResolvers<void>();
	const hookResult = Promise.withResolvers<{
		result: {
			output: string;
			exitCode: number;
			cancelled: boolean;
			truncated: boolean;
			totalLines: number;
			totalBytes: number;
			outputLines: number;
			outputBytes: number;
			displayOutputs: Array<{ type: "markdown"; text: string }>;
			stdinRequested: boolean;
		};
	}>();
	let hookSignal: AbortSignal | undefined;
	const persisted: unknown[] = [];
	const displayed: unknown[] = [];
	const host = {
		sessionManager: SessionManager.inMemory("/tmp"),
		extensionRunner: () =>
			({
				hasHandlers: (event: string) => event === "user_python",
				emitUserPython: (_event: unknown, signal?: AbortSignal) => {
					hookSignal = signal;
					hookStarted.resolve();
					return hookResult.promise;
				},
			}) as unknown,
		isStreaming: () => false,
		appendSessionMessage: (message: unknown) => persisted.push(message),
	} as unknown as EvalRunnerHost;
	const evalRunner = new EvalRunner(host, { kernelOwnerId: "hook-abort-owner", parentSessionId: "hook-abort" });
	const execution = evalRunner.executePython("print('late')", undefined, {
		onDisplay: output => {
			displayed.push(output);
		},
	});
	await hookStarted.promise;
	evalRunner.abort();
	hookResult.resolve({
		result: {
			output: "late output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 11,
			outputLines: 1,
			outputBytes: 11,
			displayOutputs: [{ type: "markdown", text: "late display" }],
			stdinRequested: false,
		},
	});

	await expect(execution).rejects.toThrow();
	expect(hookSignal?.aborted).toBe(true);
	expect(displayed).toEqual([]);
	expect(persisted).toEqual([]);
	evalRunner.beginDispose();
	evalRunner.disposeObservations();
});

test("onRecorded receives the recorded $ run even when the callback throws", async () => {
	const persisted: PythonExecutionMessage[] = [];
	const host = {
		sessionManager: SessionManager.inMemory("/tmp"),
		extensionRunner: () =>
			({
				hasHandlers: (event: string) => event === "user_python",
				emitUserPython: async () => ({
					result: {
						output: "hooked",
						exitCode: 0,
						cancelled: false,
						truncated: false,
						totalLines: 1,
						totalBytes: 6,
						outputLines: 1,
						outputBytes: 6,
						displayOutputs: [],
						stdinRequested: false,
					},
				}),
			}) as unknown,
		isStreaming: () => false,
		appendSessionMessage: (message: PythonExecutionMessage) => persisted.push(message),
	} as unknown as EvalRunnerHost;
	const evalRunner = new EvalRunner(host, { kernelOwnerId: "recorded-owner", parentSessionId: "recorded" });
	const recorded: PythonExecutionMessage[] = [];
	const result = await evalRunner.executePython("1", undefined, {
		onRecorded: message => {
			recorded.push(message);
			throw new Error("presenter redraw failed");
		},
	});

	// The callback's throw must not cost the cell its record.
	expect(result.output).toBe("hooked");
	expect(persisted).toHaveLength(1);
	expect(recorded).toHaveLength(1);
	expect(recorded[0]).toBe(persisted[0]!);
	evalRunner.beginDispose();
	evalRunner.disposeObservations();
});
