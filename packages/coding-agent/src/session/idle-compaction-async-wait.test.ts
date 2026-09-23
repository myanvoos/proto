/**
 * Idle compaction used to fire while the agent was waiting on its own background job, shrinking the history the
 * resumed turn (driven by the job's result) needed. A pending async wake now defers it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "../async/job-manager";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import type { ExtensionRunner } from "../extensibility/extensions";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

describe("idle compaction while a background job is pending", () => {
	let authStorage: AuthStorage | undefined;
	let manager: AsyncJobManager;
	let session: AgentSession;
	let compactions: number;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		manager = new AsyncJobManager({});
		compactions = 0;
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
		const sessionManager = SessionManager.inMemory();
		const bulk = "history the resumed turn needs. ".repeat(400);
		for (let turn = 0; turn < 3; turn++) {
			sessionManager.appendMessage({ role: "user", content: `question ${turn} ${bulk}`, timestamp: Date.now() });
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `answer ${turn} ${bulk}` }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				usage: {
					input: 1_000,
					output: 100,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
		}
		const extensionRunner = {
			hasHandlers: (event: string) => event === "session_before_compact",
			emit: async (event: { type: string }) => {
				if (event.type !== "session_before_compact") return undefined;
				compactions++;
				return { compaction: { summary: "summary", firstKeptEntryId: "", tokensBefore: 1_000 } };
			},
		} as unknown as ExtensionRunner;
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.selfSummary": false,
				"compaction.keepRecentTokens": 1,
				"compaction.autoContinue": false,
			}),
			modelRegistry: new ModelRegistry(authStorage),
			extensionRunner,
			asyncJobManager: manager,
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	});

	afterEach(async () => {
		await session.dispose();
		await manager.dispose();
		authStorage?.close();
		authStorage = undefined;
	});

	it("defers while the job runs and compacts once the session is truly idle", async () => {
		const release = Promise.withResolvers<void>();
		manager.register(
			"bash",
			"long build",
			async () => {
				await release.promise;
				return "built";
			},
			{ ownerId: session.getAsyncJobOwnerId() },
		);

		await session.runIdleCompaction();
		expect(compactions).toBe(0);

		manager.cancelAll();
		release.resolve();
		for (let i = 0; i < 100 && session.hasPendingAsyncWork(); i++) await Bun.sleep(1);
		expect(session.hasPendingAsyncWork()).toBe(false);

		await session.runIdleCompaction();
		expect(compactions).toBe(1);
	});
});
