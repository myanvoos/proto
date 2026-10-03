/**
 * A review turn whose only tool calls are `advise` is finished: the advisor must not be re-invoked over the whole
 * prefix just to say "done". A turn that advises and keeps investigating continues normally, and stopping must not
 * turn a sibling advise call into a skipped placeholder.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

const ADVISE_CALL = {
	type: "toolCall",
	name: "advise",
	arguments: { note: "Check the null path before the retry.", severity: "concern" },
} as const;

describe("advisor advise-only turn ends the review", () => {
	let session: AgentSession | undefined;
	let auth: AuthStorage | undefined;

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			auth?.close();
			auth = undefined;
		}
	});

	async function createAdvisor(advisorResponses: MockResponse[]) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const primaryMock = createMockModel({ responses: [{ content: ["primary complete"], stopReason: "stop" }] });
		const advisorMock = createMockModel({ responses: advisorResponses });
		let readCalls = 0;
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Mock read tool",
			parameters: type({ "path?": "string" }),
			execute: async () => {
				readCalls++;
				return { content: [{ type: "text", text: "file contents" }], details: {} };
			},
		};
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": false,
			"retry.enabled": false,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		auth = await AuthStorage.create(":memory:");
		auth.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: primaryMock.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(auth),
			advisorTools: [readTool],
			advisorStreamFn: advisorMock.stream,
		});
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent");
		return { live: session, advisor, advisorMock, readCalls: () => readCalls };
	}

	function adviseResults(advisor: Agent) {
		return advisor.state.messages.filter(message => message.role === "toolResult" && message.toolName === "advise");
	}

	it("keeps investigating when advise shares the turn with another tool call", async () => {
		const { live, advisor, advisorMock, readCalls } = await createAdvisor([
			{ content: [ADVISE_CALL, { type: "toolCall", name: "read", arguments: { path: "src/a.ts" } }] },
			{ content: ["Confirmed after reading."], stopReason: "stop" },
		]);

		await live.prompt("review the current update");
		expect(await live.waitForAdvisorCatchup(2_000)).toBe(true);

		expect(readCalls()).toBe(1);
		expect(advisorMock.calls).toHaveLength(2);
		expect(advisor.state.error).toBeUndefined();
	});

	it("delivers every note when one turn emits several advise calls before stopping", async () => {
		const { live, advisor, advisorMock } = await createAdvisor([
			{
				content: [
					ADVISE_CALL,
					{
						type: "toolCall",
						name: "advise",
						arguments: { note: "The retry budget is never decremented.", severity: "concern" },
					},
				],
			},
			{ content: ["unexpected wrap-up"], stopReason: "stop" },
		]);

		await live.prompt("review the current update");
		expect(await live.waitForAdvisorCatchup(2_000)).toBe(true);

		expect(advisorMock.calls).toHaveLength(1);
		expect(advisor.state.error).toBeUndefined();
		const results = adviseResults(advisor);
		expect(results).toHaveLength(2);
		expect(results.every(result => result.role === "toolResult" && !result.isError)).toBe(true);
	});
});
