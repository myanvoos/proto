import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	ProviderSessionState,
	ToolResultMessage,
} from "../types";
import { createOpenAIResponsesHistoryPayload } from "../utils";
import { streamAzureOpenAIResponses } from "./azure-openai-responses";
import { buildParams, streamOpenAIResponses } from "./openai-responses";
import {
	buildResponsesInput,
	hoistInterleavedResponsesToolBatchMessages,
	SYNTHETIC_REASONING_REPLAY_PLACEHOLDER,
} from "./openai-shared";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function responsesModel(
	spec: Pick<ModelSpec<"openai-responses">, "id" | "provider" | "baseUrl"> & Partial<ModelSpec<"openai-responses">>,
): Model<"openai-responses"> {
	return buildModel({
		name: spec.id,
		api: "openai-responses",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
		...spec,
	});
}

function assistant(model: Model<"openai-responses">, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage,
		stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 1,
	};
}

function toolResult(toolCallId: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError,
		timestamp: 2,
	};
}

type WireItem = { type?: string; role?: string; id?: string; content?: unknown; call_id?: string };

function reasoningItems(input: unknown): WireItem[] {
	return (input as WireItem[]).filter(item => item.type === "reasoning");
}

describe("Responses synthesized reasoning replay", () => {
	const deepseek = responsesModel({
		id: "deepseek-v4-flash",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/inference/go/v1",
	});

	it("sends a non-empty, id-less reasoning item when a DeepSeek turn lost its reasoning", () => {
		// DeepSeek 400s on a missing or empty reasoning_text; strict hosts reject a fabricated rs_ id.
		const context: Context = {
			messages: [
				{ role: "user", content: "Edit bar", timestamp: 0 },
				assistant(deepseek, [{ type: "text", text: "Edited bar.ts." }]),
				{ role: "user", content: "Run the tests", timestamp: 3 },
			],
		};
		const { params } = buildParams(deepseek, context, { reasoning: "high" }, undefined);
		const reasoning = reasoningItems(params.input);
		expect(reasoning).toHaveLength(1);
		expect(reasoning[0]).not.toHaveProperty("id");
		expect(reasoning[0].content).toEqual([{ type: "reasoning_text", text: SYNTHETIC_REASONING_REPLAY_PLACEHOLDER }]);
	});

	it("does not reconstruct filtered reasoning for hosts that reject synthetic reasoning", () => {
		const filtered = responsesModel({
			id: "meta/muse-spark-1.3",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			compat: { filterReasoningHistory: true, allowsSyntheticReasoningContentForToolCalls: false },
		});
		const context: Context = {
			messages: [
				{ role: "user", content: "Run echo 1", timestamp: 0 },
				assistant(filtered, [
					{ type: "thinking", thinking: "need to run echo 1" },
					{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo 1" } },
				]),
				toolResult("call_1", "1\n"),
				{ role: "user", content: "Now run echo 2", timestamp: 3 },
			],
		};
		const { params } = buildParams(filtered, context, { reasoning: "medium" }, undefined);
		expect(reasoningItems(params.input)).toEqual([]);
		expect(params.input).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call_1" }));
	});
});

describe("Responses orphan repair ordering", () => {
	it("keeps a repaired orphan-output note out of another call's call→output batch", () => {
		// Strict validators (DeepSeek via opencode-go) 400 with "No tool output found" when a message splits the batch.
		const model = responsesModel({
			id: "deepseek-v4-flash",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/inference/go/v1",
		});
		const prior: AssistantMessage = {
			...assistant(model, [
				{ type: "toolCall", id: "call_00", name: "todo", arguments: {} },
				{ type: "toolCall", id: "call_01", name: "bash", arguments: { command: "ls" } },
			]),
			providerPayload: createOpenAIResponsesHistoryPayload(
				model.provider,
				[
					{ type: "reasoning", id: "rs_1", summary: [], content: [] },
					{ type: "function_call", call_id: "call_01", name: "bash", arguments: "{}" },
				],
				false,
			),
		};
		const items = buildResponsesInput({
			model,
			context: {
				messages: [
					prior,
					toolResult("call_00", "Invalid todo arguments", true),
					toolResult("call_01", "file listing"),
					{ role: "user", content: "continue", timestamp: 5 },
				],
			},
			strictResponsesPairing: false,
			supportsImageDetailOriginal: false,
			repairOrphanOutputs: true,
			nativeHistory: { replay: true, filterReasoning: false },
		}) as WireItem[];

		const noteIndex = items.findIndex(
			item => item.role === "assistant" && typeof item.content === "string" && item.content.includes("call_00"),
		);
		const callIndex = items.findIndex(item => item.type === "function_call" && item.call_id === "call_01");
		const outputIndex = items.findIndex(item => item.type === "function_call_output" && item.call_id === "call_01");
		expect(items[noteIndex]?.content).toContain("[Orphan tool result; call_id=call_00]");
		expect(noteIndex).toBeLessThan(callIndex);
		expect(outputIndex).toBe(callIndex + 1);
	});
});

describe("Azure Responses malformed replay", () => {
	it("keeps a malformed function call diagnostic paired with its durable result", async () => {
		const model: Model<"azure-openai-responses"> = buildModel({
			id: "gpt-5-mini",
			name: "GPT-5 Mini",
			api: "azure-openai-responses",
			provider: "azure",
			baseUrl: "https://example.openai.azure.com/openai/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		});
		const previous: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "azure-openai-responses",
			provider: "azure",
			model: model.id,
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: 1,
			providerPayload: createOpenAIResponsesHistoryPayload("azure", [
				{ type: "function_call", id: "fc_bad", call_id: "call_bad", name: "bash", arguments: '{"command":"unterm' },
				{ type: "function_call_output", call_id: "call_bad", output: "durable result" },
			]),
		};
		const controller = new AbortController();
		controller.abort();
		const { promise, resolve } = Promise.withResolvers<{ input: WireItem[] }>();
		streamAzureOpenAIResponses(
			model,
			{ messages: [previous, { role: "user", content: "continue", timestamp: 2 }] },
			{
				apiKey: "test-key",
				azureBaseUrl: model.baseUrl,
				azureApiVersion: "v1",
				signal: controller.signal,
				onPayload: payload => resolve(payload as { input: WireItem[] }),
			},
		);
		const { input } = await promise;
		expect(input).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call_bad" }));
		expect(input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_bad" }));
		expect(JSON.stringify(input)).toContain("__parseError");
		expect(JSON.stringify(input)).toContain("durable result");
	});
});

describe("Responses interrupted tool batch hoisting", () => {
	it("hoists assistant notes across an interleaved output batch", () => {
		const items = [
			{ type: "function_call", call_id: "call-a", name: "a", arguments: "{}" },
			{ type: "message", role: "assistant", content: "first note" },
			{ type: "function_call_output", call_id: "call-a", output: "a" },
			{ type: "function_call", call_id: "call-b", name: "b", arguments: "{}" },
			{ type: "message", role: "assistant", content: "second note" },
			{ type: "function_call_output", call_id: "call-b", output: "b" },
		];
		const result = hoistInterleavedResponsesToolBatchMessages(items);
		expect(result.map(item => item.type ?? item.content)).toEqual([
			"message",
			"function_call",
			"function_call_output",
			"message",
			"function_call",
			"function_call_output",
		]);
		expect(result[0]?.content).toBe("first note");
		expect(result[3]?.content).toBe("second note");
	});
});

describe("Responses plaintext reasoning replay", () => {
	const model = responsesModel({ id: "plain-reasoning", provider: "custom", baseUrl: "https://reasoning.test/v1" });
	function replay(reasoning: Record<string, unknown>, warm: boolean, required = false): WireItem[] {
		const prior = assistant(model, [{ type: "text", text: "answer" }]);
		prior.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, [
			reasoning,
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer", annotations: [] }] },
		]);
		return buildResponsesInput({
			model,
			context: { messages: [prior, { role: "user", content: "continue", timestamp: 2 }] },
			strictResponsesPairing: false,
			supportsImageDetailOriginal: false,
			nativeHistory: { replay: warm, filterReasoning: false },
			requiresReasoningReplayForAllTurns: required,
		}) as WireItem[];
	}

	it("preserves unbound plaintext reasoning while a resumed provider session is cold", () => {
		const items = replay(
			{ type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "full reasoning" }] },
			false,
		);
		expect(reasoningItems(items)).toMatchObject([{ content: [{ type: "reasoning_text", text: "full reasoning" }] }]);
	});

	it("does not cold-replay summary-only or encrypted server-owned reasoning", () => {
		expect(
			reasoningItems(replay({ type: "reasoning", summary: [{ type: "summary_text", text: "summary" }] }, false)),
		).toEqual([]);
		expect(
			reasoningItems(
				replay(
					{
						type: "reasoning",
						summary: [],
						encrypted_content: "opaque",
						content: [{ type: "reasoning_text", text: "plain" }],
					},
					false,
				),
			),
		).toEqual([]);
	});

	it("fills required warm reasoning from summaries but leaves encrypted reasoning opaque", () => {
		const summary = [{ type: "summary_text", text: "recoverable reasoning" }];
		expect(reasoningItems(replay({ type: "reasoning", summary }, true, true))).toMatchObject([
			{ content: [{ type: "reasoning_text", text: "recoverable reasoning" }] },
		]);
		const encrypted = reasoningItems(replay({ type: "reasoning", summary, encrypted_content: "opaque" }, true, true));
		expect(encrypted[0]).not.toHaveProperty("content");
	});
});

describe("Responses native history warm start", () => {
	function completed(): Response {
		const events = [
			{ type: "response.created", response: { id: "resp_ok", status: "in_progress" } },
			{ type: "response.completed", response: { id: "resp_ok", status: "completed" } },
		];
		return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
			headers: { "content-type": "text/event-stream" },
		});
	}

	async function captureBodies(
		model: Model<"openai-responses">,
		context: Context,
		providerSessionState: Map<string, ProviderSessionState>,
	): Promise<Record<string, unknown>[]> {
		const bodies: Record<string, unknown>[] = [];
		const fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>);
				return completed();
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		await streamOpenAIResponses(model, context, { apiKey: "test-key", fetch, providerSessionState }).result();
		return bodies;
	}

	function resumedEncryptedReasoningContext(model: Model<"openai-responses">): Context {
		const prior = assistant(model, [{ type: "text", text: "generic assistant that should be rebuilt" }]);
		prior.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, [
			{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc_turn_1" },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "generic assistant that should be rebuilt" }],
			},
		]);
		return { messages: [prior, { role: "user", content: "follow-up user", timestamp: 2 }] };
	}

	it("replays encrypted reasoning on the first resumed request unless the host binds items to a connection", async () => {
		const replayed: Record<string, boolean> = {};
		for (const model of [
			responsesModel({ id: "grok-4.7", provider: "xai-oauth", baseUrl: "https://api.x.ai/v1" }),
			responsesModel({ id: "gpt-5-mini", provider: "openai", baseUrl: "https://api.openai.com/v1" }),
			responsesModel({ id: "gpt-5.4", provider: "github-copilot", baseUrl: "https://api.githubcopilot.com" }),
		]) {
			const bodies = await captureBodies(
				model,
				resumedEncryptedReasoningContext(model),
				new Map<string, ProviderSessionState>(),
			);
			replayed[model.provider] = JSON.stringify(bodies[0]?.input).includes("enc_turn_1");
		}

		expect(replayed).toEqual({ "xai-oauth": true, openai: true, "github-copilot": false });
	});

	it("rebuilds history after the provider session state closes on a host without connection binding", async () => {
		const model = responsesModel({ id: "grok-4.7", provider: "xai-oauth", baseUrl: "https://api.x.ai/v1" });
		const context = resumedEncryptedReasoningContext(model);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const warm = await captureBodies(model, context, providerSessionState);
		for (const state of providerSessionState.values()) state.close();
		const closed = await captureBodies(model, context, providerSessionState);

		expect(JSON.stringify(warm[0]?.input)).toContain("enc_turn_1");
		expect(JSON.stringify(closed[0]?.input)).not.toContain("enc_turn_1");
		expect(JSON.stringify(closed[0]?.input)).toContain("generic assistant that should be rebuilt");
	});
});

describe("Responses long prompt cache retention", () => {
	it("uses the 12h cache policy instead of the ignored legacy retention field on breakpoint-capable models", () => {
		const model = responsesModel({
			id: "gpt-5.6",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			compat: { supportsPromptCacheBreakpoints: true, supportsLongPromptCacheRetention: true },
		});
		const { params } = buildParams(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ sessionId: "cache", cacheRetention: "long" },
			undefined,
		);
		expect(params.prompt_cache_options).toMatchObject({ mode: "implicit", ttl: "12h" });
		expect(params.prompt_cache_retention).toBeUndefined();
	});
});

describe("Responses provider state disposal", () => {
	it("keeps a session cold when an earlier in-flight request completes after close", async () => {
		const model = responsesModel({ id: "closed-session", provider: "custom", baseUrl: "https://responses.test/v1" });
		const states = new Map<string, ProviderSessionState>();
		const started = Promise.withResolvers<void>();
		const response = Promise.withResolvers<Response>();
		const bodies: Record<string, unknown>[] = [];
		const frames = [
			{ type: "response.output_item.added", item: { type: "reasoning", id: "rs_1", summary: [] } },
			{
				type: "response.output_item.done",
				item: { type: "reasoning", id: "rs_1", encrypted_content: "connection-owned", summary: [] },
			},
			{ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
			{ type: "response.output_text.delta", delta: "answer" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					content: [{ type: "output_text", text: "answer", annotations: [] }],
				},
			},
			{ type: "response.completed", response: { id: "resp_1", status: "completed" } },
		];
		const sse = () =>
			new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			});
		const fetchImpl: FetchImpl = Object.assign(
			async (_url: string | URL | Request, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body)));
				if (bodies.length === 1) {
					started.resolve();
					return response.promise;
				}
				return sse();
			},
			{ preconnect: fetch.preconnect },
		);
		const options = { apiKey: "test-key", sessionId: "closed", providerSessionState: states, fetch: fetchImpl };
		const initial: Context = { messages: [{ role: "user", content: "first", timestamp: 1 }] };
		const first = streamOpenAIResponses(model, initial, options).result();
		await started.promise;
		for (const state of states.values()) state.close();
		response.resolve(sse());
		const completed = await first;
		await streamOpenAIResponses(
			model,
			{ messages: [...initial.messages, completed, { role: "user", content: "next", timestamp: 2 }] },
			options,
		).result();
		expect(JSON.stringify(bodies[1]?.input)).not.toContain("connection-owned");
		expect(JSON.stringify(bodies[1]?.input)).toContain("answer");
	});
});
