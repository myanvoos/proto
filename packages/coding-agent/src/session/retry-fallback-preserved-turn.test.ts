/**
 * A transport error after an unexecuted tool call keeps (preserves) the failed turn in the retried request. Fallback
 * selection must judge that request: the preserved turn's signed Anthropic thinking pins it to its source model, and
 * its size counts against a candidate's context window.
 */
import { afterEach, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, type Model, type ToolCall } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
let tempDir: TempDir | undefined;
afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
	tempDir?.removeSync();
	tempDir = undefined;
});

function transportErrorAfterToolCall(model: Model, toolCall: ToolCall, thinkingSignature?: string) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
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
		if (thinkingSignature !== undefined) {
			const thinking = { type: "thinking" as const, thinking: "Signed reasoning.", thinkingSignature };
			partial.content.push(thinking);
			stream.push({ type: "start", partial });
			stream.push({ type: "thinking_start", contentIndex: 0, partial });
			stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinking.thinking, partial });
			stream.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial });
		} else {
			stream.push({ type: "start", partial });
		}
		const index = partial.content.length;
		partial.content.push(toolCall);
		stream.push({ type: "toolcall_start", contentIndex: index, partial });
		stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(toolCall.arguments), partial });
		stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial });
		stream.push({
			type: "error",
			reason: "error",
			error: { ...partial, stopReason: "error", errorMessage: "The socket connection was closed unexpectedly." },
		});
	});
	return stream;
}

async function runPreservedTurn(options: {
	primary: Model;
	fallbackChain: string[];
	toolCall: ToolCall;
	thinkingSignature?: string;
	modelRegistry: ModelRegistry;
}) {
	const requested: string[] = [];
	const agent = new Agent({
		getApiKey: model => `${model.provider}-test-key`,
		initialState: { model: options.primary, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (model, context, streamOptions) => {
			requested.push(`${model.provider}/${model.id}`);
			if (requested.length === 1)
				return transportErrorAfterToolCall(model, options.toolCall, options.thinkingSignature);
			const mock = createMockModel({ id: model.id, provider: model.provider });
			mock.push({ content: ["Recovered"] });
			return mock.stream(mock, context, streamOptions);
		},
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.baseDelayMs": 1,
		"retry.maxRetries": 1,
		"retry.fallbackChains": { default: options.fallbackChain },
	});
	settings.setModelRole("default", `${options.primary.provider}/${options.primary.id}`);
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: options.modelRegistry,
	});
	await session.prompt("Run the tool turn");
	await session.waitForIdle();
	return requested;
}

async function createAuth(): Promise<AuthStorage> {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
	authStorage.setRuntimeApiKey("openai", "openai-test-key");
	return authStorage;
}

it("keeps signed thinking in a preserved turn on its source Anthropic model", async () => {
	const primary = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
	const fallback = getBundledModel("anthropic", "claude-opus-4-1") as Model;
	const requested = await runPreservedTurn({
		primary,
		fallbackChain: [`${fallback.provider}/${fallback.id}`],
		toolCall: { type: "toolCall", id: "signed-call", name: "bash", arguments: { command: "ssh host" } },
		thinkingSignature: "sonnet-signature",
		modelRegistry: new ModelRegistry(await createAuth()),
	});

	expect(requested).toEqual([`anthropic/${primary.id}`, `anthropic/${primary.id}`]);
	expect(session?.model?.id).toBe(primary.id);
});

it("counts the preserved turn when fitting a fallback's context window", async () => {
	tempDir = TempDir.createSync("@preserved-turn-fallback-");
	const modelsConfigPath = path.join(tempDir.path(), "models.json");
	await Bun.write(
		modelsConfigPath,
		JSON.stringify({
			providers: {
				anthropic: { modelOverrides: { "claude-sonnet-4-5": { contextWindow: 1_000_000 } } },
				openai: {
					modelOverrides: { "gpt-4o-mini": { contextWindow: 4000 }, "gpt-4o": { contextWindow: 1_000_000 } },
				},
			},
		}),
	);
	const modelRegistry = new ModelRegistry(await createAuth(), modelsConfigPath);
	const primary = modelRegistry.find("anthropic", "claude-sonnet-4-5") as Model;
	const requested = await runPreservedTurn({
		primary,
		fallbackChain: ["openai/gpt-4o-mini", "openai/gpt-4o"],
		toolCall: {
			type: "toolCall",
			id: "large-call",
			name: "write",
			arguments: { path: "report.txt", content: "lorem ipsum ".repeat(5000) },
		},
		modelRegistry,
	});

	expect(requested).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]);
});
