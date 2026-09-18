import { expect, test } from "bun:test";
import { type AssistantMessage, createAssistantMessageEventStream, type Message, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { agentLoop } from "./agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "./types";

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
