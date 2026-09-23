import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Context, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

function makeAnthropicModel(id: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

const CONTEXT: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "weather in paris?", timestamp: Date.now() }],
};

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-fable-5-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

type CapturedPayload = {
	thinking?: {
		type: string;
		block_binding?: { prefix_mismatch_behavior: "drop_block" | "error" };
	};
	tool_choice?: { type: string };
	output_config?: { effort?: string };
	system?: Array<{ cache_control?: { type: "ephemeral"; ttl?: "1h" | "5m" } }>;
	messages?: Array<{
		role: string;
		clear_at?: "next_user_message";
		content:
			| string
			| Array<{
					type?: string;
					cache_control?: { type: "ephemeral"; ttl?: "1h" | "5m" };
					tool?: { type: string; name: string };
			  }>;
		output_config?: { effort?: string };
	}>;
	tools?: Array<{ name: string; description?: string; defer_loading?: boolean }>;
	anthropic_beta?: string[];
};

function capturePayload(
	model: Model<"anthropic-messages">,
	opts: Parameters<typeof streamAnthropic>[2],
	context: Context = CONTEXT,
): Promise<CapturedPayload> {
	const { promise, resolve } = Promise.withResolvers<CapturedPayload>();
	streamAnthropic(model, context, {
		apiKey: "sk-ant-oat-test",
		isOAuth: true,
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as CapturedPayload),
		...opts,
	});
	return promise;
}

describe("Anthropic preserved-thinking request shaping", () => {
	it("opts Fable 5.1 into dropping prefix-mismatched thinking", async () => {
		const payload = await capturePayload(makeAnthropicModel("claude-fable-5-1"), {
			thinkingEnabled: true,
			reasoning: Effort.High,
		});

		expect(payload.thinking?.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
	});

	it("allows callers to make prefix mismatches fail loudly", async () => {
		const payload = await capturePayload(makeAnthropicModel("claude-fable-5-1"), {
			thinkingEnabled: true,
			reasoning: Effort.High,
			anthropicPrefixMismatchBehavior: "error",
		});

		expect(payload.thinking?.block_binding).toEqual({ prefix_mismatch_behavior: "error" });
	});

	it("keeps declared tools stable and appends a removal control", async () => {
		const model = makeAnthropicModel("claude-fable-5-1");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			...CONTEXT,
			tools: [
				{
					name: "read",
					description: "Read a file.",
					parameters: { type: "object", properties: {} },
				},
			],
		};
		await capturePayload(
			model,
			{ thinkingEnabled: true, reasoning: Effort.High, providerSessionState },
			firstContext,
		);
		const payload = await capturePayload(
			model,
			{ thinkingEnabled: true, reasoning: Effort.High, providerSessionState },
			{
				...CONTEXT,
				messages: [...CONTEXT.messages, { role: "user", content: "continue", timestamp: Date.now() }],
				tools: [],
			},
		);

		const wireToolName = payload.tools?.[0]?.name;
		if (!wireToolName) throw new Error("expected stable declared tool");
		const lastContent = payload.messages?.at(-1)?.content;
		if (!Array.isArray(lastContent)) throw new Error("expected system control blocks");
		expect(lastContent).toContainEqual({
			type: "tool_removal",
			tool: { type: "tool_reference", name: wireToolName },
		});
	});

	it("re-baselines tools when the history under a control is rewritten", async () => {
		const model = makeAnthropicModel("claude-fable-5-1");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const readTool = { name: "read", description: "Read a file.", parameters: { type: "object", properties: {} } };
		await capturePayload(
			model,
			{ thinkingEnabled: true, reasoning: Effort.High, providerSessionState },
			{ ...CONTEXT, tools: [readTool] },
		);
		await capturePayload(
			model,
			{ thinkingEnabled: true, reasoning: Effort.High, providerSessionState },
			{
				...CONTEXT,
				messages: [...CONTEXT.messages, { role: "user", content: "continue", timestamp: Date.now() }],
				tools: [],
			},
		);
		// Same length, different first turn: a compaction-style rewrite under the recorded control.
		const payload = await capturePayload(
			model,
			{ thinkingEnabled: true, reasoning: Effort.High, providerSessionState },
			{
				...CONTEXT,
				messages: [
					{ role: "user", content: "summary of the session so far", timestamp: Date.now() },
					{ role: "user", content: "continue", timestamp: Date.now() },
				],
				tools: [],
			},
		);

		expect(payload.tools ?? []).toHaveLength(0);
		expect(payload.messages?.some(message => message.role === "system")).toBe(false);
	});

	it("isolates side-request controls from the main conversation", async () => {
		const model = makeAnthropicModel("claude-fable-5-1");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const readTool = { name: "read", description: "Read a file.", parameters: { type: "object", properties: {} } };
		const grepTool = { name: "grep", description: "Search files.", parameters: { type: "object", properties: {} } };
		const firstTurn: Context["messages"] = [
			{ role: "user", content: "start", timestamp: 1 },
			assistant("ready", 2),
			{ role: "user", content: "continue", timestamp: 3 },
		];
		await capturePayload(
			model,
			{ thinkingEnabled: true, providerSessionState, sessionId: "main" },
			{ systemPrompt: ["Main prompt."], messages: firstTurn, tools: [readTool] },
		);
		await capturePayload(
			model,
			{ thinkingEnabled: true, providerSessionState, sessionId: "main" },
			{ systemPrompt: ["Main prompt."], messages: firstTurn, tools: [readTool, grepTool] },
		);
		await capturePayload(
			model,
			{ thinkingEnabled: true, providerSessionState, sessionId: "main:side:1" },
			{
				systemPrompt: ["Summarize this."],
				messages: [{ role: "user", content: "summary", timestamp: 4 }],
				tools: [],
			},
		);
		const payload = await capturePayload(
			model,
			{ thinkingEnabled: true, providerSessionState, sessionId: "main" },
			{
				systemPrompt: ["Main prompt."],
				messages: [...firstTurn, assistant("done", 4), { role: "user", content: "again", timestamp: 5 }],
				tools: [readTool, grepTool],
			},
		);

		expect(payload.tools?.[1]?.defer_loading).toBe(true);
		const grepWireName = payload.tools?.[1]?.name;
		expect(grepWireName).toBeDefined();
		expect(
			payload.messages?.some(
				message =>
					Array.isArray(message.content) &&
					message.content.some(block => block.type === "tool_addition" && block.tool?.name === grepWireName),
			),
		).toBe(true);
	});

	it("changes effort through a system message placed before the latest user turn", async () => {
		const model = makeAnthropicModel("claude-fable-5-1");
		const providerSessionState = new Map<string, ProviderSessionState>();
		await capturePayload(model, {
			thinkingEnabled: true,
			reasoning: Effort.High,
			providerSessionState,
		});
		const payload = await capturePayload(
			model,
			{ thinkingEnabled: true, reasoning: Effort.Low, providerSessionState },
			{
				...CONTEXT,
				messages: [...CONTEXT.messages, { role: "user", content: "continue", timestamp: Date.now() }],
			},
		);

		expect(payload.output_config?.effort).toBe("high");
		// Per-message effort applies from the next user turn, so the control must
		// precede the turn being answered rather than trail it.
		expect(payload.messages?.at(-2)?.role).toBe("system");
		expect(payload.messages?.at(-2)?.output_config?.effort).toBe("low");
		expect(payload.messages?.at(-1)?.role).toBe("user");
	});

	it("sends an explicit effort as a control when the session started on the API default", async () => {
		// Omitted effort is the API default (`medium` on Opus 5.5), not `high`:
		// a later explicit `high` must still reach the wire.
		const model = makeAnthropicModel("claude-opus-5-5");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const first = await capturePayload(model, { thinkingEnabled: true, providerSessionState });
		const payload = await capturePayload(
			model,
			{ thinkingEnabled: true, reasoning: Effort.High, providerSessionState },
			{
				...CONTEXT,
				messages: [...CONTEXT.messages, { role: "user", content: "continue", timestamp: Date.now() }],
			},
		);

		expect(first.output_config?.effort).toBeUndefined();
		expect(payload.output_config?.effort).toBeUndefined();
		expect(payload.messages?.at(-2)?.role).toBe("system");
		expect(payload.messages?.at(-2)?.output_config?.effort).toBe("high");
		expect(payload.messages?.at(-1)?.role).toBe("user");
	});
});
