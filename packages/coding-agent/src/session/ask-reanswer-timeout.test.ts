import { expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

test("tree ask replay preserves explicit disabled timeout and never commits a no-response reanswer", async () => {
	const auth = await AuthStorage.create(":memory:");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing test model");
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Choose", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [
			{
				type: "toolCall",
				id: "ask-1",
				name: "ask",
				arguments: { questions: [{ id: "q", question: "Publish?", options: [{ label: "Yes" }] }], timeout: 0 },
			},
		],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	});
	const target = manager.appendMessage({
		role: "toolResult",
		toolCallId: "ask-1",
		toolName: "ask",
		content: [{ type: "text", text: "User selected: Yes" }],
		isError: false,
		timestamp: 3,
	});
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, messages: manager.buildSessionContext().messages } }),
		sessionManager: manager,
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(auth),
	});
	try {
		const reopened = await session.navigateTree(target, { allowAskReopen: true });
		expect(reopened.reopenAsk?.params.timeout).toBe(0);
		const entries = manager.getEntries();
		const result = await session.navigateTree(target, {
			allowAskReopen: true,
			reanswerAskResult: {
				content: [{ type: "text", text: "Ask timed out: no response received." }],
				details: { timedOut: true, selectedOptions: [] },
			},
		});
		expect(result.cancelled).toBe(true);
		expect(manager.getLeafId()).toBe(target);
		expect(manager.getEntries()).toEqual(entries);
	} finally {
		await session.dispose();
		auth.close();
	}
});
