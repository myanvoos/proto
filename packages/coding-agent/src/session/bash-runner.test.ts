import { expect, spyOn, test } from "bun:test";
import type { Agent } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../config/settings";
import * as bashExecutor from "../exec/bash-executor";
import type { ExtensionRunner } from "../extensibility/extensions";
import { BashRunner, type BashRunnerHost } from "./bash-runner";
import type { BashExecutionMessage } from "./messages";
import { SessionManager } from "./session-manager";

test("idle BashRunner disposal retires its shell owner so late commands cannot start orphan shells", async () => {
	const sessionManager = SessionManager.inMemory();
	const host: BashRunnerHost = {
		agent: {} as Agent,
		sessionManager,
		settings: Settings.isolated({}),
		extensionRunner: () => undefined,
		isStreaming: () => false,
	};
	const registerSpy = spyOn(bashExecutor, "registerBashSessionOwner");
	try {
		const runner = new BashRunner(host);
		const owner = registerSpy.mock.results[0]?.value as bashExecutor.BashSessionOwner;
		await runner.dispose();
		await expect(
			bashExecutor.executeBash("true", {
				cwd: process.cwd(),
				sessionKey: owner.sessionId,
				sessionOwner: owner,
			}),
		).rejects.toThrow("Bash session is disposed");
	} finally {
		registerSpy.mockRestore();
		await sessionManager.close();
	}
});

test("leaving a session keeps pending bash receipts alive then retires the old shell owner", async () => {
	const sessionManager = SessionManager.inMemory();
	const hookStarted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const register = spyOn(bashExecutor, "registerBashSessionOwner");
	const host: BashRunnerHost = {
		agent: { appendMessage: () => {} } as unknown as Agent,
		sessionManager,
		settings: Settings.isolated({}),
		extensionRunner: () =>
			({
				hasHandlers: () => true,
				emitUserBash: async () => {
					hookStarted.resolve();
					await release.promise;
					return {
						result: {
							output: "retained receipt",
							exitCode: 0,
							cancelled: false,
							truncated: false,
							totalLines: 1,
							totalBytes: 16,
							outputLines: 1,
							outputBytes: 16,
						},
					};
				},
			}) as unknown as ExtensionRunner,
		isStreaming: () => false,
	};
	const runner = new BashRunner(host);
	try {
		const owner = register.mock.results[0]!.value as bashExecutor.BashSessionOwner;
		const pending = runner.executeBash("long running command");
		await hookStarted.promise;
		const transition = runner.beginSessionTransition();
		await sessionManager.newSession();
		runner.markSessionTransition(transition);
		runner.finishSessionTransition(transition, true);
		const oldShell = await bashExecutor.executeBash("printf alive", {
			cwd: process.cwd(),
			sessionKey: owner.sessionId,
			sessionOwner: owner,
		});
		expect(oldShell.output).toContain("alive");
		release.resolve();
		expect((await pending).output).toBe("retained receipt");
		await expect(
			bashExecutor.executeBash("true", { cwd: process.cwd(), sessionKey: owner.sessionId, sessionOwner: owner }),
		).rejects.toThrow("Bash session is disposed");
	} finally {
		release.resolve();
		register.mockRestore();
		await runner.dispose();
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

test("onRecorded receives the recorded ! run even when the callback throws", async () => {
	const sessionManager = SessionManager.inMemory();
	const host: BashRunnerHost = {
		agent: { appendMessage: () => {} } as unknown as Agent,
		sessionManager,
		settings: Settings.isolated({}),
		extensionRunner: () =>
			({
				hasHandlers: (event: string) => event === "user_bash",
				emitUserBash: async () => ({
					result: {
						output: "hooked",
						exitCode: 0,
						cancelled: false,
						truncated: false,
						totalLines: 1,
						totalBytes: 6,
						outputLines: 1,
						outputBytes: 6,
					},
				}),
			}) as unknown as ExtensionRunner,
		isStreaming: () => false,
	};
	const runner = new BashRunner(host);
	try {
		const recorded: BashExecutionMessage[] = [];
		await runner.executeBash("true", undefined, {
			onRecorded: message => {
				recorded.push(message);
				throw new Error("presenter redraw failed");
			},
		});

		// The callback's throw must not cost the run its record.
		const persisted = sessionManager
			.getBranch()
			.flatMap(entry => (entry.type === "message" && entry.message.role === "bashExecution" ? [entry.message] : []));
		expect(persisted).toHaveLength(1);
		expect(recorded.map(message => message.output)).toEqual(["hooked"]);
		expect(persisted[0]).toEqual(recorded[0]!);
	} finally {
		await runner.dispose();
		await sessionManager.close();
	}
});
