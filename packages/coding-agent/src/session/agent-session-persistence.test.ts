import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type DeveloperMessage,
	type ToolResultMessage,
	type UserMessage,
} from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Process } from "@oh-my-pi/pi-natives";
import type { ExtensionFactory } from "../extensibility/extensions";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import { executeList } from "../tools/fleet/messaging";
import type { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { readSessionLiveState } from "./session-liveness";
import { SessionManager } from "./session-manager";

const TEST_TIMESTAMP = 1_700_000_000_000;

type Harness = {
	session: AgentSession;
	sessionManager: SessionManager;
	authStorage: AuthStorage;
	agentDir: string;
};

function userMessage(content: string, timestamp = TEST_TIMESTAMP): UserMessage {
	return { role: "user", content, timestamp };
}

function branchMessages(sessionManager: SessionManager): UserMessage[] {
	return sessionManager
		.getBranch()
		.flatMap(entry => (entry.type === "message" && entry.message.role === "user" ? [entry.message] : []));
}

async function createHarness(
	persist = false,
	extensions: ExtensionFactory[] = [],
	agentRegistry?: AgentRegistry,
): Promise<Harness> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-persistence-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	let sessionManager = SessionManager.inMemory(process.cwd());
	try {
		if (persist) {
			sessionManager = await sessionManager.persistCopy({
				sessionDir: path.join(agentDir, "sessions"),
				suppressBreadcrumb: true,
			});
		}
		const { session } = await createAgentSession({
			cwd: process.cwd(),
			agentRegistry,
			agentDir,
			authStorage,
			sessionManager,
			disableExtensionDiscovery: true,
			enableMCP: false,
			workspaceTree: { rootPath: process.cwd(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			extensions,
		});
		return { session, sessionManager, authStorage, agentDir };
	} catch (error) {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
		throw error;
	}
}

async function closeHarness(harness: Harness): Promise<void> {
	await harness.session.dispose();
	harness.authStorage.close();
	await fs.rm(harness.agentDir, { recursive: true, force: true });
}

test("disposing an AgentSession terminates its persistent bash child", async () => {
	const harness = await createHarness();
	const pidFile = path.join(harness.agentDir, "bash-child.pid");
	let child: Process | null = null;
	try {
		await harness.session.executeBash(`sh -c 'sleep 60 & echo $! > "${pidFile}"; wait' &`);
		const pid = Number.parseInt(await Bun.file(pidFile).text(), 10);
		child = Process.fromPid(pid);
		expect(child).not.toBeNull();
		const started = performance.now();
		await harness.session.dispose();
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(await child!.waitForExit({ timeoutMs: 2_000 })).toBe(true);
	} finally {
		child?.killTree(9);
		await closeHarness(harness);
	}
}, 30_000);

let persistenceBarrierIndex = 0;

async function emitMessage(harness: Harness, message: AgentMessage): Promise<void> {
	const { session, sessionManager } = harness;
	const barrier: DeveloperMessage = {
		role: "developer",
		content: `persistence barrier ${persistenceBarrierIndex}`,
		timestamp: TEST_TIMESTAMP + 1_000 + persistenceBarrierIndex++,
	};
	const barrierSettled = Promise.withResolvers<void>();
	const previousOnEntryAppended = sessionManager.onEntryAppended;
	sessionManager.onEntryAppended = entry => {
		previousOnEntryAppended?.(entry);
		if (entry.type === "message" && entry.message === barrier) barrierSettled.resolve();
	};

	try {
		session.agent.emitExternalEvent({ type: "message_end", message });
		session.agent.emitExternalEvent({ type: "message_end", message: barrier });
		await barrierSettled.promise;
	} finally {
		sessionManager.onEntryAppended = previousOnEntryAppended;
	}
}

async function observesAgentEvent(session: AgentSession): Promise<boolean> {
	let observed = false;
	const unsubscribe = session.subscribe(event => {
		if (event.type === "message_start" && event.message.role === "developer") observed = true;
	});
	try {
		session.agent.emitExternalEvent({
			type: "message_start",
			message: { role: "developer", content: "connection probe", timestamp: TEST_TIMESTAMP },
		});
		const nextTurn = Promise.withResolvers<void>();
		setImmediate(nextTurn.resolve);
		await nextTurn.promise;
		return observed;
	} finally {
		unsubscribe();
	}
}

test("delivers message start before cumulative updates to subscribers and extensions", async () => {
	const startHookEntered = Promise.withResolvers<void>();
	const releaseStartHook = Promise.withResolvers<void>();
	const hookEvents: string[] = [];
	const extension: ExtensionFactory = api => {
		api.on("message_start", async () => {
			hookEvents.push("start");
			startHookEntered.resolve();
			await releaseStartHook.promise;
			hookEvents.push("start complete");
		});
		api.on("message_update", () => {
			hookEvents.push("update");
		});
	};
	const harness = await createHarness(false, [extension]);
	const subscriberEvents: string[] = [];
	const unsubscribe = harness.session.subscribe(event => {
		if (event.type === "message_start") subscriberEvents.push(event.type);
		if (event.type === "message_update" && event.message.role === "assistant") {
			const text = event.message.content.find(part => part.type === "text")?.text;
			subscriberEvents.push(`${event.type}:${text}`);
		}
	});
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "partial" }],
		api: "openai-completions",
		provider: "test",
		model: "test",
		stopReason: "stop",
		timestamp: TEST_TIMESTAMP,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	try {
		harness.session.agent.emitExternalEvent({ type: "message_start", message });
		harness.session.agent.emitExternalEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial", partial: message },
		});
		const latestMessage: AssistantMessage = {
			...message,
			content: [{ type: "text", text: "latest" }],
		};
		harness.session.agent.emitExternalEvent({
			type: "message_update",
			message: latestMessage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "latest", partial: latestMessage },
		});
		await startHookEntered.promise;
		const blockedTurn = Promise.withResolvers<void>();
		setImmediate(blockedTurn.resolve);
		await blockedTurn.promise;

		expect(hookEvents).toEqual(["start"]);
		expect(subscriberEvents).toEqual([]);

		releaseStartHook.resolve();
		const deliveredTurn = Promise.withResolvers<void>();
		setImmediate(deliveredTurn.resolve);
		await deliveredTurn.promise;
		expect(hookEvents).toEqual(["start", "start complete", "update"]);
		expect(subscriberEvents).toEqual(["message_start", "message_update:latest"]);
	} finally {
		releaseStartHook.resolve();
		unsubscribe();
		await closeHarness(harness);
	}
});

test("coalesces concurrent abort requests into one transaction", async () => {
	const harness = await createHarness();
	const agentAbortSpy = spyOn(harness.session.agent, "abort");
	try {
		const first = harness.session.abort({ reason: "first interrupt" });
		const second = harness.session.abort({ reason: "second interrupt" });

		expect(second).toBe(first);
		await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
		expect(agentAbortSpy).toHaveBeenCalledTimes(1);

		await expect(harness.session.abort({ reason: "later interrupt" })).resolves.toBeUndefined();
		expect(agentAbortSpy).toHaveBeenCalledTimes(2);
	} finally {
		agentAbortSpy.mockRestore();
		await closeHarness(harness);
	}
});

test.each(["new", "switch"] as const)("reconnects agent events when a %s-session abort fails", async operation => {
	const harness = await createHarness();
	const abortSpy = spyOn(harness.session, "abort").mockRejectedValueOnce(new Error("abort preparation failed"));
	try {
		const transition =
			operation === "new"
				? harness.session.newSession()
				: harness.session.switchSession(path.join(harness.agentDir, "unreached.jsonl"));
		await expect(transition).rejects.toThrow("abort preparation failed");
		abortSpy.mockRestore();

		expect(await observesAgentEvent(harness.session)).toBe(true);
	} finally {
		abortSpy.mockRestore();
		await closeHarness(harness);
	}
});

test("reconciles and reconnects when switch preparation fails", async () => {
	const harness = await createHarness();
	let rollbackReconciliations = 0;
	harness.session.setSessionBeforeSwitchReconciler(async () => {
		throw new Error("switch preparation failed");
	});
	harness.session.setSessionSwitchReconciler(async () => {
		rollbackReconciliations++;
	});
	try {
		await expect(harness.session.switchSession(path.join(harness.agentDir, "unreached.jsonl"))).rejects.toThrow(
			"switch preparation failed",
		);

		expect(rollbackReconciliations).toBe(1);
		expect(await observesAgentEvent(harness.session)).toBe(true);
	} finally {
		await closeHarness(harness);
	}
});

test("does not duplicate an identical persisted message", async () => {
	const harness = await createHarness();
	try {
		const persisted = userMessage("same");
		harness.sessionManager.appendMessage(persisted);

		await emitMessage(harness, userMessage("same"));

		expect(branchMessages(harness.sessionManager)).toHaveLength(1);
		expect(branchMessages(harness.sessionManager)[0]).toEqual(persisted);
	} finally {
		await closeHarness(harness);
	}
});

test("retains same-key messages with different content", async () => {
	const harness = await createHarness();
	try {
		harness.sessionManager.appendMessage(userMessage("first"));
		await emitMessage(harness, userMessage("second"));

		expect(branchMessages(harness.sessionManager).map(message => message.content)).toEqual(["first", "second"]);
	} finally {
		await closeHarness(harness);
	}
});

test("invalidates persisted candidates after branch and session switches", async () => {
	const harness = await createHarness();
	try {
		const persisted = userMessage("before switch");
		harness.sessionManager.appendMessage(persisted);
		await emitMessage(harness, userMessage("before switch"));

		harness.sessionManager.resetLeaf();
		await emitMessage(harness, userMessage("before switch"));
		expect(branchMessages(harness.sessionManager).map(message => message.content)).toEqual(["before switch"]);

		await harness.sessionManager.newSession();
		await emitMessage(harness, userMessage("before switch"));
		expect(branchMessages(harness.sessionManager).map(message => message.content)).toEqual(["before switch"]);
	} finally {
		await closeHarness(harness);
	}
});

test("updates the candidate index incrementally after appends", async () => {
	const harness = await createHarness();
	const getBranchSpy = spyOn(harness.sessionManager, "getBranch");
	try {
		harness.sessionManager.appendMessage(userMessage("first", TEST_TIMESTAMP));
		await emitMessage(harness, userMessage("first", TEST_TIMESTAMP));
		expect(getBranchSpy).toHaveBeenCalledTimes(1);

		await emitMessage(harness, userMessage("second", TEST_TIMESTAMP + 1));
		await emitMessage(harness, userMessage("second", TEST_TIMESTAMP + 1));
		expect(getBranchSpy).toHaveBeenCalledTimes(1);
		expect(
			harness.sessionManager
				.getEntries()
				.flatMap(entry =>
					entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
				),
		).toEqual(["first", "second"]);
	} finally {
		getBranchSpy.mockRestore();
		await closeHarness(harness);
	}
});

function sideAnswer(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Side answer" }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		stopReason: "stop",
		timestamp: TEST_TIMESTAMP,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

test.each(["first", "later"])("moves the live marker when branching from the %s user message", async position => {
	const harness = await createHarness(true);
	try {
		const previousFile = harness.session.sessionFile!;
		harness.sessionManager.resetLeaf();
		const firstId = harness.sessionManager.appendMessage(userMessage("first"));
		const laterId = harness.sessionManager.appendMessage(userMessage("later", TEST_TIMESTAMP + 1));

		const result = await harness.session.branch(position === "first" ? firstId : laterId);
		const nextFile = harness.session.sessionFile!;
		expect(result.cancelled).toBe(false);
		expect(nextFile).not.toBe(previousFile);
		expect(readSessionLiveState(nextFile).fresh).toBe(true);
		expect(readSessionLiveState(previousFile).fresh).toBe(false);
	} finally {
		await closeHarness(harness);
	}
});

test("moves the live marker to a side-question branch before it can be resumed", async () => {
	const harness = await createHarness(true);
	try {
		const previousFile = harness.session.sessionFile!;
		const leafId = harness.sessionManager.appendMessage(userMessage("main question"));
		const result = await harness.session.branchFromSideQuestion(
			"side question",
			sideAnswer(),
			leafId,
			harness.sessionManager.getSessionId(),
		);
		expect(result.cancelled).toBe(false);
		expect(result.sessionFile).not.toBe(previousFile);
		expect(readSessionLiveState(result.sessionFile!).fresh).toBe(true);
		expect(readSessionLiveState(previousFile).fresh).toBe(false);
	} finally {
		await closeHarness(harness);
	}
});

test.each(["branch", "side"])("keeps the original marker when an extension cancels %s", async mode => {
	const harness = await createHarness(true, [pi => pi.on("session_before_branch", () => ({ cancel: true }))]);
	try {
		const previousFile = harness.session.sessionFile!;
		const leafId = harness.sessionManager.appendMessage(userMessage("keep this session"));
		const result =
			mode === "branch"
				? await harness.session.branch(leafId)
				: await harness.session.branchFromSideQuestion(
						"side question",
						sideAnswer(),
						leafId,
						harness.sessionManager.getSessionId(),
					);
		expect(result.cancelled).toBe(true);
		expect(harness.session.sessionFile).toBe(previousFile);
		expect(readSessionLiveState(previousFile).fresh).toBe(true);
	} finally {
		await closeHarness(harness);
	}
});

test.each(["branch", "side"])("keeps the original marker after failed %s and abort", async mode => {
	const harness = await createHarness(true);
	const branchSpy = spyOn(harness.sessionManager, "createBranchedSession").mockImplementation(() => {
		throw new Error("branch persistence failed");
	});
	try {
		const previousFile = harness.session.sessionFile!;
		harness.sessionManager.appendMessage(userMessage("keep this session"));
		const leafId = harness.sessionManager.appendMessage(userMessage("branch here", TEST_TIMESTAMP + 1));
		const branching =
			mode === "branch"
				? harness.session.branch(leafId)
				: harness.session.branchFromSideQuestion(
						"side question",
						sideAnswer(),
						leafId,
						harness.sessionManager.getSessionId(),
					);
		await expect(branching).rejects.toThrow("branch persistence failed");
		expect(harness.session.sessionFile).toBe(previousFile);
		expect(readSessionLiveState(previousFile).fresh).toBe(true);
		await harness.session.abort();
		expect(readSessionLiveState(previousFile)).toMatchObject({ fresh: true, streaming: false });
	} finally {
		branchSpy.mockRestore();
		await closeHarness(harness);
	}
});

test.each(["branch", "side"])("follows the current file when %s fails after changing persistence", async mode => {
	const harness = await createHarness(true);
	const originalBranch = harness.sessionManager.createBranchedSession.bind(harness.sessionManager);
	const branchSpy = spyOn(harness.sessionManager, "createBranchedSession").mockImplementation(leafId => {
		originalBranch(leafId);
		throw new Error("branch failed after changing files");
	});
	try {
		const previousFile = harness.session.sessionFile!;
		harness.sessionManager.appendMessage(userMessage("retain this history"));
		const leafId = harness.sessionManager.appendMessage(userMessage("branch here", TEST_TIMESTAMP + 1));
		const branching =
			mode === "branch"
				? harness.session.branch(leafId)
				: harness.session.branchFromSideQuestion(
						"side question",
						sideAnswer(),
						leafId,
						harness.sessionManager.getSessionId(),
					);
		await expect(branching).rejects.toThrow("branch failed after changing files");
		const currentFile = harness.session.sessionFile!;
		expect(currentFile).not.toBe(previousFile);
		expect(readSessionLiveState(currentFile).fresh).toBe(true);
		expect(readSessionLiveState(previousFile).fresh).toBe(false);
	} finally {
		branchSpy.mockRestore();
		await closeHarness(harness);
	}
});

test.each(["new", "fork", "move"])("moves the live marker after a %s session transition", async operation => {
	const harness = await createHarness(true);
	try {
		const previousFile = harness.session.sessionFile!;
		harness.sessionManager.appendMessage(userMessage("persist the original session"));
		await harness.sessionManager.flush();
		if (operation === "new") expect(await harness.session.newSession()).toBe(true);
		else if (operation === "fork") expect(await harness.session.fork()).toBe(true);
		else await harness.session.moveSession(harness.agentDir, path.join(harness.agentDir, "moved-sessions"));

		const nextFile = harness.session.sessionFile!;
		expect(nextFile).not.toBe(previousFile);
		expect(readSessionLiveState(nextFile).fresh).toBe(true);
		expect(readSessionLiveState(previousFile).fresh).toBe(false);
	} finally {
		await closeHarness(harness);
	}
});

test("a new session cannot list parked agents from the previous session fleet", async () => {
	const registry = new AgentRegistry();
	const harness = await createHarness(true, [], registry);
	try {
		const previousFile = harness.session.sessionFile!;
		const previousFleetRoot = path.resolve(previousFile.slice(0, -".jsonl".length), "fleet");
		registry.register({
			id: "old-peer",
			label: "old-peer",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: path.join(previousFleetRoot, "old-peer.jsonl"),
			fleetRoot: previousFleetRoot,
			status: "parked",
		});
		const before = await executeList(registry, MAIN_AGENT_ID);
		const beforeText = before.content.find(part => part.type === "text")?.text ?? "";
		expect(beforeText).toContain("old-peer");

		expect(await harness.session.newSession()).toBe(true);

		const currentFile = harness.session.sessionFile!;
		const currentFleetRoot = path.resolve(currentFile.slice(0, -".jsonl".length), "fleet");
		expect(currentFleetRoot).not.toBe(previousFleetRoot);
		expect(registry.get(MAIN_AGENT_ID)).toMatchObject({
			fleetRoot: currentFleetRoot,
			sessionFile: currentFile,
		});
		const after = await executeList(registry, MAIN_AGENT_ID);
		const afterText = after.content.find(part => part.type === "text")?.text ?? "";
		expect(afterText).toBe("No other agents.");
	} finally {
		await closeHarness(harness);
	}
});

test("nonpersistent resume exposes disk history without writing or claiming its source", async () => {
	const harness = await createHarness();
	try {
		harness.sessionManager.appendMessage(userMessage("VISIBLE_IMPORTED_HISTORY"));
		const source = await harness.sessionManager.persistCopy({
			sessionDir: path.join(harness.agentDir, "resume-source"),
			suppressBreadcrumb: true,
		});
		const sourceFile = source.getSessionFile()!;
		await source.close();
		const original = await Bun.file(sourceFile).text();
		await harness.session.newSession();
		expect(await harness.session.switchSession(sourceFile)).toBe(true);
		expect(JSON.stringify(harness.session.agent.state.messages)).toContain("VISIBLE_IMPORTED_HISTORY");
		expect(harness.session.sessionFile).toBeUndefined();
		expect(readSessionLiveState(sourceFile).fresh).toBe(false);
		await emitMessage(harness, userMessage("UNSAVED_AFTER_RESUME"));
		await harness.sessionManager.flush();
		expect(JSON.stringify(harness.session.agent.state.messages)).toContain("VISIBLE_IMPORTED_HISTORY");
		expect(branchMessages(harness.sessionManager).some(message => message.content === "UNSAVED_AFTER_RESUME")).toBe(
			true,
		);
		expect(await Bun.file(sourceFile).text()).toBe(original);
		const corrupt = path.join(harness.agentDir, "corrupt.jsonl");
		await Bun.write(corrupt, "{invalid header\n");
		await expect(harness.session.switchSession(corrupt)).rejects.toThrow("header is missing or malformed");
		expect(harness.session.sessionFile).toBeUndefined();
		expect(branchMessages(harness.sessionManager).some(message => message.content === "UNSAVED_AFTER_RESUME")).toBe(
			true,
		);
		expect(await Bun.file(sourceFile).text()).toBe(original);
	} finally {
		await closeHarness(harness);
	}
});

test("marks a resumed file live before reconciliation and restores liveness after a failed switch", async () => {
	const harness = await createHarness(true);
	try {
		const previousFile = harness.session.sessionFile!;
		harness.sessionManager.appendMessage(userMessage("resume this history"));
		await harness.sessionManager.flush();
		const target = await harness.sessionManager.persistCopy({
			sessionDir: path.join(harness.agentDir, "target-sessions"),
			suppressBreadcrumb: true,
		});
		const targetFile = target.getSessionFile()!;
		await target.close();
		let liveDuringReconciliation = false;
		harness.session.setSessionSwitchReconciler(async () => {
			liveDuringReconciliation = readSessionLiveState(harness.session.sessionFile!).fresh;
		});

		expect(await harness.session.switchSession(targetFile)).toBe(true);
		expect(liveDuringReconciliation).toBe(true);
		expect(readSessionLiveState(previousFile).fresh).toBe(false);

		const contextSpy = spyOn(harness.session, "buildDisplaySessionContext").mockImplementationOnce(() => {
			throw new Error("restoring switched history failed");
		});
		try {
			await expect(harness.session.switchSession(previousFile)).rejects.toThrow("restoring switched history failed");
			expect(harness.session.sessionFile).toBe(targetFile);
			expect(readSessionLiveState(targetFile).fresh).toBe(true);
			expect(readSessionLiveState(previousFile).fresh).toBe(false);
		} finally {
			contextSpy.mockRestore();
		}
	} finally {
		await closeHarness(harness);
	}
});

test("preserves streaming liveness when the session file moves during a running turn", async () => {
	const harness = await createHarness(true);
	try {
		const stream = createAssistantMessageEventStream();
		const started = Promise.withResolvers<void>();
		harness.session.agent.setModel(
			buildModel({
				id: "heartbeat-test",
				name: "Heartbeat Test",
				api: "openai-responses",
				provider: "heartbeat-test",
				baseUrl: "http://127.0.0.1:9",
				reasoning: false,
				input: ["text"],
				contextWindow: 128_000,
				maxTokens: 4_096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		);
		harness.session.agent.getApiKey = () => "test";
		harness.session.agent.streamFn = () => {
			started.resolve();
			return stream;
		};
		const running = harness.session.agent.prompt(userMessage("keep streaming while moving"));
		try {
			await Promise.race([
				started.promise,
				running.then(() => {
					throw new Error("Turn ended before the provider stream started");
				}),
			]);
			const previousFile = harness.session.sessionFile!;
			expect(readSessionLiveState(previousFile)).toMatchObject({ fresh: true, streaming: true });
			await harness.session.moveSession(harness.agentDir, path.join(harness.agentDir, "streaming-session"));
			expect(readSessionLiveState(harness.session.sessionFile!)).toMatchObject({ fresh: true, streaming: true });
			expect(readSessionLiveState(previousFile).fresh).toBe(false);
		} finally {
			stream.push({ type: "done", reason: "stop", message: sideAnswer() });
			await running;
		}
		await harness.session.waitForIdle();
		expect(readSessionLiveState(harness.session.sessionFile!)).toMatchObject({ fresh: true, streaming: false });
	} finally {
		await closeHarness(harness);
	}
});

test("keeps the session live until disposal has closed its persistence writer", async () => {
	const harness = await createHarness(true);
	const closing = Promise.withResolvers<void>();
	const releaseClose = Promise.withResolvers<void>();
	const originalClose = harness.sessionManager.close.bind(harness.sessionManager);
	const closeSpy = spyOn(harness.sessionManager, "close").mockImplementation(async () => {
		closing.resolve();
		await releaseClose.promise;
		await originalClose();
	});
	let disposing: Promise<void> | undefined;
	try {
		harness.sessionManager.appendMessage(userMessage("persist before disposal"));
		await harness.sessionManager.flush();
		const sessionFile = harness.session.sessionFile!;
		harness.session.beginDispose();
		expect(readSessionLiveState(sessionFile).fresh).toBe(true);
		disposing = harness.session.dispose();
		await closing.promise;
		expect(readSessionLiveState(sessionFile).fresh).toBe(true);
		releaseClose.resolve();
		await disposing;
		expect(readSessionLiveState(sessionFile).fresh).toBe(false);
	} finally {
		releaseClose.resolve();
		await disposing;
		closeSpy.mockRestore();
		await closeHarness(harness);
	}
});

test("rewinding across a prune shows gutted history", async () => {
	const harness = await createHarness(true);
	const originalToolOutput = `original tool output ${"content ".repeat(200)}`;
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	try {
		harness.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "read-old", name: "read", arguments: { path: "shared.ts" } }],
			api: "openai-completions",
			provider: "test",
			model: "test",
			stopReason: "toolUse",
			timestamp: TEST_TIMESTAMP,
			usage,
		});
		const oldResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "read-old",
			toolName: "read",
			content: [{ type: "text", text: originalToolOutput }],
			isError: false,
			timestamp: TEST_TIMESTAMP + 1,
		};
		const oldResultId = harness.sessionManager.appendMessage(oldResult);
		harness.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "read-new", name: "read", arguments: { path: "shared.ts" } }],
			api: "openai-completions",
			provider: "test",
			model: "test",
			stopReason: "toolUse",
			timestamp: TEST_TIMESTAMP + 2,
			usage,
		});
		const activeLeafId = harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "read-new",
			toolName: "read",
			content: [{ type: "text", text: "newer tool output" }],
			isError: false,
			timestamp: TEST_TIMESTAMP + 3,
		});
		const siblingLeafId = harness.sessionManager.appendMessageToBranch(
			userMessage("sibling branch", TEST_TIMESTAMP + 4),
			oldResultId,
		);
		harness.sessionManager.branch(activeLeafId);

		harness.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "openai-completions",
			provider: "test",
			model: "test",
			stopReason: "stop",
			timestamp: TEST_TIMESTAMP + 5,
			usage,
		});
		harness.session.agent.replaceMessages(harness.session.buildDisplaySessionContext().messages);
		const maintenanceFinished = Promise.withResolvers<void>();
		const unsubscribe = harness.session.subscribe(event => {
			if (event.type === "agent_end") maintenanceFinished.resolve();
		});
		try {
			harness.session.agent.emitExternalEvent({ type: "agent_end", messages: harness.session.messages });
			await maintenanceFinished.promise;
		} finally {
			unsubscribe();
		}

		const modelResult = harness.session.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === "read-old",
		);
		expect(modelResult?.content).not.toEqual(oldResult.content);
		expect(modelResult?.content[0]).toEqual({ type: "text", text: "[Superseded by a newer read of this file]" });

		const outputOnBranch = (leafId: string): string | undefined => {
			const entry = harness.sessionManager.getBranch(leafId).find(candidate => candidate.id === oldResultId);
			if (entry?.type !== "message" || entry.message.role !== "toolResult") return undefined;
			return entry.message.content[0]?.type === "text" ? entry.message.content[0].text : undefined;
		};
		expect(outputOnBranch(activeLeafId)).toBe(originalToolOutput);
		expect(outputOnBranch(oldResultId)).toBe(originalToolOutput);
		expect(outputOnBranch(siblingLeafId)).toBe(originalToolOutput);

		await harness.sessionManager.flush();
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		expect(await Bun.file(sessionFile).text()).toContain(originalToolOutput);
	} finally {
		await closeHarness(harness);
	}
});

test("dropping images preserves rewound and sibling history", async () => {
	const harness = await createHarness(true);
	const originalImage = Buffer.from("original image bytes").toString("base64");
	try {
		const rootId = harness.sessionManager.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "root message" },
				{ type: "image", data: originalImage, mimeType: "image/png" },
			],
			timestamp: TEST_TIMESTAMP,
		});
		const activeLeafId = harness.sessionManager.appendMessage(userMessage("active branch", TEST_TIMESTAMP + 1));
		const siblingLeafId = harness.sessionManager.appendMessageToBranch(
			userMessage("sibling branch", TEST_TIMESTAMP + 2),
			rootId,
		);
		harness.sessionManager.branch(activeLeafId);
		await harness.sessionManager.ensureOnDisk();
		await harness.sessionManager.flush();
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const persistedBefore = await Bun.file(sessionFile).text();
		const result = await harness.session.dropImages();
		expect(result).toEqual({ removed: 1 });
		expect(
			harness.session.messages.some(
				message =>
					"content" in message &&
					Array.isArray(message.content) &&
					message.content.some(part => part.type === "image"),
			),
		).toBe(false);

		const imageOnBranch = (leafId: string): string | undefined => {
			const root = harness.sessionManager.getBranch(leafId).find(entry => entry.id === rootId);
			if (root?.type !== "message" || !("content" in root.message) || !Array.isArray(root.message.content)) {
				return undefined;
			}
			return root.message.content.find(part => part.type === "image")?.data;
		};
		expect(imageOnBranch(activeLeafId)).toBe(originalImage);
		expect(imageOnBranch(rootId)).toBe(originalImage);
		expect(imageOnBranch(siblingLeafId)).toBe(originalImage);

		await harness.sessionManager.flush();
		expect(await Bun.file(sessionFile).text()).toBe(persistedBefore);
	} finally {
		await closeHarness(harness);
	}
});
