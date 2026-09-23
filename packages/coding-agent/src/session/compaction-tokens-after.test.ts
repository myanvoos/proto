/**
 * `tokensAfter` on a compaction entry feeds the transcript divider's before → after figure. It used to count only
 * ordinary `message` entries after the kept boundary, so kept custom-message context vanished from the figure, and an
 * OpenAI remote compaction reported the summary text instead of the native history the provider actually replays.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import type { ExtensionRunner } from "../extensibility/extensions";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

const BULK = "context the next turn still needs. ".repeat(400);

interface Scenario {
	keptCustomMessage?: boolean;
	remoteHistory?: boolean;
}

describe("compaction tokensAfter projection", () => {
	let authStorage: AuthStorage | undefined;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage?.close();
		authStorage = undefined;
	});

	async function compactedTokensAfter(scenario: Scenario): Promise<number> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "old question", timestamp: Date.now() });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `old answer ${BULK}` }],
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
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: "kept question",
			timestamp: Date.now(),
		});
		if (scenario.keptCustomMessage) {
			sessionManager.appendCustomMessageEntry("kept-context", BULK, false, undefined, "agent");
		}
		const preserveData = scenario.remoteHistory
			? {
					openaiRemoteCompaction: {
						provider: "openai",
						replacementHistory: [
							{ type: "message", role: "user", content: [{ type: "input_text", text: BULK }] },
						],
					},
				}
			: undefined;
		const extensionRunner = {
			hasHandlers: (event: string) => event === "session_before_compact",
			emit: async (event: { type: string }) =>
				event.type === "session_before_compact"
					? {
							compaction: {
								summary: "short summary",
								firstKeptEntryId,
								tokensBefore: 5_000,
								preserveData,
							},
						}
					: undefined,
		} as unknown as ExtensionRunner;
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.selfSummary": false,
				"compaction.keepRecentTokens": 1,
			}),
			modelRegistry: new ModelRegistry(authStorage!),
			extensionRunner,
		});
		sessions.push(session);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		await session.compact();
		const entry = sessionManager.getBranch().find(candidate => candidate.type === "compaction");
		if (entry?.type !== "compaction" || entry.tokensAfter === undefined) throw new Error("Expected tokensAfter");
		return entry.tokensAfter;
	}

	it("counts a kept custom message the next turn will send", async () => {
		const without = await compactedTokensAfter({});
		const withCustom = await compactedTokensAfter({ keptCustomMessage: true });

		expect(withCustom - without).toBeGreaterThan(1_000);
	});

	it("counts the native replacement history an OpenAI remote compaction replays", async () => {
		const summaryOnly = await compactedTokensAfter({});
		const remote = await compactedTokensAfter({ remoteHistory: true });

		expect(remote - summaryOnly).toBeGreaterThan(1_000);
	});
});
