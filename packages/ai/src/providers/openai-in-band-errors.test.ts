import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isAuthRetryableError } from "../error/auth-classify";
import { Flag, is, retriable } from "../error/flags";
import { isUsageLimitOutcome } from "../error/rate-limit";
import type { AssistantMessage, Context, FetchImpl } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { streamOpenAICompletions } from "./openai-completions";
import type { ResponseStreamEvent } from "./openai-responses-wire";
import { createInitialResponsesAssistantMessage, processResponsesStream } from "./openai-shared";

const completionsModel = buildModel({
	id: "in-band-error-test",
	name: "In-band Error Test",
	api: "openai-completions",
	provider: "custom",
	baseUrl: "https://completions.example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4_096,
});

const responsesModel = buildModel({
	id: "in-band-error-test",
	name: "In-band Error Test",
	api: "openai-responses",
	provider: "openai-test",
	baseUrl: "https://responses.example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4_096,
});

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

async function streamFrames(frames: readonly unknown[]): Promise<{ result: AssistantMessage; attempts: number }> {
	const body = frames.map(frame => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join("");
	let attempts = 0;
	const fetchImpl: FetchImpl = Object.assign(
		async (): Promise<Response> => {
			attempts++;
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		},
		{ preconnect: fetch.preconnect },
	);
	const result = await streamOpenAICompletions(completionsModel, context, {
		apiKey: "test-key",
		fetch: fetchImpl,
		providerRetryWait: async () => {},
	}).result();
	return { result, attempts };
}

async function runResponses(events: readonly Record<string, unknown>[]): Promise<unknown> {
	const output = createInitialResponsesAssistantMessage("openai-responses", "openai-test", responsesModel.id);
	async function* source(): AsyncGenerator<ResponseStreamEvent> {
		yield* events as unknown as ResponseStreamEvent[];
	}
	try {
		await processResponsesStream(source(), output, new AssistantMessageEventStream(), responsesModel);
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("in-band errors inside an HTTP 200 completions stream", () => {
	const throttles: [label: string, frame: unknown, status: number][] = [
		["nested error.type", { error: { type: "rate_limit_error" } }, 429],
		["bare numeric code", { code: 429 }, 429],
		["flat status and message", { status: 429, message: "slow down" }, 429],
		["string status field", { error: { status: "429", message: "compat status" } }, 429],
		["overload type", { error: { type: "overloaded_error" } }, 503],
		[
			"queue-full envelope",
			{ error: { message: "The request queue is full.", type: "SERVICE_UNAVAILABLE", code: 503 } },
			503,
		],
	];
	for (const [label, frame, status] of throttles) {
		it(`${label} fails as a retryable ${status} and retries once before output`, async () => {
			const { result, attempts } = await streamFrames([frame, "[DONE]"]);

			expect(result.stopReason).toBe("error");
			expect(result.errorStatus).toBe(status);
			expect(retriable(result.errorId)).toBe(true);
			expect(is(result.errorId, Flag.UsageLimit)).toBe(false);
			expect(result.errorMessage?.startsWith(`${status} `)).toBe(true);
			expect(attempts).toBe(2);
		});
	}

	it("never lets a synthesized opaque 429 read as quota exhaustion", async () => {
		const { result } = await streamFrames([{ status: 429, message: "{}" }, "[DONE]"]);

		expect(result.errorMessage).toBe("429 Provider returned an in-band provider error");
		expect(isUsageLimitOutcome(429, result.errorMessage)).toBe(false);
	});

	it("does not fabricate a status from prose that mentions an auth code", async () => {
		const { result } = await streamFrames([
			{ error: { message: "Too many requests (401 from billing shim)" } },
			"[DONE]",
		]);

		expect(result.errorStatus).toBeUndefined();
		expect(retriable(result.errorId)).toBe(true);
		expect(isAuthRetryableError(new Error(result.errorMessage))).toBe(false);
		expect(result.errorMessage).toBe("Too many requests (401 from billing shim)");
	});

	it("classifies a proxy's plain-text and HTML throttle frames", async () => {
		const plain = await streamFrames(["429 Too Many Requests"]);
		const html = await streamFrames([
			"<html><head><title>503 Service Temporarily Unavailable</title></head><body>nginx</body></html>",
		]);

		expect(plain.result.errorStatus).toBe(429);
		expect(plain.result.errorMessage).toBe("429 Too Many Requests");
		expect(html.result.errorStatus).toBe(503);
		expect(html.result.errorMessage).toBe("503 Service Temporarily Unavailable nginx");
	});

	it("keeps non-throttle envelopes terminal with their own message", async () => {
		const structured = await streamFrames([{ error: { type: "invalid_request_error", message: "bad" } }, "[DONE]"]);
		const flat = await streamFrames([{ error: "model not found" }, "[DONE]"]);
		const malformed = await streamFrames(["model gpt-500x rejected the request"]);

		expect(structured.result).toMatchObject({ stopReason: "error", errorMessage: "bad", errorStatus: undefined });
		expect(structured.attempts).toBe(1);
		expect(flat.result).toMatchObject({ stopReason: "error", errorMessage: "model not found" });
		expect(malformed.result.errorStatus).toBeUndefined();
		expect(malformed.result.errorMessage).toContain("JSON Parse error");
	});

	it("does not replay once content preceded the in-band error", async () => {
		const { result, attempts } = await streamFrames([
			{ choices: [{ delta: { content: "Partial" } }] },
			{ error: { message: "Request timed out in the queue.", type: "REQUEST_TIMEOUT" } },
			"[DONE]",
		]);

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(408);
		expect(result.content).toEqual([{ type: "text", text: "Partial" }]);
	});
});

describe("in-band errors inside an HTTP 200 Responses stream", () => {
	it("surfaces a throttle error event as a retryable 429", async () => {
		const error = await runResponses([{ type: "error", code: "rate_limit_exceeded", message: "Rate limit reached" }]);

		expect(error).toMatchObject({ status: 429, message: "429 Rate limit reached (rate_limit_exceeded)" });
	});

	it("surfaces a failed response carrying an overload error as a 503", async () => {
		const error = await runResponses([
			{
				type: "response.failed",
				response: { id: "resp_1", status: "failed", error: { code: "server_overloaded", message: "try later" } },
			},
		]);

		expect(error).toMatchObject({ status: 503 });
	});

	it("keeps a terminal server_error envelope in its existing format", async () => {
		const error = await runResponses([
			{
				type: "response.failed",
				response: { id: "resp_1", status: "failed", error: { code: "server_error", message: "Backend failure" } },
			},
		]);

		expect(error).toMatchObject({ message: "server_error: Backend failure" });
		expect(error).not.toHaveProperty("status");
	});
});
