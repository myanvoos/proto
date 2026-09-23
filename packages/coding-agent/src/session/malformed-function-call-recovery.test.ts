/**
 * Gemini reports MALFORMED_FUNCTION_CALL when the model transcribes a call as text. The rendered text vetoes the
 * replay retry, so the session keeps the failed turn and continues with a corrective reminder, bounded per prompt.
 */
import { afterEach, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, type Message, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { convertToLlm } from "./messages";
import { SessionManager } from "./session-manager";

const MALFORMED_ERROR = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL";
const TRANSCRIBED_CALL = "```call:default_api:read{i:Read call_frame.rs,path:src/call_frame.rs:215-320}```";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
});

function textOf(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map(part => (part.type === "text" ? part.text : "")).join("");
}

/** Streams `malformedTurns` transcribed-call errors, then a clean answer; records each request's context. */
async function runSession(malformedTurns: number) {
	const model = getBundledModel("google", "gemini-2.5-flash") as Model;
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey(model.provider, "test-key");
	const requests: Message[][] = [];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: (_model, context) => {
			requests.push([...context.messages]);
			const malformed = requests.length <= malformedTurns;
			const text = malformed ? TRANSCRIBED_CALL : "Recovered after transcribed function call";
			const stream = createAssistantMessageEventStream();
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
				stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
				if (malformed) {
					stream.push({
						type: "error",
						reason: "error",
						error: { ...partial, stopReason: "error", errorMessage: MALFORMED_ERROR },
					});
					return;
				}
				stream.push({ type: "done", reason: "stop", message: partial });
			});
			return stream;
		},
	});
	const settings = Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 1, "retry.maxRetries": 1 });
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(authStorage),
	});
	let retryStarts = 0;
	session.subscribe(event => {
		if (event.type === "auto_retry_start") retryStarts++;
	});
	await session.prompt("recover from a transcribed function call");
	await session.waitForIdle();
	return { requests, retryStarts, messages: session.agent.state.messages };
}

it("keeps the transcribed turn and continues with a corrective reminder instead of stopping", async () => {
	const { requests, retryStarts, messages } = await runSession(1);

	expect(retryStarts).toBe(0);
	expect(requests).toHaveLength(2);
	expect(requests[1].map(message => message.role)).toEqual(["user", "assistant", "developer"]);
	expect(textOf(requests[1][1])).toBe(TRANSCRIBED_CALL);
	expect(textOf(requests[1][2])).toContain("Attempt #1/3");
	const last = messages.at(-1);
	expect(last?.role === "assistant" && last.stopReason).toBe("stop");
});

it("surfaces the error once the per-prompt cap is spent", async () => {
	const { requests, messages } = await runSession(Number.POSITIVE_INFINITY);

	expect(requests).toHaveLength(4);
	expect(textOf(requests[3].at(-1) as Message)).toContain("Attempt #3/3");
	const last = messages.at(-1);
	expect(last?.role === "assistant" && last.stopReason).toBe("error");
});
