import { expect, test } from "bun:test";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
} from "@oh-my-pi/pi-ai";
import { Agent, AgentBusyError } from "./agent";
import type { AgentMessage, StreamFn } from "./types";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	const { promise, resolve } = Promise.withResolvers<T>();
	return { promise, resolve };
}

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

function assistantMessage(model: Model, text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp,
	};
}

function finishTextResponse(
	stream: AssistantMessageEventStream,
	model: Model,
	text: string,
	timestamp: number,
	started = false,
): void {
	if (!started) stream.push({ type: "start", partial: assistantMessage(model, "", timestamp) });
	const final = assistantMessage(model, text, timestamp);
	stream.push({ type: "done", reason: "stop", message: final });
}

function messageText(message: AgentMessage): string | undefined {
	if (!("content" in message)) return undefined;
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return undefined;
	const text = message.content.find(
		(block): block is { type: "text"; text: string } =>
			typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block,
	);
	return text?.text;
}

test("reset refuses an active run and preserves exclusive transcript ownership", async () => {
	const firstStarted = deferred<void>();
	const releaseFirst = deferred<void>();
	let firstCall = true;
	let activeResponses = 0;
	let maxActiveResponses = 0;

	const streamFn: StreamFn = (model, context) => {
		const stream = createAssistantMessageEventStream();
		const isFirst = firstCall;
		firstCall = false;
		activeResponses++;
		maxActiveResponses = Math.max(maxActiveResponses, activeResponses);
		const timestamp = Date.now();
		const prompt = context.messages.findLast(message => message.role === "user");
		const responseText = `response to ${prompt ? messageText(prompt) : "unknown"}`;

		if (!isFirst) {
			finishTextResponse(stream, model, responseText, timestamp);
			activeResponses--;
			return stream;
		}

		stream.push({ type: "start", partial: assistantMessage(model, "", timestamp) });
		firstStarted.resolve();
		void (async () => {
			try {
				await releaseFirst.promise;
				finishTextResponse(stream, model, responseText, timestamp, true);
			} catch (error) {
				stream.fail(error);
			} finally {
				activeResponses--;
			}
		})();
		return stream;
	};

	const agent = new Agent({ streamFn });
	const firstPrompt = agent.prompt("first");
	try {
		await firstStarted.promise;

		let resetError: unknown;
		try {
			agent.reset();
		} catch (error) {
			resetError = error;
		}
		const overlappingAttempt = agent.prompt("overlap").then(
			() => ({ status: "fulfilled" as const }),
			error => ({ status: "rejected" as const, error }),
		);

		releaseFirst.resolve();
		const overlapOutcome = await overlappingAttempt;
		await firstPrompt;

		expect(resetError).toBeInstanceOf(AgentBusyError);
		expect(overlapOutcome.status).toBe("rejected");
		if (overlapOutcome.status === "rejected") {
			expect(overlapOutcome.error).toBeInstanceOf(AgentBusyError);
		}
		expect(maxActiveResponses).toBe(1);
		expect(agent.state.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(messageText(agent.state.messages[0])).toBe("first");
		expect(messageText(agent.state.messages[1])).toBe("response to first");

		agent.reset();
		expect(agent.state.messages).toEqual([]);
		await agent.prompt("after reset");
		expect(agent.state.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(messageText(agent.state.messages[0])).toBe("after reset");
		expect(messageText(agent.state.messages[1])).toBe("response to after reset");
		expect(maxActiveResponses).toBe(1);
	} finally {
		releaseFirst.resolve();
		agent.abort("test cleanup");
		await agent.waitForIdle();
	}
}, 5_000);
