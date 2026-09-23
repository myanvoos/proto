import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

const model: Model<"openai-responses"> = buildModel({
	id: "body-timeout-model",
	name: "Body Timeout Model",
	api: "openai-responses",
	provider: "body-timeout-test",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"],
	contextWindow: 1_000_000,
	maxTokens: 4_096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const BIG_RESULT = "result line with enough distinct words to count\n".repeat(3_000);

function assistant(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
		...extra,
	};
}

function bodyTimeout(): AssistantMessage {
	return assistant([], {
		stopReason: "error",
		errorStatus: 408,
		errorMessage: "408 Timed out reading request body.",
		requestBodyReadTimeoutFullReplay: true,
	});
}

function toolResultText(context: Context): string | undefined {
	const result = context.messages.find((message): message is ToolResultMessage => message.role === "toolResult");
	const block = result?.content[0];
	return block?.type === "text" ? block.text : undefined;
}

describe("Responses request-body-read timeout recovery", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
	});

	async function createSession(responses: Array<() => AssistantMessage>): Promise<Context[]> {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "read the log", timestamp: 1 });
		sessionManager.appendMessage(
			assistant([{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "big.log" } }], {
				stopReason: "toolUse",
			}),
		);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: BIG_RESULT }],
			isError: false,
			timestamp: 2,
		});
		sessionManager.appendMessage(assistant([{ type: "text", text: "summary ".repeat(20_000) }]));
		const contexts: Context[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
			streamFn: (_model, context) => {
				contexts.push(structuredClone(context));
				const message = (responses[contexts.length - 1] ?? responses[responses.length - 1])();
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
					else stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": true, "retry.baseDelayMs": 1, "retry.maxDelayMs": 1 }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		return contexts;
	}

	it("elides large tool results into an artifact and retries once", async () => {
		const contexts = await createSession([bodyTimeout, () => assistant([{ type: "text", text: "recovered" }])]);

		await session!.prompt("continue");
		await session!.waitForIdle();

		expect(contexts).toHaveLength(2);
		expect(toolResultText(contexts[0]!)).toBe(BIG_RESULT);
		expect(toolResultText(contexts[1]!)).toStartWith("[shaken ~");
		expect(session!.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("stops after the one recovery instead of replaying an unchanged request", async () => {
		const contexts = await createSession([bodyTimeout]);

		await session!.prompt("continue");
		await session!.waitForIdle();

		expect(contexts).toHaveLength(2);
		expect(toolResultText(contexts[1]!)).toStartWith("[shaken ~");
	});
});
