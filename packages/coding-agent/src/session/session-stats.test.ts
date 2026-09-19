import { expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import type { ContextUsageBreakdown, SessionStats } from "./agent-session-types";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";
import { SessionStatsTracker, type SessionStatsTrackerHost } from "./session-stats";

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected test model");

function assistantMessage(timestamp: number, contextTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `assistant-${timestamp}` }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: contextTokens,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: contextTokens + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	};
}

async function createTracker(messages: Message[]): Promise<{
	authStorage: AuthStorage;
	agent: Agent;
	manager: SessionManager;
	tracker: SessionStatsTracker;
}> {
	const authStorage = await AuthStorage.create(":memory:");
	const manager = SessionManager.inMemory("/session-stats-test");
	for (const message of messages) manager.appendMessage(message);
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["test system"],
			tools: [],
			messages,
		},
	});
	const modelRegistry = new ModelRegistry(authStorage);
	const host: SessionStatsTrackerHost = {
		session: { systemPrompt: ["test system"] },
		agent,
		sessionManager: manager,
		modelRegistry,
		model: () => model,
		sessionId: () => manager.getSessionId(),
	};
	return { authStorage, agent, manager, tracker: new SessionStatsTracker(host) };
}

async function expectSameAsLegacyBranchScan(
	tracker: SessionStatsTracker,
	authStorage: AuthStorage,
	agent: Agent,
	manager: SessionManager,
): Promise<void> {
	const expected = new SessionStatsTracker({
		session: { systemPrompt: ["test system"] },
		agent,
		sessionManager: manager,
		modelRegistry: new ModelRegistry(authStorage),
		model: () => model,
		sessionId: () => manager.getSessionId(),
	});
	const optimizedBranchView = manager.getBranchForStats;
	manager.getBranchForStats = () => manager.getBranch();
	let expectedBreakdown: ContextUsageBreakdown | undefined;
	let expectedStats: SessionStats | undefined;
	try {
		expectedBreakdown = expected.getContextBreakdown({ contextWindow: model.contextWindow ?? undefined });
		expectedStats = expected.getSessionStats();
	} finally {
		manager.getBranchForStats = optimizedBranchView;
	}
	expect(tracker.getContextBreakdown({ contextWindow: model.contextWindow ?? undefined })).toEqual(expectedBreakdown);
	expect(tracker.getSessionStats()).toEqual(expectedStats);
}

test("cached context bookkeeping matches the legacy branch scan across transcript mutations", async () => {
	const userBefore: Message = { role: "user", content: "before", timestamp: 1 };
	const firstAssistant = assistantMessage(2, 120);
	const userAfter: Message = { role: "user", content: "after", timestamp: 3 };
	const { authStorage, agent, manager, tracker } = await createTracker([userBefore, firstAssistant, userAfter]);

	try {
		await expectSameAsLegacyBranchScan(tracker, authStorage, agent, manager);

		const secondAssistant = assistantMessage(4, 240);
		const secondAssistantId = manager.appendMessage(secondAssistant);
		agent.appendMessage(secondAssistant);
		await expectSameAsLegacyBranchScan(tracker, authStorage, agent, manager);

		manager.appendCompaction("summary", undefined, secondAssistantId, 500);
		await expectSameAsLegacyBranchScan(tracker, authStorage, agent, manager);

		const postCompactionAssistant = assistantMessage(5, 360);
		manager.appendMessage(postCompactionAssistant);
		agent.appendMessage(postCompactionAssistant);
		await expectSameAsLegacyBranchScan(tracker, authStorage, agent, manager);

		tracker.recordAnchoredHistoryRewrite(25);
		await expectSameAsLegacyBranchScan(tracker, authStorage, agent, manager);

		manager.branch(secondAssistantId);
		agent.replaceMessages([userBefore, firstAssistant, userAfter, secondAssistant]);
		await expectSameAsLegacyBranchScan(tracker, authStorage, agent, manager);

		manager.resetLeaf();
		agent.replaceMessages([]);
		await expectSameAsLegacyBranchScan(tracker, authStorage, agent, manager);
	} finally {
		await manager.close();
		authStorage.close();
	}
});
