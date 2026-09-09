import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Context, FetchImpl } from "../types";
import { streamOpenAICompletions } from "./openai-completions";

const model = buildModel({
	id: "done-sentinel-test",
	name: "Done Sentinel Test",
	api: "openai-completions",
	provider: "custom",
	baseUrl: "https://completions.example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4_096,
});

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

function fetchFor(frames: readonly unknown[]): FetchImpl {
	const body = frames.map(frame => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join("");
	return Object.assign(
		async (): Promise<Response> => new Response(body, { headers: { "content-type": "text/event-stream" } }),
		{ preconnect: fetch.preconnect },
	);
}

async function runStream(
	frames: readonly unknown[],
): Promise<{ stopReason: string; errorMessage?: string; text: string }> {
	const result = await streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		fetch: fetchFor(frames),
	}).result();
	const text = result.content.reduce((combined, block) => {
		return block.type === "text" ? combined + block.text : combined;
	}, "");
	return { stopReason: result.stopReason, errorMessage: result.errorMessage, text };
}

describe("OpenAI Completions stream termination", () => {
	it("treats [DONE] without finish_reason as a clean completion", async () => {
		const result = await runStream([
			{ choices: [{ delta: { content: "Hel" } }] },
			{ choices: [{ delta: { content: "lo" } }] },
			"[DONE]",
		]);

		expect(result).toEqual({ stopReason: "stop", errorMessage: undefined, text: "Hello" });
	});

	it("still reports a genuine EOF without [DONE] or finish_reason as incomplete", async () => {
		const result = await runStream([
			{ choices: [{ delta: { content: "Hel" } }] },
			{ choices: [{ delta: { content: "lo" } }] },
		]);

		expect(result).toEqual({
			stopReason: "error",
			errorMessage: "OpenAI completions stream closed before a finish_reason was received",
			text: "Hello",
		});
	});
});
