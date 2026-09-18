import { expect, spyOn, test } from "bun:test";
import type { Agent } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../config/settings";
import * as bashExecutor from "../exec/bash-executor";
import type { ExtensionRunner } from "../extensibility/extensions";
import { BashRunner, type BashRunnerHost } from "./bash-runner";
import { SessionManager } from "./session-manager";

test("idle BashRunner disposal does not close shell sessions", async () => {
	const sessionManager = SessionManager.inMemory();
	const host: BashRunnerHost = {
		agent: {} as Agent,
		sessionManager,
		settings: Settings.isolated({}),
		extensionRunner: () => undefined,
		isStreaming: () => false,
	};
	const runner = new BashRunner(host);
	const disposeSpy = spyOn(bashExecutor, "disposeBashSessions");
	try {
		await runner.dispose();
		expect(disposeSpy).not.toHaveBeenCalled();
	} finally {
		disposeSpy.mockRestore();
		await sessionManager.close();
	}
});

test("aborting a user-bash hook rejects its late result without persistence", async () => {
	const sessionManager = SessionManager.inMemory();
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
		};
	}>();
	let hookSignal: AbortSignal | undefined;
	const host: BashRunnerHost = {
		agent: { appendMessage: () => {} } as unknown as Agent,
		sessionManager,
		settings: Settings.isolated({}),
		extensionRunner: () =>
			({
				hasHandlers: (event: string) => event === "user_bash",
				emitUserBash: (_event: unknown, signal?: AbortSignal) => {
					hookSignal = signal;
					hookStarted.resolve();
					return hookResult.promise;
				},
			}) as unknown as ExtensionRunner,
		isStreaming: () => false,
	};
	const runner = new BashRunner(host);
	try {
		const execution = runner.executeBash("printf late");
		await hookStarted.promise;
		runner.abort();
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
			},
		});

		await expect(execution).rejects.toThrow();
		expect(hookSignal?.aborted).toBe(true);
		expect(
			sessionManager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "bashExecution"),
		).toHaveLength(0);
	} finally {
		await runner.dispose();
		await sessionManager.close();
	}
});
