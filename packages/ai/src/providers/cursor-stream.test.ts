import { afterEach, describe, expect, it, vi } from "bun:test";
import * as http2 from "node:http2";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	type InteractionUpdate,
	InteractionUpdateSchema,
	ReadArgsSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import * as AIError from "../error";
import type { AssistantMessage, Context, Model, ModelSpec } from "../types";
import { streamCursor } from "./cursor";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

function cursorModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "gpt-5.6-sol",
		name: "Cursor Stream Test",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 4_096,
	} satisfies ModelSpec<"cursor-agent">);
}

function connectFrame(payload: Uint8Array): Buffer {
	const frame = Buffer.alloc(5 + payload.byteLength);
	frame[0] = 0;
	frame.writeUInt32BE(payload.byteLength, 1);
	frame.set(payload, 5);
	return frame;
}

function interactionFrame(message: InteractionUpdate["message"]): Buffer {
	const update = create(InteractionUpdateSchema, { message });
	const envelope = create(AgentServerMessageSchema, {
		message: { case: "interactionUpdate", value: update },
	});
	return connectFrame(toBinary(AgentServerMessageSchema, envelope));
}

function textFrame(text: string): Buffer {
	return interactionFrame({ case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) });
}

function turnEndedFrame(): Buffer {
	return interactionFrame({ case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) });
}

function readExecFrame(): Buffer {
	const exec = create(ExecServerMessageSchema, {
		id: 1,
		execId: "exec-1",
		message: {
			case: "readArgs",
			value: create(ReadArgsSchema, { path: "/tmp/example", toolCallId: "read-1" }),
		},
	});
	const envelope = create(AgentServerMessageSchema, {
		message: { case: "execServerMessage", value: exec },
	});
	return connectFrame(toBinary(AgentServerMessageSchema, envelope));
}

async function withCursorResponse<T>(
	frames: readonly Uint8Array[],
	run: (model: Model<"cursor-agent">) => Promise<T>,
): Promise<T> {
	const server = http2.createServer();
	server.on("sessionError", () => {});
	server.on("stream", (request: http2.ServerHttp2Stream) => {
		request.on("error", () => {});
		request.respond({ ":status": 200, "content-type": "application/connect+proto" });
		request.end(Buffer.concat(frames));
	});
	const { promise: listening, resolve: resolveListening } = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", resolveListening);
	await listening;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Cursor test server did not bind a TCP port");

	try {
		return await run(cursorModel(`http://127.0.0.1:${address.port}`));
	} finally {
		const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
		server.close(() => resolveClosed());
		await closed;
	}
}

async function runCursorFrames(frames: readonly Uint8Array[]): Promise<AssistantMessage> {
	return withCursorResponse(frames, model => streamCursor(model, context, { apiKey: "cursor-token" }).result());
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Cursor stream frame integrity", () => {
	it("rejects a malformed protobuf frame even when turnEnded follows", async () => {
		const result = await runCursorFrames([connectFrame(new Uint8Array([0xff])), turnEndedFrame()]);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/decode|protobuf|frame/i);
		expect(AIError.retriable(result.errorId)).toBe(true);
	});

	it("rejects a message dispatch failure even when turnEnded follows", async () => {
		const result = await withCursorResponse([readExecFrame(), turnEndedFrame()], model =>
			streamCursor(model, context, {
				apiKey: "cursor-token",
				onToolResult: async () => {
					throw new Error("tool-result sink failed");
				},
			}).result(),
		);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("tool-result sink failed");
		expect(AIError.retriable(result.errorId)).toBe(true);
	});

	it("accepts a well-formed complete stream", async () => {
		const result = await runCursorFrames([textFrame("Hel"), textFrame("lo"), turnEndedFrame()]);

		expect(result.stopReason).toBe("stop");
		expect(result.content).toMatchObject([{ type: "text", text: "Hello" }]);
	});
});

describe("Cursor abort listener cleanup", () => {
	it("removes request and dispatch-drain listeners after completion", async () => {
		const caller = new AbortController();
		const signal = caller.signal;
		const originalAddEventListener = signal.addEventListener.bind(signal);
		const { promise: drainListenerAdded, resolve: resolveDrainListenerAdded } = Promise.withResolvers<void>();
		const addedAbortListeners: unknown[] = [];
		const addSpy = vi.spyOn(signal, "addEventListener").mockImplementation((type, listener, options) => {
			originalAddEventListener(type, listener, options);
			if (type === "abort") {
				addedAbortListeners.push(listener);
				if (addedAbortListeners.length >= 2) resolveDrainListenerAdded();
			}
		});
		const removeSpy = vi.spyOn(signal, "removeEventListener");
		const { promise: dispatchStarted, resolve: resolveDispatchStarted } = Promise.withResolvers<void>();
		const { promise: releaseDispatch, resolve: resolveDispatch } = Promise.withResolvers<void>();

		const resultPromise = withCursorResponse([readExecFrame(), turnEndedFrame()], model =>
			streamCursor(model, context, {
				apiKey: "cursor-token",
				signal,
				onToolResult: async toolResult => {
					resolveDispatchStarted();
					await releaseDispatch;
					return toolResult;
				},
			}).result(),
		);
		await dispatchStarted;
		await drainListenerAdded;
		resolveDispatch();
		const result = await resultPromise;

		expect(result.stopReason).toBe("stop");
		expect(addSpy).toHaveBeenCalled();
		expect(addedAbortListeners).toHaveLength(2);
		for (const listener of addedAbortListeners) {
			expect(
				removeSpy.mock.calls.some(([type, removedListener]) => type === "abort" && removedListener === listener),
			).toBe(true);
		}
	});
});
