import { expect, spyOn, test } from "bun:test";
import type { Api, AssistantMessage, Model, Tool, ToolCall } from "../types";
import { sanitizeOpenAIResponsesHistoryItemsForReplay } from "../utils";
import { createAbortSourceTracker, raceWithSignal } from "./abort";
import { AssistantMessageEventStream } from "./event-stream";
import { applyGlyphCodec } from "./glyph-codec";
import { finalizeErrorMessage, redactHeaders } from "./http-inspector";
import { iterateWithTerminalGrace } from "./idle-iterator";
import { dereferenceJsonSchema } from "./schema/dereference";
import { upgradeJsonSchemaTo202012 } from "./schema/draft";
import { validateJsonSchemaValue } from "./schema/json-schema-validator";
import { normalizeSchemaForGoogle, sanitizeSchemaForOpenAIResponses } from "./schema/normalize";
import { guardThinkingLoopStream } from "./thinking-loop";
import { parseToolCallArguments, replayableToolCallArguments } from "./tool-call-arguments";
import { validateToolArguments } from "./validation";

function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "test",
		model: "test",
		content,
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function toolCall(arguments_: ToolCall["arguments"]): ToolCall {
	return { type: "toolCall", id: "call", name: "edit", arguments: arguments_ };
}

test("ambiguous mislabeled string arguments fail instead of choosing by JSON key order", () => {
	const tool: Tool = {
		name: "edit",
		description: "",
		parameters: {
			type: "object",
			properties: { patch: { type: "string" } },
			required: ["patch"],
			additionalProperties: false,
		},
	};
	expect(validateToolArguments(tool, toolCall({ input: "apply this" }))).toEqual({ patch: "apply this" });
	for (const args of [
		{ input: "first", text: "second" },
		{ text: "second", input: "first" },
	]) {
		expect(() => validateToolArguments(tool, toolCall(args))).toThrow();
	}
});

test("optional JSON payload literal null survives argument normalization", () => {
	const tool: Tool = {
		name: "edit",
		description: "",
		parameters: {
			type: "object",
			properties: { payload: { type: "string" }, optional: { type: "string" } },
		},
	};
	expect(validateToolArguments(tool, toolCall({ payload: "null", optional: "null" }))).toEqual({ payload: "null" });
});

test("repaired scalar arguments persist as valid replay JSON without a sentinel lookup crash", () => {
	const raw = "'a'";
	const executed = parseToolCallArguments(raw);
	expect(JSON.parse(replayableToolCallArguments(raw, executed))).toBe("a");
});

test("frozen malformed Responses calls retain their paired output using bounded diagnostic arguments", () => {
	const raw = `{"path":"${"x".repeat(700)}`;
	const call = Object.freeze({
		type: "function_call",
		name: "edit",
		call_id: "call",
		arguments: raw,
		internal_chat_message_metadata_passthrough: { secret: true },
	});
	const output = { type: "function_call_output", call_id: "call", output: "validation failed" };
	const replay = sanitizeOpenAIResponsesHistoryItemsForReplay([call, output]);
	expect(replay).toHaveLength(2);
	const replayCall = replay[0] as { arguments: string; internal_chat_message_metadata_passthrough?: unknown };
	const diagnostic = JSON.parse(replayCall.arguments);
	expect(diagnostic.__parseError).toBeString();
	expect(diagnostic.__rawJson).toContain("[truncated");
	expect(diagnostic.__rawJson.length).toBeLessThan(600);
	expect(replayCall.internal_chat_message_metadata_passthrough).toBeUndefined();
	expect(call.arguments).toBe(raw);
});

test("schema references decode URI fragments while literal defaults remain opaque", () => {
	const literal = { $ref: "#/$defs/a~1b", $defs: { untouched: 1 } };
	const schema = {
		type: "object",
		properties: { value: { $ref: "#%2F$defs%2Fa~1b" } },
		default: literal,
		enum: [literal],
		$defs: { "a/b": { type: "string" } },
	};
	expect(dereferenceJsonSchema(schema)).toEqual({
		type: "object",
		properties: { value: { type: "string" } },
		default: literal,
		enum: [literal],
	});
	const validatorSchema = { $ref: "#%2F$defs%2Fa~1b", $defs: { "a/b": { type: "string" } } };
	expect(validateJsonSchemaValue(validatorSchema, 7).success).toBe(false);
	expect(validateJsonSchemaValue(validatorSchema, "valid").success).toBe(true);
	expect(
		upgradeJsonSchemaTo202012({ $ref: "#%2Fdefinitions%2Fa~1b", definitions: { "a/b": { type: "string" } } }),
	).toMatchObject({ $ref: "#/$defs/a~1b" });
});

test("Google type unions separate incompatible type keywords and strip unsupported constraints", () => {
	const result = normalizeSchemaForGoogle({
		type: ["string", "array"],
		items: { type: "number" },
		uniqueItems: true,
		$id: "urn:test",
		contentEncoding: "base64",
	});
	expect(result).toMatchObject({ anyOf: [{ type: "string" }, { type: "array", items: { type: "number" } }] });
	expect(JSON.stringify(result)).not.toContain('"uniqueItems":');
});

test("Codex array repair preserves open tuple tails and does not touch ordinary grammar routes", () => {
	const schema = { type: "array", prefixItems: [{ type: "string" }], items: undefined };
	expect(sanitizeSchemaForOpenAIResponses(schema, { repairArrayItems: true })).toEqual({
		type: "array",
		prefixItems: [{ type: "string" }],
		items: true,
	});
	expect(sanitizeSchemaForOpenAIResponses(schema).items).toBeUndefined();
	const constrained = { allOf: [{ type: "array" }], unevaluatedItems: false };
	expect(sanitizeSchemaForOpenAIResponses(constrained, { repairArrayItems: true })).toEqual(constrained);
});

test("Codex repairs preserve own __proto__ properties and ignore literal unevaluatedItems keys", () => {
	const schema = JSON.parse(
		'{"type":"object","properties":{"__proto__":{"type":"array"}},"default":{"unevaluatedItems":false}}',
	);
	const result = sanitizeSchemaForOpenAIResponses(schema, { repairArrayItems: true });
	expect(result.properties).toEqual(JSON.parse('{"__proto__":{"type":"array","items":true}}'));
	expect(result.default).toEqual({ unevaluatedItems: false });
});

test("provider error bodies appear once with the full body, metadata and retry hint", async () => {
	const core = "request rejected: ".repeat(500);
	const bodyJson = { error: { message: core, type: "invalid_request_error" } };
	const result = await finalizeErrorMessage(new Error(`400 ${core.slice(0, 4096)}`), undefined, {
		status: 400,
		bodyText: JSON.stringify(bodyJson),
		bodyJson,
		headers: new Headers({ "retry-after": "2" }),
	});
	expect(result).toBe(`400 ${core} (type=invalid_request_error) retry-after-ms=2000`);
	expect(redactHeaders({ "X-Credential": "secret", "X-Trace": "trace" })).toEqual({
		"X-Credential": "[redacted]",
		"X-Trace": "trace",
	});
});

test("glyph token fragments decode in streamed deltas and partial snapshots", async () => {
	const inner = new AssistantMessageEventStream();
	const codec = applyGlyphCodec({ systemPrompt: ["icon \ue000"], messages: [] });
	const wrapped = codec.wrap(inner);
	const chunks = ["before ⟦Ue", "000⟧ after"];
	let source = "";
	for (const delta of chunks) {
		source += delta;
		inner.push({ type: "text_delta", contentIndex: 0, delta, partial: message([{ type: "text", text: source }]) });
	}
	inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: source }]) });
	const deltas: string[] = [];
	const snapshots: string[] = [];
	for await (const event of wrapped) {
		if (event.type !== "text_delta") continue;
		deltas.push(event.delta);
		const block = event.partial.content[0];
		if (block?.type === "text") snapshots.push(block.text);
	}
	expect(deltas.join("")).toBe("before \ue000 after");
	expect(snapshots).toEqual(["before ", "before \ue000 after"]);
});

test("terminal grace drains trailing events before a capped consumer releases its permit", async () => {
	const pending = Promise.withResolvers<IteratorResult<string>>();
	let closed = false;
	let calls = 0;
	const source: AsyncIterable<string> = {
		[Symbol.asyncIterator]: () => ({
			next: async () => (++calls === 1 ? { done: false, value: "terminal" } : pending.promise),
			return: async () => {
				closed = true;
				return { done: true, value: undefined };
			},
		}),
	};
	const iterator = iterateWithTerminalGrace(source, {
		finishedAtMs: () => Date.now(),
		graceMs: 1000,
		awaitDrainOnReturn: true,
	});
	await iterator.next();
	const returning = iterator.return(undefined);
	await Promise.resolve();
	expect(closed).toBe(false);
	pending.resolve({ done: true, value: undefined });
	await returning;
	expect(closed).toBe(true);
});

test("caller abort reason overrides a watchdog even when the watchdog won the merged signal race", async () => {
	const caller = new AbortController();
	const tracker = createAbortSourceTracker(caller.signal);
	tracker.abortLocally(new Error("watchdog"));
	caller.abort("user interrupt");
	expect(tracker.getCallerAbortReason()).toBe("user interrupt");
	expect(tracker.getLocalAbortReason()).toBeUndefined();
	const work = Promise.withResolvers<void>();
	const result = raceWithSignal(work.promise, caller.signal);
	work.reject(new Error("later shared refresh failure"));
	await expect(result).rejects.toBe("user interrupt");
});

test("loop aborts retain usage and time from the current attempt when a provider resets its snapshot in place", async () => {
	const clock = spyOn(Date, "now").mockReturnValue(1100);
	try {
		const inner = new AssistantMessageEventStream();
		const output = message([{ type: "thinking", thinking: "initial" }]);
		output.timestamp = 1000;
		const model = { id: "test", api: "openai-responses", provider: "test" } as Model<Api>;
		const controller = new AbortController();
		const guarded = guardThinkingLoopStream(inner, model, controller);
		const events = guarded[Symbol.asyncIterator]();
		inner.push({ type: "start", partial: output });
		await events.next();
		inner.push({ type: "thinking_delta", contentIndex: 0, delta: "initial", partial: output });
		await events.next();
		output.timestamp = 2000;
		output.responseId = "retried-response";
		output.usage = { ...output.usage, output: 40, totalTokens: 40 };
		clock.mockReturnValue(2050);
		inner.push({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "repeat this clause. ".repeat(200),
			partial: output,
		});
		const terminal = await events.next();
		if (terminal.done || terminal.value.type !== "error") throw new Error("expected loop abort");
		const error = terminal.value.error;
		output.usage.output = 999;
		expect(error).toMatchObject({
			content: [],
			timestamp: 2000,
			duration: 50,
			ttft: 50,
			responseId: "retried-response",
			usage: { output: 40, totalTokens: 40 },
		});
		expect(controller.signal.aborted).toBe(true);
	} finally {
		clock.mockRestore();
	}
});
