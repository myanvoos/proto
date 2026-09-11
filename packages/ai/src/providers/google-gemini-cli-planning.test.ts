import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Context, FetchImpl } from "../types";
import { streamGoogleGeminiCli } from "./google-gemini-cli";

const model = buildModel({
	id: "gemini-2.5-flash",
	name: "Gemini planning-buffer test",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	baseUrl: "https://gemini.example.test",
	contextWindow: 32_000,
	maxTokens: 4_096,
});

const context: Context = { messages: [], tools: [] };

const escapedQuotePlanning = String.raw`{"thought":"say \"quoted\""}`;

function fetchFor(parts: readonly string[]): FetchImpl {
	const frames = parts.map(text => ({
		response: {
			candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: undefined as string | undefined }],
		},
	}));
	frames.push({
		response: {
			candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
		},
	});
	const body = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("");
	return Object.assign(
		async (): Promise<Response> => new Response(body, { headers: { "content-type": "text/event-stream" } }),
		{ preconnect: fetch.preconnect },
	);
}

async function runPlanning(chunks: readonly string[]): Promise<{ text: string; stopReason: string; error?: string }> {
	const result = await streamGoogleGeminiCli(model, context, {
		apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
		fetch: fetchFor(chunks),
		streamFirstEventTimeoutMs: 60_000,
		streamIdleTimeoutMs: 60_000,
		thinking: { enabled: true },
	}).result();
	const text = result.content.reduce(
		(combined, block) => (block.type === "text" ? combined + block.text : combined),
		"",
	);
	return { text, stopReason: result.stopReason, error: result.errorMessage };
}

function splitEvery(text: string, width: number): string[] {
	const chunks: string[] = [];
	for (let index = 0; index < text.length; index += width) chunks.push(text.slice(index, index + width));
	return chunks;
}

describe("Gemini planning-buffer classification", () => {
	it("strips a valid planning leak and preserves visible suffix text", async () => {
		await expect(runPlanning([...splitEvery('{"thought":"plan"}', 2), " suffix"])).resolves.toMatchObject({
			text: " suffix",
			stopReason: "stop",
		});
	});

	it("uses the malformed-object fallback without dropping its visible suffix", async () => {
		await expect(runPlanning([...splitEvery('{"thought":"unterminated}', 2), " suffix"])).resolves.toMatchObject({
			text: " suffix",
			stopReason: "stop",
		});
	});

	it("keeps an ordinary leading JSON object visible", async () => {
		await expect(runPlanning([...splitEvery('{"message":"hello"}', 2), " suffix"])).resolves.toMatchObject({
			text: '{"message":"hello"} suffix',
			stopReason: "stop",
		});
	});

	it("handles nested braces inside a planning string", async () => {
		await expect(
			runPlanning([...splitEvery('{"thought":"nested { braces }"}', 2), " suffix"]),
		).resolves.toMatchObject({
			text: " suffix",
			stopReason: "stop",
		});
	});

	it("handles escaped quotes split across deltas", async () => {
		await expect(runPlanning([...splitEvery(escapedQuotePlanning, 2), " suffix"])).resolves.toMatchObject({
			text: " suffix",
			stopReason: "stop",
		});
	});

	it("classifies a partial planning object at stream end", async () => {
		await expect(runPlanning(["visible before", ...splitEvery('{"thought":"partial"', 2)])).resolves.toMatchObject({
			text: "visible before",
			stopReason: "stop",
		});
	});
});
