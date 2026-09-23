import { afterEach, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

const model: Model<"anthropic-messages"> = buildModel({
	id: "partial-text-model",
	name: "Partial Text Model",
	api: "anthropic-messages",
	provider: "partial-text-test",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 4_096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const ENVELOPE_ERROR = "Anthropic stream envelope error: stream ended before message_stop";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
});

// A subagent's streamed prose reaches no output sink until the run settles, so a transient provider error after it
// must still retry; a main session already rendered the text and keeps the replay veto.
it.each([
	["sub", 2],
	["main", 1],
] as const)("a %s session makes %d stream call(s) after partial text dies mid-stream", async (agentKind, calls) => {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey(model.provider, "test-key");
	let streamCalls = 0;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: () => {
			streamCalls += 1;
			const stream = createAssistantMessageEventStream();
			const text = streamCalls === 1 ? "I'll investigate the codebase" : "recovered after retry";
			const partial: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
				if (streamCalls === 1) {
					stream.push({
						type: "error",
						reason: "error",
						error: { ...partial, stopReason: "error", errorMessage: ENVELOPE_ERROR },
					});
					return;
				}
				stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
				stream.push({ type: "done", reason: "stop", message: partial });
			});
			return stream;
		},
	});
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		}),
		modelRegistry: new ModelRegistry(authStorage),
		agentKind,
	});

	await session.prompt("go");
	await session.waitForIdle();

	expect(streamCalls).toBe(calls);
	const last = session.messages.at(-1) as AssistantMessage;
	if (agentKind === "sub") {
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after retry" });
	} else {
		expect(last.stopReason).toBe("error");
	}
});
