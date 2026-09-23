/**
 * Advisor context maintenance replaces its history with a `compactionSummary` message. The advisor's requests must
 * replay that summary; the core Agent's default converter drops custom roles, which silently erased everything the
 * advisor had compacted.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createCompactionSummaryMessage } from "@oh-my-pi/pi-agent-core/compaction";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

let active: { session: AgentSession; auth: AuthStorage } | undefined;

afterEach(async () => {
	await active?.session.dispose().catch(() => {});
	active?.auth.close();
	active = undefined;
});

describe("advisor compaction replay", () => {
	it("sends the advisor's compaction summary with its next request", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const primary = createMockModel({ responses: [{ content: ["primary answer"], stopReason: "stop" }] });
		const advisorMock = createMockModel({ responses: [{ content: [], stopReason: "stop" }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: primary.stream,
		});
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": false,
			"retry.enabled": false,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const auth = await AuthStorage.create(":memory:");
		auth.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(auth),
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		active = { session, auth };
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent");
		advisor.replaceMessages([
			createCompactionSummaryMessage("ADVISOR_COMPACTED_HISTORY_MARKER", 12_000, new Date().toISOString()),
		]);

		await session.prompt("do the work");
		expect(await session.waitForAdvisorCatchup(1000)).toBe(true);

		expect(advisorMock.calls).toHaveLength(1);
		expect(JSON.stringify(advisorMock.calls[0]!.context.messages)).toContain("ADVISOR_COMPACTED_HISTORY_MARKER");
	});
});
