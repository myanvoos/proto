import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "../async/job-manager";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";
import { TurnRecovery } from "./turn-recovery";

describe("session recovery ownership", () => {
	let session: AgentSession | undefined;
	let auth: AuthStorage;
	let manager: AsyncJobManager | undefined;

	beforeEach(async () => {
		auth = await AuthStorage.create(":memory:");
		auth.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		await manager?.dispose();
		auth.close();
		session = undefined;
		manager = undefined;
	});

	function createSession(responses: MockResponse[] = [{ content: ["done"] }]): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: createMockModel({ responses }).stream,
			}),
			sessionManager: SessionManager.inMemory(),
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
});
