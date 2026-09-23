import { expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { streamSimple } from "./stream";
import type { Context, FetchImpl, SimpleStreamOptions } from "./types";
import { Effort } from "./types";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

const chatCompletions = buildModel({
	id: "gpt-5.1",
	name: "gpt-5.1",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
});

async function reasoningEffortSent(options: SimpleStreamOptions): Promise<unknown> {
	let payload: { reasoning_effort?: unknown } | undefined;
	const fetchMock: FetchImpl = async () =>
		new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
	await streamSimple(chatCompletions, context, {
		...options,
		apiKey: "test-key",
		fetch: fetchMock,
		onPayload: body => {
			payload = body as { reasoning_effort?: unknown };
		},
	}).result();
	if (!payload) throw new Error("request payload was not captured");
	return payload.reasoning_effort;
}

it("a forced reasoning-off chat-completions turn sends no reasoning effort", async () => {
	expect(await reasoningEffortSent({ reasoning: Effort.Medium })).toBe(Effort.Medium);
	expect(await reasoningEffortSent({ reasoning: Effort.Medium, forceReasoningOff: true })).toBeUndefined();
});
