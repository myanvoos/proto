import { expect, test } from "bun:test";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type FetchImpl,
	type Message,
	type Model,
	streamAnthropic,
	streamOpenAICompletions,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { agentLoop } from "./agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	StreamFn,
} from "./types";

const model = getBundledModel("google", "gemini-2.5-flash-lite-preview-06-17");

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(targetModel: Model, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: targetModel.api,
		provider: targetModel.provider,
		model: targetModel.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	return { promise, resolve, reject };
}

interface ToolCallSpec {
	id: string;
	name: string;
}

function toolMessage(targetModel: Model, calls: readonly ToolCallSpec[]): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map(call => ({
			type: "toolCall" as const,
			id: call.id,
			name: call.name,
			arguments: {},
		})),
		api: targetModel.api,
		provider: targetModel.provider,
		model: targetModel.id,
		usage: zeroUsage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function okToolResult(text = "ok"): AgentToolResult {
	return { content: [{ type: "text", text }], details: {} };
}

function basicTool(
	name: string,
	execute: AgentTool["execute"],
	concurrency: AgentTool["concurrency"] = "shared",
): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: {} as AgentTool["parameters"],
		concurrency,
		execute,
	};
}

function loopConfig(_context: AgentContext, overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
	return {
		model,
		convertToLlm: messages =>
			messages.filter(
				(message): message is Message =>
					"role" in message &&
					(message.role === "user" || message.role === "assistant" || message.role === "toolResult"),
			),
		...overrides,
	};
}

function responseFor(finalMessage: (targetModel: Model) => AssistantMessage): StreamFn {
	return targetModel => {
		const stream = createAssistantMessageEventStream();
		stream.end(finalMessage(targetModel));
		return stream;
	};
}

interface SingleResponseResult {
	events: AgentEvent[];
	turnMessages: AgentMessage[];
}

async function runSingleResponse(
	streamFn: StreamFn,
	overrides: Partial<AgentLoopConfig> = {},
): Promise<SingleResponseResult> {
	const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
	let turnMessages: AgentMessage[] | undefined;
	const config: AgentLoopConfig = {
		model,
		convertToLlm: messages =>
			messages.filter(
				(message): message is Message =>
					"role" in message &&
					(message.role === "user" || message.role === "assistant" || message.role === "toolResult"),
			),
		onTurnEnd: messages => {
			turnMessages = [...messages];
		},
		...overrides,
	};
	const stream = agentLoop([userMessage("hello")], context, config, undefined, streamFn);
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	await stream.result();
	if (!turnMessages) throw new Error("Agent loop did not finish a turn");
	return { events, turnMessages };
}

function assistantBoundaryEvents(events: AgentEvent[]): AgentEvent[] {
	return events.filter(
		event => (event.type === "message_start" || event.type === "message_end") && event.message.role === "assistant",
	);
}

function assistantText(message: AgentMessage): string | undefined {
	if (message.role !== "assistant") return undefined;
	return message.content.find(block => block.type === "text")?.text;
}

test("eventless final response is transformed, added to turn context, and emits one boundary pair", async () => {
	const streamFn: StreamFn = targetModel => {
		const stream = createAssistantMessageEventStream();
		stream.end(assistantMessage(targetModel, "eventless"));
		return stream;
	};
	let transformCalls = 0;

	const { events, turnMessages } = await runSingleResponse(streamFn, {
		transformAssistantMessage: message => {
			transformCalls++;
			const text = message.content.find(block => block.type === "text");
			if (text?.type === "text") text.text = `${text.text} transformed`;
		},
	});

	expect(transformCalls).toBe(1);
	expect(turnMessages.map(message => message.role)).toEqual(["user", "assistant"]);
	expect(assistantText(turnMessages[1])).toBe("eventless transformed");
	expect(assistantBoundaryEvents(events).map(event => event.type)).toEqual(["message_start", "message_end"]);
});

test("event-emitting response keeps one context entry and one boundary pair", async () => {
	const streamFn: StreamFn = targetModel => {
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: assistantMessage(targetModel, "") });
		const final = assistantMessage(targetModel, "streamed");
		stream.push({ type: "done", reason: "stop", message: final });
		return stream;
	};

	const { events, turnMessages } = await runSingleResponse(streamFn);

	expect(turnMessages.map(message => message.role)).toEqual(["user", "assistant"]);
	expect(turnMessages.filter(message => message.role === "assistant")).toHaveLength(1);
	expect(assistantText(turnMessages[1])).toBe("streamed");
	expect(assistantBoundaryEvents(events).map(event => event.type)).toEqual(["message_start", "message_end"]);
});

test("steering watcher rejection is surfaced once and stops polling", async () => {
	const started = deferred<void>();
	const watcherStarted = deferred<void>();
	const release = deferred<AgentToolResult>();
	const watcherError = new Error("steering watcher failed");
	let checks = 0;
	const tool = basicTool("slow", async () => {
		started.resolve();
		return release.promise;
	});
	const context: AgentContext = { systemPrompt: [], messages: [], tools: [tool] };
	const finalMessage = toolMessage(model, [{ id: "call-1", name: tool.name }]);
	const config = loopConfig(context, {
		hasSteeringMessages: async () => {
			checks++;
			watcherStarted.resolve();
			throw watcherError;
		},
		waitForSteeringMessages: () => new Promise<void>(() => {}),
	});
	let responseCount = 0;
	const stream = agentLoop([userMessage("hello")], context, config, undefined, targetModel => {
		const response = createAssistantMessageEventStream();
		response.end(responseCount++ === 0 ? finalMessage : assistantMessage(targetModel, "done"));
		return response;
	});
	const outcome = stream.result().then(
		() => ({ status: "fulfilled" as const }),
		error => ({ status: "rejected" as const, error }),
	);
	await started.promise;
	await watcherStarted.promise;
	release.resolve(okToolResult());
	const result = await outcome;
	expect(result.status).toBe("rejected");
	if (result.status === "rejected") expect(result.error).toBe(watcherError);
	expect(checks).toBe(2);
});

test("shared tools respect the configured concurrency cap", async () => {
	const started = deferred<void>();
	const release = deferred<void>();
	let active = 0;
	let maxActive = 0;
	let startedCount = 0;
	const tool = basicTool("shared", async () => {
		active++;
		maxActive = Math.max(maxActive, active);
		startedCount++;
		if (startedCount === 2) started.resolve();
		await release.promise;
		active--;
		return okToolResult();
	});
	const context: AgentContext = { systemPrompt: [], messages: [], tools: [tool] };
	const calls = Array.from({ length: 6 }, (_, index) => ({ id: `call-${index}`, name: tool.name }));
	let responseCount = 0;
	const stream = agentLoop(
		[userMessage("hello")],
		context,
		loopConfig(context, { sharedToolConcurrency: 2 }),
		undefined,
		targetModel => {
			const response = createAssistantMessageEventStream();
			response.end(responseCount++ === 0 ? toolMessage(targetModel, calls) : assistantMessage(targetModel, "done"));
			return response;
		},
	);
	const result = stream.result();
	await started.promise;
	await Promise.resolve();
	expect(active).toBe(2);
	release.resolve();
	await result;
	expect(maxActive).toBe(2);
});

test("shared tool results follow provider call order while completion events stay live", async () => {
	const firstStarted = deferred<void>();
	const secondStarted = deferred<void>();
	const firstRelease = deferred<void>();
	const secondRelease = deferred<void>();
	const secondDone = deferred<void>();
	const completionEvents: string[] = [];
	const turns: string[][] = [];
	const tool = basicTool("ordered", async toolCallId => {
		if (toolCallId === "call-1") {
			firstStarted.resolve();
			await firstRelease.promise;
		} else {
			secondStarted.resolve();
			await secondRelease.promise;
			secondDone.resolve();
		}
		return okToolResult(toolCallId);
	});
	const context: AgentContext = { systemPrompt: [], messages: [], tools: [tool] };
	const calls = [
		{ id: "call-1", name: tool.name },
		{ id: "call-2", name: tool.name },
	];
	let responseCount = 0;
	const config = loopConfig(context, {
		onTurnEnd: (_messages, _signal, turn) => {
			if (turn) turns.push(turn.toolResults.map(result => result.toolCallId));
		},
	});
	const stream = agentLoop([userMessage("hello")], context, config, undefined, targetModel => {
		const response = createAssistantMessageEventStream();
		if (responseCount++ === 0) response.end(toolMessage(targetModel, calls));
		else response.end(assistantMessage(targetModel, "done"));
		return response;
	});
	const events: AgentEvent[] = [];
	const consume = (async () => {
		for await (const event of stream) events.push(event);
	})();
	const result = stream.result();
	await Promise.all([firstStarted.promise, secondStarted.promise]);
	secondRelease.resolve();
	await secondDone.promise;
	firstRelease.resolve();
	await result;
	await consume;
	for (const event of events) {
		if (event.type === "tool_execution_end") completionEvents.push(event.toolCallId);
	}
	expect(completionEvents.slice(0, 2)).toEqual(["call-2", "call-1"]);
	expect(turns[0]).toEqual(["call-1", "call-2"]);
});

test("external cancellation replaces a rejected in-flight tool with the run abort result", async () => {
	const started = deferred<void>();
	const rejection = deferred<never>();
	const controller = new AbortController();
	const tool = basicTool("abortable", async () => {
		started.resolve();
		return rejection.promise;
	});
	const context: AgentContext = { systemPrompt: [], messages: [], tools: [tool] };
	const stream = agentLoop(
		[userMessage("hello")],
		context,
		loopConfig(context),
		controller.signal,
		responseFor(() => toolMessage(model, [{ id: "call-1", name: tool.name }])),
	);
	const result = stream.result();
	await started.promise;
	controller.abort("timeout");
	rejection.reject(new Error("tool exploded"));
	const messages = await result;
	const toolResult = messages.find(message => message.role === "toolResult");
	expect(toolResult?.content[0]).toMatchObject({
		type: "text",
		text: "Tool was not executed because the run was aborted: timeout.",
	});
});

function openAIStreamResponse(body: string | ReadableStream<Uint8Array>): Response {
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function openAIErroringFetch(firstBody: string): FetchImpl {
	let calls = 0;
	const encoder = new TextEncoder();
	const fetchImpl = Object.assign(
		async (): Promise<Response> => {
			calls++;
			if (calls > 1) {
				return openAIStreamResponse(
					[
						'data: {"choices":[{"delta":{"content":"done"}}]}',
						'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
						"data: [DONE]",
					].join("\n\n"),
				);
			}
			let sent = false;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (!sent) {
						sent = true;
						controller.enqueue(encoder.encode(firstBody));
						return;
					}
					controller.error(new Error("stream read error"));
				},
			});
			return openAIStreamResponse(body);
		},
		{ preconnect: fetch.preconnect },
	);
	return fetchImpl;
}

const truncatedToolModel = buildModel({
	id: "openai-truncated-tool-test",
	name: "OpenAI Truncated Tool Test",
	api: "openai-completions",
	provider: "custom",
	baseUrl: "https://completions.example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4_096,
});

const anthropicTruncatedToolModel = buildModel({
	id: "anthropic-truncated-tool-test",
	name: "Anthropic Truncated Tool Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://anthropic.example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4_096,
});

function anthropicSseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicSequenceFetch(firstBody: string, nextBody: string): FetchImpl {
	let calls = 0;
	const fetchImpl = Object.assign(
		async (): Promise<Response> => {
			const body = calls++ === 0 ? firstBody : nextBody;
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		},
		{ preconnect: fetch.preconnect },
	);
	return fetchImpl;
}

test("does not execute an OpenAI tool call after a stream-read error cuts off its JSON", async () => {
	const received: unknown[] = [];
	const tool = basicTool("record", async (_id, args) => {
		received.push(args);
		return okToolResult();
	});
	const context: AgentContext = { systemPrompt: [], messages: [], tools: [tool] };
	const config = loopConfig(context, { model: truncatedToolModel, apiKey: "test-key" });
	const firstBody = `data: ${JSON.stringify({
		choices: [
			{
				delta: {
					tool_calls: [
						{
							index: 0,
							id: "call_truncated",
							type: "function",
							function: { name: "record", arguments: '{"value": "' },
						},
					],
				},
			},
		],
	})}\n\n`;
	const fetchImpl = openAIErroringFetch(firstBody);
	const streamFn: StreamFn = (targetModel, llmContext, options) => {
		const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
		return streamOpenAICompletions(targetModel as Model<"openai-completions">, llmContext, {
			apiKey,
			signal: options?.signal,
			fetch: fetchImpl,
		});
	};

	const result = await agentLoop([userMessage("hello")], context, config, undefined, streamFn).result();

	expect(received).toEqual([]);
	const assistant = result.findLast((message): message is AssistantMessage => message.role === "assistant");
	expect(assistant?.stopReason).not.toBe("toolUse");
});

test("does not execute an Anthropic tool call without its content-block stop event", async () => {
	const received: unknown[] = [];
	const tool = basicTool("record", async (_id, args) => {
		received.push(args);
		return okToolResult();
	});
	const context: AgentContext = { systemPrompt: [], messages: [], tools: [tool] };
	const config = loopConfig(context, { model: anthropicTruncatedToolModel, apiKey: "test-key" });
	const firstBody = [
		anthropicSseFrame("message_start", {
			type: "message_start",
			message: { id: "message-truncated", usage: { input_tokens: 1, output_tokens: 0 } },
		}),
		anthropicSseFrame("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "call_truncated", name: "record", input: {} },
		}),
		anthropicSseFrame("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '{"value": "' },
		}),
		anthropicSseFrame("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "tool_use" },
			usage: { output_tokens: 1 },
		}),
		anthropicSseFrame("message_stop", { type: "message_stop" }),
	].join("");
	const nextBody = [
		anthropicSseFrame("message_start", {
			type: "message_start",
			message: { id: "message-done", usage: { input_tokens: 1, output_tokens: 0 } },
		}),
		anthropicSseFrame("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "done" },
		}),
		anthropicSseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
		anthropicSseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
		anthropicSseFrame("message_stop", { type: "message_stop" }),
	].join("");
	const fetchImpl = anthropicSequenceFetch(firstBody, nextBody);
	const streamFn: StreamFn = (targetModel, llmContext, options) => {
		const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
		return streamAnthropic(targetModel as Model<"anthropic-messages">, llmContext, {
			apiKey,
			signal: options?.signal,
			fetch: fetchImpl,
			providerRetryWait: async () => {},
		});
	};

	const result = await agentLoop([userMessage("hello")], context, config, undefined, streamFn).result();

	expect(received).toEqual([]);
	const assistant = result.findLast((message): message is AssistantMessage => message.role === "assistant");
	expect(assistant?.stopReason).toBe("error");
});

test("explicit abort reasons retain their text without becoming retryable", async () => {
	const started = deferred<void>();
	const controller = new AbortController();
	const stream = agentLoop(
		[userMessage("hello")],
		{ systemPrompt: [], messages: [], tools: [] },
		loopConfig({ systemPrompt: [], messages: [], tools: [] }),
		controller.signal,
		() => {
			const response = createAssistantMessageEventStream();
			started.resolve();
			return response;
		},
	);
	await started.promise;
	controller.abort("429 rate limit");
	const messages = await stream.result();
	const assistant = messages.findLast((message): message is AssistantMessage => message.role === "assistant");
	expect(assistant?.errorMessage).toBe("429 rate limit");
	expect(assistant?.errorId).toBeDefined();
	expect(AIError.is(assistant?.errorId, AIError.Flag.Abort)).toBe(true);
	expect(AIError.retriable(assistant?.errorId)).toBe(false);
});
