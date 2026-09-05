import { afterEach, describe, expect, test, vi } from "bun:test";
import { Settings } from "../../../config/settings";
import type { AgentSession } from "../../../session/agent-session";
import { initThemeSync } from "../../theme/theme";
import { StatusLineComponent } from "./component";

await Settings.init({ inMemory: true });
initThemeSync();

afterEach(() => {
	vi.restoreAllMocks();
});

const usageStatistics = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	orchestrationInput: 0,
	orchestrationOutput: 0,
	orchestrationCacheRead: 0,
	premiumRequests: 0,
	cost: 0,
};

function sessionWithMessages(options: { messages: AgentSession["messages"]; isStreaming?: boolean }): AgentSession {
	const model = { id: "test-model", name: "Test Model", contextWindow: 100_000 };
	const state = { model, thinkingLevel: "off" } as Record<string, unknown>;
	Object.defineProperty(state, "messages", {
		configurable: true,
		get: () => options.messages,
	});
	return {
		messages: options.messages,
		state,
		model,
		isStreaming: options.isStreaming ?? false,
		sessionManager: { getUsageStatistics: () => usageStatistics },
		getAsyncJobSnapshot: () => ({ running: [] }),
		isAdvisorActive: () => false,
		isFastModeActive: () => false,
		settings: undefined,
	} as unknown as AgentSession;
}

describe("StatusLineComponent token rate", () => {
	test("does not read message history while token rate is hidden, and updates on settings changes", () => {
		const messages = [
			{
				role: "assistant",
				timestamp: 1_000,
				usage: { output: 100 },
				duration: 1_000,
			},
		] as AgentSession["messages"];
		let readMessages = false;
		const session = sessionWithMessages({ messages });
		Object.defineProperty(session.state, "messages", {
			configurable: true,
			get: () => {
				readMessages = true;
				throw new Error("message history should not be read");
			},
		});
		const component = new StatusLineComponent(session);
		try {
			component.updateSettings({ leftSegments: ["model"], rightSegments: [] });
			expect(component.renderQuietLine(120)).toContain("Test Model");
			expect(readMessages).toBe(false);

			Object.defineProperty(session.state, "messages", {
				configurable: true,
				get: () => messages,
			});
			component.updateSettings({ leftSegments: ["token_rate"], rightSegments: [] });
			expect(component.renderQuietLine(120)).toContain("100.0 tok/s");

			readMessages = false;
			Object.defineProperty(session.state, "messages", {
				configurable: true,
				get: () => {
					readMessages = true;
					throw new Error("message history should not be read");
				},
			});
			component.updateSettings({ leftSegments: ["model"], rightSegments: [] });
			expect(component.renderQuietLine(120)).toContain("Test Model");
			expect(readMessages).toBe(false);
		} finally {
			component.dispose();
		}
	});

	test("keeps the streaming rate current when enabled", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
		const assistant = {
			role: "assistant",
			timestamp: 9_000,
			usage: { output: 100 },
		};
		const messages = [assistant] as AgentSession["messages"];
		const session = sessionWithMessages({ messages, isStreaming: true });
		const component = new StatusLineComponent(session);
		try {
			component.updateSettings({ leftSegments: [], rightSegments: ["token_rate"] });
			expect(component.renderQuietLine(120)).toContain("100.0 tok/s");

			now.mockReturnValue(11_000);
			expect(component.renderQuietLine(120)).toContain("50.0 tok/s");
		} finally {
			component.dispose();
		}
	});
});
