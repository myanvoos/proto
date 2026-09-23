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
import { agentLoop, TERMINAL_TOOL_RESULT_ABORT_REASON } from "./agent-loop";
import {
	type AgentContext,
	type AgentEvent,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentTool,
	type AgentToolResult,
	ASIDE_MESSAGE_DISCARD,
	type StreamFn,
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

test("streaming snapshots show silent updates to still-open blocks", async () => {
	const toolCallStarted = deferred<void>();
	const streamFn: StreamFn = targetModel => {
		const stream = createAssistantMessageEventStream();
		const partial: AssistantMessage = { ...assistantMessage(targetModel, ""), content: [] };
		stream.push({ type: "start", partial });
		const edit = { type: "toolCall" as const, id: "edit-1", name: "edit", arguments: {} };
		partial.content.push(edit);
		stream.push({ type: "toolcall_start", contentIndex: 0, partial });
		void (async () => {
			await toolCallStarted.promise;
			// Cursor merges edit args into an open block without emitting an event for it.
			edit.arguments = { path: "a.ts" };
			partial.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: 1, partial });
			stream.push({ type: "done", reason: "stop", message: assistantMessage(targetModel, "done") });
		})();
		return stream;
	};

	const { events } = await runSingleResponse(streamFn, {
		onAssistantMessageEvent: (_message, event) => {
			if (event.type === "toolcall_start") toolCallStarted.resolve();
		},
	});

	const textStart = events.find(
		event => event.type === "message_update" && event.assistantMessageEvent.type === "text_start",
	);
	if (textStart?.type !== "message_update" || textStart.assistantMessageEvent.type !== "text_start") {
		throw new Error("missing text_start update");
	}
	expect(textStart.assistantMessageEvent.partial.content[0]).toMatchObject({
		type: "toolCall",
		arguments: { path: "a.ts" },
	});
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

test("queued steering runs already-emitted non-interruptible calls, skips interruptible waits, then injects", async () => {
	const executed: string[] = [];
	const write = basicTool(
		"write",
		async () => {
			executed.push("write");
			return okToolResult();
		},
		"exclusive",
	);
	const wait: AgentTool = {
		...basicTool(
			"wait",
			async () => {
				executed.push("wait");
				return okToolResult();
			},
			"exclusive",
		),
		interruptible: true,
	};
	const context: AgentContext = { systemPrompt: [], messages: [], tools: [write, wait] };
	let responses = 0;
	let delivered = false;
	const config = loopConfig(context, {
		interruptMode: "immediate",
		// Steering is already queued when the batch starts: the user typed while the calls streamed.
		hasSteeringMessages: () => responses >= 1 && !delivered,
		getSteeringMessages: async () => {
			if (responses < 1 || delivered) return [];
			delivered = true;
			return [userMessage("interrupt")];
		},
	});
	const stream = agentLoop([userMessage("hello")], context, config, undefined, targetModel => {
		const response = createAssistantMessageEventStream();
		response.end(
			responses++ === 0
				? toolMessage(targetModel, [
						{ id: "call-1", name: "write" },
						{ id: "call-2", name: "wait" },
						{ id: "call-3", name: "write" },
					])
				: assistantMessage(targetModel, "done"),
		);
		return response;
	});
	const order: string[] = [];
	const skipped: string[] = [];
	for await (const event of stream) {
		if (event.type !== "message_start") continue;
		if (event.message.role === "toolResult") {
			order.push(event.message.toolCallId);
			if (event.message.isError) skipped.push(event.message.toolCallId);
		}
		if (
			event.message.role === "user" &&
			Array.isArray(event.message.content) &&
			event.message.content.some(block => block.type === "text" && block.text === "interrupt")
		) {
			order.push("interrupt");
		}
	}

	expect(executed).toEqual(["write", "write"]);
	expect(skipped).toEqual(["call-2"]);
	// Every call settles before the steer lands at the batch boundary.
	expect(order.slice(0, 3).sort()).toEqual(["call-1", "call-2", "call-3"]);
	expect(order[3]).toBe("interrupt");
});

test("a tool-name miss names the advertised tool sharing its most distinctive trailing segment", async () => {
	const noop = async () => okToolResult();
	// Three tools share only the generic `_get` tail and are listed first.
	const tools = ["read", "alpha_get", "beta_get", "gamma_get", "mcp__context_resolve_library_get"].map(name =>
		basicTool(name, noop),
	);
	const context: AgentContext = { systemPrompt: [], messages: [], tools };
	const misses = [
		{ id: "lost-id-segment", name: "mcp__abc123__xyz789_read" },
		{ id: "lost-separator", name: "mcp__context7__resolve_library_get" },
		{ id: "unrelated", name: "totally_unrelated" },
	];
	let responses = 0;
	const messages = await agentLoop([userMessage("go")], context, loopConfig(context), undefined, targetModel => {
		const response = createAssistantMessageEventStream();
		response.end(responses++ === 0 ? toolMessage(targetModel, misses) : assistantMessage(targetModel, "done"));
		return response;
	}).result();
	const errorText = (id: string): string => {
		const result = messages.find(message => message.role === "toolResult" && message.toolCallId === id);
		if (result?.role !== "toolResult") throw new Error(`missing result for ${id}`);
		return result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
	};

	expect(errorText("lost-id-segment")).toContain("Did you mean read?");
	// The distinctive tail's match leads the capped list ahead of tools sharing only `_get`.
	expect(errorText("lost-separator")).toContain("Closest available: mcp__context_resolve_library_get, ");
	expect(errorText("unrelated")).toContain("Tool totally_unrelated not found");
	expect(errorText("unrelated")).not.toContain("Did you mean");
});

test("a throwing aside discard hook neither skips later hooks nor replaces the loop error", async () => {
	const throwingAside = userMessage("throwing completion");
	Object.defineProperty(throwingAside, ASIDE_MESSAGE_DISCARD, {
		value: () => {
			throw new Error("discard failed");
		},
	});
	const aside = userMessage("completion");
	let discarded: Error | undefined;
	Object.defineProperty(aside, ASIDE_MESSAGE_DISCARD, {
		value: (error: Error) => {
			discarded = error;
		},
	});
	let delivered = false;
	const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
	const stream = agentLoop(
		[userMessage("hi")],
		context,
		loopConfig(context, {
			getAsideMessages: async () => {
				if (delivered) return [];
				delivered = true;
				return [
					() => throwingAside,
					() => aside,
					() => {
						throw new Error("later aside failed");
					},
				];
			},
		}),
		undefined,
		responseFor(targetModel => assistantMessage(targetModel, "done")),
	);

	const drain = async () => {
		for await (const _event of stream) {
			// Drain the loop.
		}
		await stream.result();
	};
	await expect(drain()).rejects.toThrow("later aside failed");
	expect(discarded?.message).toBe("later aside failed");
});

test("a terminal-yield turn still reaches onTurnEnd, without the spent abort signal", async () => {
	const controller = new AbortController();
	let calls = 0;
	const streamFn: StreamFn = targetModel => {
		calls++;
		const stream = createAssistantMessageEventStream();
		stream.end(
			calls === 1
				? toolMessage(targetModel, [{ id: "yield-1", name: "yield" }])
				: assistantMessage(targetModel, "must not be reached"),
		);
		return stream;
	};
	const context: AgentContext = {
		systemPrompt: [],
		messages: [],
		tools: [basicTool("yield", async () => okToolResult("final answer"))],
	};
	const turnEndCalls: Array<{ willContinue: boolean | undefined; signalAborted: boolean }> = [];
	const stream = agentLoop(
		[userMessage("go")],
		context,
		loopConfig(context, {
			afterToolCall: async () => {
				controller.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
			},
			onTurnEnd: (_messages, signal, ctx) => {
				turnEndCalls.push({ willContinue: ctx?.willContinue, signalAborted: signal?.aborted === true });
			},
		}),
		controller.signal,
		streamFn,
	);
	for await (const _event of stream) {
		// Drain the loop.
	}

	// Per-turn bookkeeping (advisor review of the yield) must see the final turn as a plain completed turn.
	expect(calls).toBe(1);
	expect(turnEndCalls).toEqual([{ willContinue: false, signalAborted: false }]);
});
