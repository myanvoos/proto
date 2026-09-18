/**
 * Two concurrent prompts must serialize instead of racing dispatch.
 *
 * Both callers can observe an idle session before image normalization yields.
 * The first submission must keep the turn while the second remains a steer in
 * that turn rather than disappearing or surfacing an AgentBusyError.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createCompactionSummaryMessage } from "@oh-my-pi/pi-agent-core/compaction";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { computeNonMessageTokens } from "../modes/utils/context-usage";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

describe("AgentSession concurrent prompt dispatch", () => {
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
	});

	function createSession(): void {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: createMockModel({
				responses: [{ content: ["First done"] }, { content: ["Second done"] }],
			}).stream,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
	}

	it("keeps concurrent prompts in submission order when the second loses the pre-dispatch race", async () => {
		createSession();

		const first = session.prompt("initial CLI prompt", { streamingBehavior: "steer" });
		const second = session.prompt("typed during preflight", { streamingBehavior: "steer" });

		await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

		const users = session.messages.filter(message => message.role === "user");
		const textOf = (message: (typeof users)[number]): string =>
			typeof message.content === "string"
				? message.content
				: message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
		expect(users.map(textOf)).toEqual(["initial CLI prompt", "typed during preflight"]);
		expect(users.map(message => message.steering)).toEqual([undefined, true]);
	});

	it("sends a large resumed mixed transcript unchanged with the exact compaction token budget", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const messages: AgentMessage[] = [];
		const zeroUsage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		for (let index = 0; index < 15_271; index++) {
			switch (index % 6) {
				case 0:
					messages.push({
						role: "user",
						content: [
							{ type: "text", text: `user ${index}` },
							{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
						],
						timestamp: index,
					});
					break;
				case 1:
					messages.push({ role: "developer", content: `developer ${index}`, timestamp: index });
					break;
				case 2:
					messages.push({
						role: "assistant",
						content: [
							{ type: "thinking", thinking: `thinking ${index}`, thinkingSignature: `encrypted-${index}` },
							{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: `${index}.ts` } },
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: model.id,
						stopReason: "toolUse",
						usage: zeroUsage,
						timestamp: index,
					});
					break;
				case 3:
					messages.push({
						role: "toolResult",
						toolCallId: `call-${index - 1}`,
						toolName: "read",
						content: [{ type: "text", text: `result ${index}` }],
						isError: false,
						timestamp: index,
					});
					break;
				case 4:
					messages.push({
						role: "custom",
						customType: "test-context",
						content: `custom ${index}`,
						display: false,
						attribution: "agent",
						timestamp: index,
					});
					break;
				default:
					messages.push({ role: "user", content: `follow-up ${index}`, timestamp: index });
			}
		}
		messages.splice(
			7_636,
			0,
			createCompactionSummaryMessage("compacted earlier work", 42_000, "2026-01-01T00:00:00.000Z"),
		);

		const sessionManager = SessionManager.inMemory();
		for (const message of messages) {
			if (message.role === "compactionSummary") {
				sessionManager.appendCompaction(message.summary, message.shortSummary, "first-kept", message.tokensBefore);
			} else if (message.role !== "branchSummary") {
				sessionManager.appendMessage(message);
			}
		}
		const response = createMockModel({ responses: [{ content: ["done"] }] });
		let providerMessages: AgentMessage[] | undefined;
		let providerTokens: number | undefined;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages },
			streamFn: async (...args) => {
				providerMessages = structuredClone(args[1].messages);
				providerTokens = session.getContextBreakdown()?.usedTokens;
				return response.stream(...args);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const expectedBeforePrompt =
			computeNonMessageTokens(session, agent.tokenizer) + agent.tokenizer.countMessages(messages);

		await session.prompt("final user message");

		expect(session.messages.slice(0, messages.length)).toEqual(messages);
		expect(providerMessages?.at(-1)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "final user message" }],
		});
		const promptMessage = providerMessages?.at(-1);
		expect(providerTokens).toBe(
			expectedBeforePrompt + (promptMessage ? agent.tokenizer.countMessage(promptMessage) : Number.NaN),
		);
	}, 20_000);
});
