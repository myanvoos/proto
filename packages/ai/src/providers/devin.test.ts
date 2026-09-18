import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	GetChatMessageResponseSchema,
	GetUserJwtResponseSchema,
	StopReason,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import * as AIError from "../error";
import type { Context, FetchImpl, ModelSpec } from "../types";
import { streamDevin } from "./devin";

const model = buildModel({
	id: "devin-stream-test",
	name: "Devin Stream Test",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://devin.example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4_096,
} satisfies ModelSpec<"devin-agent">);

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

function connectFrame(payload: Uint8Array, flag = 0): Buffer {
	const frame = Buffer.alloc(5 + payload.byteLength);
	frame[0] = flag;
	frame.writeUInt32BE(payload.byteLength, 1);
	frame.set(payload, 5);
	return frame;
}

function messageFrame(stopReason: StopReason, deltaText = "Hello"): Buffer {
	return connectFrame(
		toBinary(
			GetChatMessageResponseSchema,
			create(GetChatMessageResponseSchema, { messageId: "message-1", deltaText, stopReason }),
		),
	);
}

function endStreamFrame(): Buffer {
	return connectFrame(new TextEncoder().encode("{}"), 0x02);
}

function fetchForChatBytes(chatBytes: Uint8Array): FetchImpl {
	const authBytes = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "test-jwt" }));
	return Object.assign(
		async (input: string | URL | Request): Promise<Response> => {
			const url = input instanceof Request ? input.url : String(input);
			return url.endsWith("/exa.auth_pb.AuthService/GetUserJwt") ? new Response(authBytes) : new Response(chatBytes);
		},
		{ preconnect: fetch.preconnect },
	);
}

function streamChat(chatBytes: Uint8Array) {
	return streamDevin(model, context, { apiKey: "test-key", fetch: fetchForChatBytes(chatBytes) });
}

async function runChat(chatBytes: Uint8Array) {
	return streamChat(chatBytes).result();
}

describe("Devin stop reasons", () => {
	it.each([StopReason.CONTENT_FILTER, StopReason.ERROR, StopReason.NONFINITE_LOGIT_OR_PROB, StopReason.UNSPECIFIED])(
		"surfaces provider failure stop reason %s as an error",
		async stopReason => {
			const result = await runChat(Buffer.concat([messageFrame(stopReason), endStreamFrame()]));
			expect(result.stopReason).toBe("error");
		},
	);

	it.each([StopReason.INCOMPLETE, StopReason.MAX_TOKENS, StopReason.PARTIAL])(
		"maps truncated stop reason %s to length",
		async stopReason => {
			const result = await runChat(Buffer.concat([messageFrame(stopReason), endStreamFrame()]));
			expect(result.stopReason).toBe("length");
		},
	);

	it("maps an explicit function-call stop to tool use", async () => {
		const result = await runChat(Buffer.concat([messageFrame(StopReason.FUNCTION_CALL), endStreamFrame()]));
		expect(result.stopReason).toBe("toolUse");
	});

	it.each([
		StopReason.STOP_PATTERN,
		StopReason.MIN_LOG_PROB,
		StopReason.MAX_NEWLINES,
		StopReason.EXIT_SCOPE,
		StopReason.FIRST_NON_WHITESPACE_LINE,
		StopReason.NON_INSERTION,
	])("preserves genuine terminal stop reason %s", async stopReason => {
		const result = await runChat(Buffer.concat([messageFrame(stopReason), endStreamFrame()]));
		expect(result.stopReason).toBe("stop");
	});
});

describe("Devin Connect stream termination", () => {
	it("rejects EOF without a Connect end-stream envelope", async () => {
		const stream = streamChat(messageFrame(StopReason.STOP_PATTERN));
		const events = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("end-stream");
		expect(AIError.retriable(result.errorId)).toBe(true);
		expect(events.some(event => event.type === "text_end" || event.type === "done")).toBe(false);
		expect(events.at(-1)?.type).toBe("error");
	});

	it("rejects EOF with a partial buffered Connect frame", async () => {
		const partialEndFrame = endStreamFrame().subarray(0, 3);
		const result = await runChat(Buffer.concat([messageFrame(StopReason.STOP_PATTERN), partialEndFrame]));
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("3 buffered bytes");
	});

	it("accepts a complete stream with a valid end-stream envelope", async () => {
		const result = await runChat(Buffer.concat([messageFrame(StopReason.STOP_PATTERN), endStreamFrame()]));
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
	});
});
