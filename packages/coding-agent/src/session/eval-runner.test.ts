import { expect, test } from "bun:test";
import { fsObservationLedger } from "../eval/fs-observations";
import { EvalRunner, type EvalRunnerHost } from "./eval-runner";

function runner(sessionId: string, ownerId: string): EvalRunner {
	const host = {
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionFile: () => `/tmp/${sessionId}.jsonl`,
		},
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

test("eval runner discards the previous ledger when its session changes", () => {
	let sessionFile = `/tmp/eval-runner-before-${crypto.randomUUID()}.jsonl`;
	const host = {
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionFile: () => sessionFile,
		},
	} as unknown as EvalRunnerHost;
	const evalRunner = new EvalRunner(host, { kernelOwnerId: "switching-owner", parentSessionId: undefined });
	const previousSessionId = evalRunner.getSessionId();
	if (previousSessionId === null) throw new Error("expected an eval session id");
	fsObservationLedger(previousSessionId).record(readObservation("/previous-session"));

	sessionFile = `/tmp/eval-runner-after-${crypto.randomUUID()}.jsonl`;
	evalRunner.syncObservationSession();

	expect(fsObservationLedger(previousSessionId).drain()).toEqual([]);
	evalRunner.beginDispose();
	evalRunner.disposeObservations();
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
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionFile: () => "/tmp/eval-hook-abort.jsonl",
		},
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
