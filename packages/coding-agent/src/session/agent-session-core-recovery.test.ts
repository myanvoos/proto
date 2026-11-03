import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "../async/job-manager";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionMaintenance } from "./session-maintenance";
import { SessionManager } from "./session-manager";
import { TurnRecovery } from "./turn-recovery";

describe("session recovery ownership", () => {
	let session: AgentSession | undefined;
	let auth: AuthStorage;
	let manager: AsyncJobManager | undefined;
	let sessionDir: string | undefined;

	beforeEach(async () => {
		auth = await AuthStorage.create(":memory:");
		auth.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		await manager?.dispose();
		if (sessionDir) await fs.rm(sessionDir, { recursive: true, force: true });
		sessionDir = undefined;
		auth.close();
		session = undefined;
		manager = undefined;
	});

	function createSession(
		responses: MockResponse[] = [{ content: ["done"] }],
		awaitingAssignment = false,
		sessionManager = SessionManager.inMemory(),
	): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");
		session = new AgentSession({
			awaitingAssignment,
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: createMockModel({ responses }).stream,
			}),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.maxDelayMs": 100,
				"retry.maxRetries": 1,
				"retry.modelFallback": false,
			}),
			modelRegistry: new ModelRegistry(auth),
			asyncJobManager: manager,
		});
		return session;
	}

	it("restores typed input when missing credentials reject it before dispatch", async () => {
		const current = createSession();
		vi.spyOn(current.modelRegistry, "getApiKey").mockResolvedValue(undefined);
		const dropped: string[] = [];
		current.setPromptDropped(prompt => {
			dropped.push(prompt.text);
		});
		await expect(current.prompt("keep this draft")).rejects.toThrow("No API key found");
		expect(dropped).toEqual(["keep this draft"]);
		expect(current.messages).toEqual([]);
	});

	it("parks a steer submitted during client preflight and injects it into that client's live turn", async () => {
		const current = createSession([
			{ content: [{ type: "toolCall", id: "wait", name: "wait", arguments: {} }] },
			{ content: ["completed with steering"] },
		]);
		const toolStarted = Promise.withResolvers<void>();
		const finishTool = Promise.withResolvers<void>();
		const tool: AgentTool = {
			name: "wait",
			label: "wait",
			description: "wait",
			parameters: type({}),
			execute: async () => {
				toolStarted.resolve();
				await finishTool.promise;
				return { content: [] };
			},
		};
		current.agent.setTools([tool]);
		const preflight = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const getApiKey = current.modelRegistry.getApiKey.bind(current.modelRegistry);
		vi.spyOn(current.modelRegistry, "getApiKey").mockImplementation(async (...args) => {
			preflight.resolve();
			await release.promise;
			return getApiKey(...args);
		});
		const prompt = current.prompt("start the owned turn");
		await preflight.promise;
		let settled = false;
		const joined = current.joinActiveTurn("queued during preflight").then(value => {
			settled = true;
			return value;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		release.resolve();
		await toolStarted.promise;
		expect(await joined).toBe(true);
		finishTool.resolve();
		await prompt;
		await current.waitForIdle();
		expect(
			current.messages
				.filter(message => message.role === "user")
				.map(message =>
					typeof message.content === "string"
						? message.content
						: message.content
								.filter(block => block.type === "text")
								.map(block => block.text)
								.join(""),
				),
		).toEqual(["start the owned turn", "queued during preflight"]);
	});

	it("returns a parked steer to its caller when client preflight aborts instead of starting an autonomous turn", async () => {
		const current = createSession();
		const preflight = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(current.modelRegistry, "getApiKey").mockImplementation(async () => {
			preflight.resolve();
			await release.promise;
			return "test-key";
		});
		const prompt = current.prompt("cancel before start");
		await preflight.promise;
		const joined = current.joinActiveTurn("keep this steer");
		const aborted = current.abort();
		release.resolve();
		await aborted;
		await prompt;
		expect(await joined).toBe(false);
		expect(current.agent.hasQueuedMessages()).toBe(false);
	});

	it("subtracts stripped message and custom images from the provider anchor while counting later images only once", async () => {
		const current = createSession();
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
		current.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before" }, image],
			timestamp: 1,
		});
		current.sessionManager.appendCustomMessageEntry("attached", [image], false);
		const model = current.model!;
		const anchor: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "text", text: "provider anchor" }],
			stopReason: "stop",
			timestamp: 2,
			usage: {
				input: 100_000,
				output: 0,
				totalTokens: 100_000,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		current.sessionManager.appendMessage(anchor);
		current.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after" }, image],
			timestamp: 3,
		});
		current.agent.replaceMessages(current.sessionManager.buildSessionContext().messages);
		const before = current.getContextBreakdown()!.usedTokens;
		const result = await current.dropImages();
		expect(result.removed).toBe(3);
		expect(before - current.getContextBreakdown()!.usedTokens).toBe(result.tokensFreed);
		expect(result.tokensFreed).toBeGreaterThan(0);
		const after = current.getContextBreakdown()!.usedTokens;
		expect(await current.dropImages()).toEqual({ removed: 0, tokensFreed: 0 });
		expect(current.getContextBreakdown()!.usedTokens).toBe(after);
	});

	it.each(["work", "rewind"])(
		"preserves an aborted running %s result only when it describes an applied operation",
		async toolName => {
			sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-transition-results-"));
			const current = createSession(
				[{ content: [{ type: "toolCall", id: "call", name: toolName, arguments: {} }] }],
				false,
				SessionManager.create(sessionDir, sessionDir),
			);
			const started = Promise.withResolvers<void>();
			const tool: AgentTool = {
				name: toolName,
				label: toolName,
				description: toolName,
				parameters: type({}),
				execute: async (_id, _args, signal) => {
					const aborted = Promise.withResolvers<void>();
					if (signal?.aborted) aborted.resolve();
					else signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
					started.resolve();
					await aborted.promise;
					return { content: [{ type: "text", text: "real final tool receipt" }] };
				},
			};
			current.agent.setTools([tool]);
			const prompt = current.prompt("start a long running tool");
			await started.promise;
			await current.sessionManager.flush();
			const previousFile = current.sessionFile!;
			await current.newSession();
			await prompt;
			const reopened = await SessionManager.open(previousFile);
			const saved = reopened.getEntries();
			await reopened.close();
			const results = saved.filter(entry => entry.type === "message" && entry.message.role === "toolResult");
			if (toolName === "rewind") expect(results).toHaveLength(0);
			else
				expect(results).toMatchObject([
					{ message: { role: "toolResult", toolCallId: "call", content: [{ text: "real final tool receipt" }] } },
				]);
		},
	);

	it.each([false, true])(
		"retries a waiting unnamed title unless its lifecycle was interrupted (%s)",
		async interrupted => {
			const previous = Bun.env.PI_NO_TITLE;
			delete Bun.env.PI_NO_TITLE;
			try {
				const current = createSession();
				const first = Promise.withResolvers<string | null>();
				const second = Promise.withResolvers<void>();
				const settled = Promise.withResolvers<void>();
				const titled = vi.spyOn(current, "generateTitle").mockImplementation(async input => {
					if (input === "repair the first authentication failure") return first.promise;
					second.resolve();
					return "Authentication Repaired";
				});
				current.maybeStartTitleGeneration("repair the first authentication failure", () => () => settled.resolve());
				current.maybeStartTitleGeneration("repair the second authentication failure");
				if (interrupted) await current.abort();
				first.resolve(null);
				await settled.promise;
				if (interrupted) expect(titled).toHaveBeenCalledTimes(1);
				else {
					await second.promise;
					expect(titled.mock.calls.map(call => call[0])).toEqual([
						"repair the first authentication failure",
						"repair the second authentication failure",
					]);
				}
			} finally {
				if (previous === undefined) delete Bun.env.PI_NO_TITLE;
				else Bun.env.PI_NO_TITLE = previous;
			}
		},
	);

	it("runs a new continuation for a steer arriving after the previous continuation's final poll", async () => {
		const current = createSession();
		let calls = 0;
		vi.spyOn(current.agent, "continue").mockImplementation(async () => {
			calls++;
			if (calls === 1) {
				current.agent.steer({ role: "user", content: "stranded", timestamp: Date.now() });
			} else {
				current.agent.replaceQueues([], []);
			}
		});
		current.resumeAfterAskReanswer();
		await current.waitForIdle();
		expect(calls).toBe(2);
		expect(current.agent.hasQueuedMessages()).toBe(false);
	});

	it("closes the retry lifecycle when the successful assistant message settles, before terminal routing", async () => {
		const original = TurnRecovery.prototype.onAssistantSettledSuccessfully;
		const observed: boolean[] = [];
		vi.spyOn(TurnRecovery.prototype, "onAssistantSettledSuccessfully").mockImplementation(async function (
			this: TurnRecovery,
			message,
		) {
			const retrying = this.retryPromise !== undefined;
			await original.call(this, message);
			if (retrying) observed.push(this.retryPromise === undefined);
		});
		const current = createSession([{ throw: "503 service unavailable" }, { content: ["recovered"] }]);
		await current.prompt("retry then recover");
		expect(observed).toEqual([true]);
		expect(current.isRetrying).toBe(false);
	});

	it.each([undefined, "nextTurn"] as const)(
		"does not report a dispatched %s custom turn when preflight is aborted",
		async deliverAs => {
			const current = createSession();
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			vi.spyOn(TurnRecovery.prototype, "maybeApplyUsageAwareFallback").mockImplementation(async () => {
				started.resolve();
				await release.promise;
				return false;
			});
			const prompt = vi.spyOn(current.agent, "prompt");
			const sent = current.sendCustomMessage(
				{ customType: "test", content: "cancelled", display: false },
				{ triggerTurn: true, deliverAs },
			);
			await started.promise;
			const aborted = current.abort();
			release.resolve();
			expect(await sent).toBe(false);
			await aborted;
			expect(prompt).not.toHaveBeenCalled();
		},
	);

	it("keeps the async result pending until its model-context delivery is committed", async () => {
		manager = new AsyncJobManager({});
		const current = createSession();
		current.agent.state.isStreaming = true;
		const queued = Promise.withResolvers<void>();
		const enqueue = current.yieldQueue.enqueueWithReceipt.bind(current.yieldQueue);
		vi.spyOn(current.yieldQueue, "enqueueWithReceipt").mockImplementation((kind, entry) => {
			const receipt = enqueue(kind, entry);
			queued.resolve();
			return receipt;
		});
		const jobId = manager.register("bash", "retained result", async () => "job result", {
			ownerId: current.getAsyncJobOwnerId(),
		});
		await manager.waitForAll();
		await queued.promise;
		expect(manager.getDeliveryState().pendingJobIds).toContain(jobId);
		expect(manager.getJob(jobId)?.resultText).toBe("job result");
		current.agent.state.isStreaming = false;
		await current.yieldQueue.flush("idle");
		expect(await manager.drainDeliveries({ timeoutMs: 1000 })).toBe(true);
		expect(manager.getDeliveryState().pendingJobIds).not.toContain(jobId);
		expect(current.messages.some(message => message.role === "custom" && message.customType === "async-result")).toBe(
			true,
		);
	});

	it("dispatches each consecutive signed-thinking-only recovery instead of coalescing the next turn into its ended predecessor", async () => {
		const current = createSession([
			{ content: [{ type: "thinking", thinking: "", thinkingSignature: "first-signed-stop" }] },
			{ content: [{ type: "thinking", thinking: "", thinkingSignature: "second-signed-stop" }] },
			{ content: ["finished after two recoveries"] },
		]);
		current.settings.set("features.unexpectedStopDetection", "mechanical");
		const continued = vi.spyOn(current.agent, "continue");
		await current.prompt("finish the request");
		await current.waitForIdle();
		expect(current.getLastAssistantText()).toContain("finished after two recoveries");
		expect(continued).toHaveBeenCalledTimes(2);
	});

	it("keeps an early IRC message with the initial assignment instead of waking an unassigned worker", async () => {
		const current = createSession([{ content: ["assignment completed"] }], true);
		const prompt = vi.spyOn(current.agent, "prompt");
		await current.deliverIrcMessage({
			id: "early",
			from: "peer",
			to: "worker",
			body: "supporting context",
			ts: Date.now(),
		});
		expect(prompt).not.toHaveBeenCalled();
		expect(current.hasQueuedIrcFrom("peer")).toBe(true);
		await current.prompt("the initial assignment", { attribution: "agent" });
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(current.hasQueuedIrcFrom("peer")).toBe(false);
		expect(current.messages.some(message => message.role === "custom" && message.customType === "irc:incoming")).toBe(
			true,
		);
	});

	it.each(["irc", "custom"] as const)("parks a %s turn until manual compaction reconnects persistence", async kind => {
		const current = createSession();
		const gate = Promise.withResolvers<void>();
		let compacting = true;
		vi.spyOn(SessionMaintenance.prototype, "waitForContextReplacement").mockImplementation(() =>
			compacting ? gate.promise : undefined,
		);
		const prompt = vi.spyOn(current.agent, "prompt");
		const pending =
			kind === "irc"
				? current.deliverIrcMessage({
						id: "held",
						from: "peer",
						to: "worker",
						body: "after compaction",
						ts: Date.now(),
					})
				: current.sendCustomMessage(
						{ customType: "result", content: "after compaction", display: false },
						{ triggerTurn: true },
					);
		await Promise.resolve();
		expect(prompt).not.toHaveBeenCalled();
		compacting = false;
		gate.resolve();
		await pending;
		await current.waitForIdle();
		expect(prompt).toHaveBeenCalledTimes(1);
	});
});
