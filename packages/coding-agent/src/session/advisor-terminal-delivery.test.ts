/**
 * Advisor advice raised while the primary's terminal turn unwinds must land as a
 * visible advisor card. The unwinding loop never consumes a steer, so steering it
 * either strands the note until the next run or wakes a hidden extra primary turn.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { resolveAdvisorDeliveryChannel } from "../advisor/advise-tool";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { isAdvisorCard } from "./queued-messages";
import { SessionManager } from "./session-manager";

type BoundaryTool = AgentTool<any, any, any>;

function textResponse(text: string): MockResponse {
	return { content: [text], stopReason: "stop" };
}

function toolResponse(id: string, name: string, args: Record<string, unknown> = {}): MockResponse {
	return { content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse" };
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
			return "";
		})
		.join("\n");
}

function makeTool(name: string, execute: BoundaryTool["execute"]): BoundaryTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: type({}),
		execute,
	};
}

const yieldParameters = type({ data: "unknown" });

function createYieldTool(): AgentTool<typeof yieldParameters> {
	return {
		name: "yield",
		label: "Yield",
		description: "Mock yield tool",
		parameters: yieldParameters,
		execute: async (_toolCallId, params) => ({
			content: [{ type: "text", text: "Result submitted." }],
			details: { status: "success", data: params.data },
		}),
	};
}

let active: { session: AgentSession; auth: AuthStorage; temp?: TempDir } | undefined;

afterEach(async () => {
	await active?.session.dispose().catch(() => {});
	active?.auth.close();
	await active?.temp?.remove().catch(() => {});
	active = undefined;
});

describe("advisor delivery at the primary's terminal boundary", () => {
	it("preserves a late nit after a terminal answer instead of queueing an aside", () => {
		expect(
			resolveAdvisorDeliveryChannel({
				severity: "nit",
				autoResumeSuppressed: false,
				streaming: false,
				aborting: false,
				terminalAnswerNoQueuedWork: true,
			}),
		).toBe("preserve");
	});

	it("preserves a final-yield blocker without starting a hidden post-yield turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const mock = createMockModel({
			responses: [toolResponse("call_yield", "yield", { data: "FINAL RESULT" }), textResponse("must not run")],
		});
		const advisorMock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "advise",
							arguments: { note: "Final yield needs correction", severity: "blocker" },
						},
					],
				},
				{ content: [], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [createYieldTool()] },
			streamFn: mock.stream,
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

		await session.prompt("yield the final result");
		expect(await session.waitForAdvisorCatchup(1000)).toBe(true);

		expect(advisorMock.calls).toHaveLength(2);
		expect(mock.calls).toHaveLength(1);
		const advisorCards = session.agent.state.messages.filter(isAdvisorCard);
		expect(advisorCards).toHaveLength(1);
		expect(contentText(advisorCards[0].content)).toContain("Final yield needs correction");
	});

	it.each(["concern", "nit", "blocker"] as const)(
		"routes late terminal %s correctly before a real next run",
		async severity => {
			const temp = TempDir.createSync("@pi-advisor-terminal-unwind-");
			const auth = await AuthStorage.create(":memory:");
			auth.setRuntimeApiKey("anthropic", "test-key");
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled model");
			const nextUserMarker = "NEXT_USER_CONTEXT_MARKER";
			const terminalTurnEnd = Promise.withResolvers<void>();
			const advisorStarted = Promise.withResolvers<void>();
			const releaseAdvisor = Promise.withResolvers<void>();
			const adviceAccepted = Promise.withResolvers<{ feedback: string; streaming: boolean }>();
			const nextProviderStarted = Promise.withResolvers<void>();
			const releaseNextProvider = Promise.withResolvers<void>();
			const nextPrimaryCall = severity === "blocker" ? 4 : 3;
			let primaryCalls = 0;
			const primaryContexts: string[] = [];
			let advisorCalls = 0;
			let terminalReleaseStarted = false;

			const primaryMock = createMockModel({
				id: "terminal-unwind-primary",
				provider: "anthropic",
				handler: async () => {
					if (primaryCalls === 1) return toolResponse("step-1", "step");
					if (primaryCalls === 2) return textResponse("terminal answer");
					if (primaryCalls === nextPrimaryCall) {
						nextProviderStarted.resolve();
						await releaseNextProvider.promise;
						return textResponse("next answer");
					}
					return textResponse("continuation answer");
				},
			});
			const advisorMock = createMockModel({
				id: "terminal-unwind-advisor",
				provider: "anthropic",
				handler: async () => {
					if (++advisorCalls === 1) {
						advisorStarted.resolve();
						await releaseAdvisor.promise;
						return toolResponse("advice-1", "advise", {
							note: "late terminal advice",
							severity,
						});
					}
					return textResponse("advisor quiet");
				},
			});
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model,
					systemPrompt: ["terminal unwind regression"],
					tools: [makeTool("step", async () => ({ content: [{ type: "text", text: "step complete" }] }))],
				},
				streamFn: (messages, context, options) => {
					primaryCalls++;
					primaryContexts.push(JSON.stringify(context.messages));
					return primaryMock.stream(messages, context, options);
				},
			});
			const originalSetOnTurnEnd = agent.setOnTurnEnd.bind(agent);
			agent.setOnTurnEnd = callback => {
				if (!callback) {
					originalSetOnTurnEnd(undefined);
					return;
				}
				originalSetOnTurnEnd(async (messages, signal, context) => {
					await callback(messages, signal, context);
					if (context?.willContinue === false && !terminalReleaseStarted) {
						terminalReleaseStarted = true;
						terminalTurnEnd.resolve();
						releaseAdvisor.resolve();
						await adviceAccepted.promise;
					}
				});
			};

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"advisor.syncBacklog": "off",
			});
			settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
				advisorTools: [],
				advisorStreamFn: advisorMock.stream,
			});
			active = { session, auth, temp };
			if (!session.setAdvisorEnabled(true)) throw new Error("Expected advisor runtime");
			let agentStarts = 0;
			const secondAgentStart = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type !== "agent_start") return;
				agentStarts++;
				if (agentStarts === 2) secondAgentStart.resolve();
			});
			const advisor = session.getAdvisorAgent();
			if (!advisor) throw new Error("Expected advisor agent");
			const advise = advisor.state.tools.find(tool => tool.name === "advise");
			if (!advise) throw new Error("Expected advise tool");
			const originalExecute = advise.execute.bind(advise);
			advise.execute = async (...args) => {
				const result = await originalExecute(...args);
				const feedback = contentText(result.content);
				if (/Recorded\.|Deferred|Accepted|queued|preserved|urgent/i.test(feedback)) {
					adviceAccepted.resolve({ feedback, streaming: agent.state.isStreaming });
				}
				return result;
			};

			const run = session.prompt("run a step then finish");
			await advisorStarted.promise;
			await terminalTurnEnd.promise;
			const accepted = await adviceAccepted.promise;
			await run;
			await session.waitForIdle();

			expect(accepted.streaming).toBe(true);
			const terminalCalls = severity === "blocker" ? 3 : 2;
			expect(primaryCalls).toBe(terminalCalls);
			const cards = session.agent.state.messages.filter(
				(message: AgentMessage) =>
					message.role === "custom" && "customType" in message && message.customType === "advisor",
			);
			expect(cards).toHaveLength(1);
			if (severity !== "blocker") {
				const card = cards[0];
				expect(card?.role).toBe("custom");
				if (card?.role === "custom") expect(contentText(card.content)).toContain("late terminal advice");
			}

			const nextRun = session.prompt(nextUserMarker);
			await secondAgentStart.promise;
			await nextProviderStarted.promise;
			expect(session.agent.state.isStreaming).toBe(true);
			const liveResult = await advise.execute("live-next", {
				note: "live next-turn concern",
				severity: "concern",
			});
			expect(contentText(liveResult.content)).toMatch(/Recorded\.|Deferred/);
			releaseNextProvider.resolve();
			await nextRun;
			await session.waitForIdle();
			expect(agentStarts).toBe(2);
			// The live concern intentionally steers one continuation after the held
			// next-user provider request; this is separate from the terminal-run guard.
			expect(primaryCalls).toBe(terminalCalls + 2);
			expect(primaryContexts[terminalCalls]).toContain(nextUserMarker);
		},
	);
});
