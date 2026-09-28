import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { compareVersions, TempDir } from "@oh-my-pi/pi-utils";
import { streamSimple } from "../stream";
import type { AssistantMessageEvent, Context, ToolCall } from "../types";
import { streamAnthropic } from "./anthropic";

const image = {
	type: "image" as const,
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
};

const spec = {
	id: "claude-sonnet-4-6",
	name: "Claude",
	api: "anthropic-messages" as const,
	provider: "anthropic",
	reasoning: true,
	input: ["text", "image"] as ("text" | "image")[],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 8192,
};

interface RequestBody {
	model: string;
	messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
	tools: Array<{ name: string; input_schema: Record<string, unknown>; eager_input_streaming?: boolean }>;
	system: Array<{ text: string }>;
}

function response(blocks: Array<Record<string, unknown>>, reason: string, model = spec.id): Response {
	const events: Array<Record<string, unknown>> = [
		{
			type: "message_start",
			message: {
				id: "msg_sdk_test",
				type: "message",
				role: "assistant",
				model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
			},
		},
	];
	for (const [index, block] of blocks.entries()) {
		const content =
			block.type === "tool_use"
				? { ...block, input: {} }
				: block.type === "thinking"
					? { ...block, thinking: "", signature: "" }
					: { ...block, text: "" };
		events.push({ type: "content_block_start", index, content_block: content });
		if (block.type === "tool_use") {
			const json = JSON.stringify(block.input);
			for (const part of [json.slice(0, 7), json.slice(7)])
				events.push({
					type: "content_block_delta",
					index,
					delta: { type: "input_json_delta", partial_json: part },
				});
		} else if (block.type === "thinking") {
			events.push(
				{ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } },
				{ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } },
			);
		} else events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
		events.push({ type: "content_block_stop", index });
	}
	events.push(
		{
			type: "message_delta",
			delta: { stop_reason: reason, stop_sequence: null },
			usage: { output_tokens: 13, output_tokens_details: { thinking_tokens: 4 } },
		},
		{ type: "message_stop" },
	);
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

describe("Anthropic Claude Agent SDK backend", () => {
	test("Opus 5.5 reaches inference without an outdated-runtime rejection or model downgrade", async () => {
		await using cwd = await TempDir.create("@proto-sdk-opus-");
		const modelId = "claude-opus-5-5";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (!new URL(request.url).pathname.endsWith("/messages")) return Response.json({});
				const body = (await request.json()) as RequestBody;
				const version = request.headers.get("user-agent")?.match(/\bclaude-cli\/(\d+\.\d+\.\d+)/)?.[1];
				// Real Opus 5.5 inference rejected SDK 0.3.278 with this minimum-runtime contract.
				if (body.model !== modelId || !version || compareVersions(version, "2.1.280") < 0) {
					return Response.json(
						{
							type: "error",
							error: {
								type: "invalid_request_error",
								message: "Claude Opus 5.5 requires Claude Code 2.1.280 or newer",
							},
						},
						{ status: 400 },
					);
				}
				return response([{ type: "text", text: "Opus accepted" }], "end_turn", modelId);
			},
		});
		try {
			const result = await streamAnthropic(
				buildModel({ ...spec, id: modelId, baseUrl: server.url.origin }),
				{
					messages: [{ role: "user", content: "hello", timestamp: 1 }],
				},
				{ apiKey: "sdk-opus-fixture", cwd: cwd.path(), thinkingEnabled: false },
			).result();
			expect(result.errorMessage).toBeUndefined();
			expect(result.stopReason).toBe("stop");
			expect(result.upstreamModel).toBe(modelId);
			expect(result.content).toEqual([{ type: "text", text: "Opus accepted" }]);
		} finally {
			server.stop(true);
		}
	}, 30_000);

	test("streams host tool calls and replays their real results without executing native tools", async () => {
		await using cwd = await TempDir.create("@proto-sdk-test-");
		const requests: RequestBody[] = [];
		const authorizations: Array<string | null> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (!new URL(request.url).pathname.endsWith("/messages")) return Response.json({});
				const body = (await request.json()) as RequestBody;
				requests.push(body);
				authorizations.push(request.headers.get("x-api-key"));
				return requests.length === 1
					? response(
							[
								{ type: "thinking", thinking: "Use both tools", signature: "signed-reasoning" },
								{ type: "text", text: "Checking" },
								{
									type: "tool_use",
									id: "toolu_one",
									name: "mcp__proto__bash",
									input: { command: "printf hi", mode: "safe" },
								},
								{ type: "tool_use", id: "toolu_two", name: "mcp__proto__read", input: { path: "image.png" } },
							],
							"tool_use",
						)
					: response([{ type: "text", text: "Results received" }], "end_turn");
			},
		});
		try {
			const model = buildModel({ ...spec, baseUrl: server.url.origin });
			const context: Context = {
				systemPrompt: ["Test host context"],
				messages: [{ role: "user", content: [{ type: "text", text: "Check the files" }, image], timestamp: 1 }],
				tools: [
					{
						name: "bash",
						description: "Run a shell command",
						parameters: {
							type: "object",
							properties: { command: { type: "string" }, mode: { enum: ["safe", "fast"] } },
							required: ["command"],
							additionalProperties: false,
						},
					},
					{
						name: "read",
						description: "Read a file",
						parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					},
				],
			};
			const options = {
				apiKey: "sdk-test-key",
				cwd: cwd.path(),
				disableReasoning: true,
				streamFirstEventTimeoutMs: 20_000,
				onPayload: (payload: unknown) => ({
					...(payload as Record<string, unknown>),
					systemPrompt: ["Transformed host context"],
				}),
			};
			const first = streamSimple(model, context, options);
			const events: AssistantMessageEvent[] = [];
			for await (const event of first) events.push(event);
			const assistant = await first.result();
			expect(assistant.errorMessage).toBeUndefined();
			expect(assistant.stopReason).toBe("toolUse");
			const calls = assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
			expect(calls.map(call => [call.name, call.arguments])).toEqual([
				["bash", { command: "printf hi", mode: "safe" }],
				["read", { path: "image.png" }],
			]);
			expect(events.filter(event => event.type === "toolcall_delta")).toHaveLength(4);
			expect(assistant.content[0]).toEqual({
				type: "thinking",
				thinking: "Use both tools",
				thinkingSignature: "signed-reasoning",
			});
			expect(assistant.usage).toMatchObject({
				input: 11,
				output: 13,
				cacheRead: 7,
				cacheWrite: 3,
				totalTokens: 34,
				reasoningTokens: 4,
			});
			expect(requests).toHaveLength(1);
			expect(requests[0].tools.map(tool => tool.name)).toEqual(["mcp__proto__bash", "mcp__proto__read"]);
			expect(requests[0].tools[0].input_schema).toMatchObject({
				properties: { mode: { enum: ["safe", "fast"] } },
				additionalProperties: false,
			});
			expect(requests[0].system.some(block => block.text.includes("Transformed host context"))).toBe(true);
			context.messages.push(
				assistant,
				{
					role: "toolResult",
					toolCallId: calls[0].id,
					toolName: "bash",
					content: [{ type: "text", text: "hi" }],
					isError: false,
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: calls[1].id,
					toolName: "read",
					content: [{ type: "text", text: "partial image with error" }, image],
					isError: true,
					timestamp: 3,
				},
			);
			const second = await streamSimple(model, context, options).result();
			expect(second.errorMessage).toBeUndefined();
			expect(second.content).toEqual([{ type: "text", text: "Results received" }]);
			expect(requests).toHaveLength(2);
			const history = JSON.stringify(requests[1].messages);
			expect(history).toContain('"tool_use_id":"toolu_one"');
			expect(history).toContain('"tool_use_id":"toolu_two"');
			expect(history).toContain('"is_error":true');
			expect(history).toContain("signed-reasoning");
			expect(history).toContain('"type":"image"');
			expect(history).toContain('"media_type":"image/png"');
			const toolResult = requests[1].messages
				.flatMap(message => (typeof message.content === "string" ? [] : message.content))
				.find(block => block.type === "tool_result" && block.tool_use_id === "toolu_two");
			expect(toolResult?.content).toEqual([{ type: "text", text: "partial image with error" }]);
			// The SDK hoists tool-result images into the enclosing user message.
			expect(
				requests[1].messages
					.flatMap(message => (typeof message.content === "string" ? [] : message.content))
					.filter(block => block.type === "image"),
			).toHaveLength(2);
			expect(authorizations).toEqual(["sdk-test-key", "sdk-test-key"]);
		} finally {
			server.stop(true);
		}
	}, 30_000);

	test("OAuth uses bearer auth, toolChoice none hides tools, and token limits remain length stops", async () => {
		const authHeaders: Array<{ authorization: string | null; apiKey: string | null }> = [];
		let toolNames: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (!new URL(request.url).pathname.endsWith("/messages")) return Response.json({});
				authHeaders.push({
					authorization: request.headers.get("authorization"),
					apiKey: request.headers.get("x-api-key"),
				});
				const body = (await request.json()) as RequestBody;
				toolNames = (body.tools ?? []).map(tool => tool.name);
				return response([{ type: "text", text: "limited" }], "max_tokens");
			},
		});
		try {
			const result = await streamAnthropic(
				buildModel({ ...spec, baseUrl: server.url.origin }),
				{
					messages: [{ role: "user", content: "hello", timestamp: 1 }],
					tools: [{ name: "bash", description: "Run a command", parameters: { type: "object", properties: {} } }],
				},
				{ apiKey: "sk-ant-oat01-sdk-fixture", isOAuth: true, toolChoice: "none", thinkingEnabled: false },
			).result();
			expect(result.errorMessage).toBeUndefined();
			// The SDK may send its own length-stop continuation before Proto's interrupt lands; it must use the same auth.
			expect(authHeaders).not.toHaveLength(0);
			for (const headers of authHeaders)
				expect(headers).toEqual({ authorization: "Bearer sk-ant-oat01-sdk-fixture", apiKey: null });
			expect(toolNames).toEqual([]);
			expect(result.stopReason).toBe("length");
			expect(result.content).toEqual([{ type: "text", text: "limited" }]);
		} finally {
			server.stop(true);
		}
	}, 30_000);

	test("an SDK follow-up turn neither fails nor replaces the completed response", async () => {
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (!new URL(request.url).pathname.endsWith("/messages")) return Response.json({});
				requests++;
				// A thinking-only answer makes the SDK nudge the model with a second turn of its own.
				return requests === 1
					? response([{ type: "thinking", thinking: "Only thought", signature: "sig" }], "end_turn")
					: response([{ type: "text", text: "SDK follow-up" }], "end_turn");
			},
		});
		try {
			const result = await streamAnthropic(
				buildModel({ ...spec, baseUrl: server.url.origin }),
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{ apiKey: "sdk-follow-up-fixture", thinkingEnabled: false },
			).result();
			expect(result.errorMessage).toBeUndefined();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toEqual([{ type: "thinking", thinking: "Only thought", thinkingSignature: "sig" }]);
		} finally {
			server.stop(true);
		}
	}, 30_000);

	test("tool arguments stream eagerly only where the endpoint supports it", async () => {
		const eager: boolean[][] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (!new URL(request.url).pathname.endsWith("/messages")) return Response.json({});
				const body = (await request.json()) as RequestBody;
				eager.push(body.tools.map(tool => tool.eager_input_streaming === true));
				return response([{ type: "text", text: "ok" }], "end_turn");
			},
		});
		try {
			const gateway = buildModel({ ...spec, baseUrl: server.url.origin });
			// Same gateway declaring the eager-streaming support the official API has.
			const eagerGateway = { ...gateway, compat: { ...gateway.compat, supportsEagerToolInputStreaming: true } };
			const context: Context = {
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
				tools: [{ name: "bash", description: "Run a command", parameters: { type: "object", properties: {} } }],
			};
			for (const model of [gateway, eagerGateway]) {
				const result = await streamAnthropic(model, context, {
					apiKey: "sdk-eager-fixture",
					thinkingEnabled: false,
				}).result();
				expect(result.errorMessage).toBeUndefined();
			}
			expect(eager).toEqual([[false], [true]]);
		} finally {
			server.stop(true);
		}
	}, 30_000);

	test("authentication errors retain HTTP status for credential rotation", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				return new URL(request.url).pathname.endsWith("/messages")
					? Response.json(
							{ type: "error", error: { type: "authentication_error", message: "Invalid API key" } },
							{ status: 401 },
						)
					: Response.json({});
			},
		});
		try {
			const result = await streamAnthropic(
				buildModel({ ...spec, baseUrl: server.url.origin }),
				{
					messages: [{ role: "user", content: "hello", timestamp: 1 }],
				},
				{ apiKey: "invalid-test-key", thinkingEnabled: false },
			).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorStatus).toBe(401);
			expect(result.errorMessage).toMatch(/key|auth/i);
		} finally {
			server.stop(true);
		}
	}, 30_000);

	test("abort during streaming preserves partial output and stops the subprocess", async () => {
		const controller = new AbortController();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				return new URL(request.url).pathname.endsWith("/messages")
					? response([{ type: "text", text: "partial" }], "end_turn")
					: Response.json({});
			},
		});
		try {
			const result = await streamAnthropic(
				buildModel({ ...spec, baseUrl: server.url.origin }),
				{
					messages: [{ role: "user", content: "hello", timestamp: 1 }],
				},
				{
					apiKey: "test",
					thinkingEnabled: false,
					signal: controller.signal,
					onSseEvent: event => {
						if (event.event === "content_block_delta") controller.abort();
					},
				},
			).result();
			expect(result.stopReason).toBe("aborted");
			expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		} finally {
			server.stop(true);
		}
	}, 30_000);

	test("other Anthropic-compatible providers retain direct Messages transport", async () => {
		let requested = false;
		const result = await streamAnthropic(
			buildModel({ ...spec, provider: "custom-anthropic", baseUrl: "https://gateway.example" }),
			{
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			},
			{
				apiKey: "test",
				thinkingEnabled: false,
				fetch: Object.assign(
					async () => {
						requested = true;
						return response([{ type: "text", text: "gateway" }], "end_turn");
					},
					{ preconnect: fetch.preconnect },
				),
			},
		).result();
		expect(result.content).toMatchObject([{ type: "text", text: "gateway" }]);
		expect(requested).toBe(true);
	});

	test("caller abort before startup is reported as aborted without launching SDK", async () => {
		const result = await streamAnthropic(
			buildModel({ ...spec, baseUrl: "http://127.0.0.1:1" }),
			{
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			},
			{ apiKey: "test", signal: AbortSignal.abort() },
		).result();
		expect(result.stopReason).toBe("aborted");
	});

	test("unsupported forced tool choice fails explicitly instead of silently losing the constraint", async () => {
		const result = await streamAnthropic(
			buildModel({ ...spec, baseUrl: "http://127.0.0.1:1" }),
			{
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			},
			{ apiKey: "test", toolChoice: "any" },
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("forced tool choice");
	});
});
