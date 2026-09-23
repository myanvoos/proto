/**
 * Anthropic server-side compaction (`compact-2026-01-12`).
 *
 * Verifies the provider contract the agent's compaction backend relies on:
 *   • Request — `anthropicCompaction` emits the `compact_20260112` edit beside
 *     `clear_thinking`, clamps the trigger to the API floor, and attaches the
 *     beta; requests without the option (and endpoints without context
 *     management) stay untouched.
 *   • Response — the streamed `compaction` block becomes the assistant
 *     message's `anthropicCompaction` payload, the `compaction` stop reason is
 *     a normal stop tagged in `stopDetails`, usage is the sum over
 *     `usage.iterations`, and a `null` summary yields no payload.
 *   • Replay — a user-role summary carrying this provider's payload is sent as
 *     a leading assistant `compaction` block; other providers' payloads and
 *     endpoints without context management keep the text.
 *   • The empty-completion retry does not re-issue a compaction pause.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AnthropicMessageParam } from "@oh-my-pi/pi-ai/providers/anthropic";
import { convertAnthropicMessages, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { Context, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai/types";
import { type ConversationalUserCarrier, kConversationalUser } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function withOfficialAnthropicEndpoint(): void {
	let previous: string | undefined;
	beforeEach(() => {
		previous = Bun.env.ANTHROPIC_BASE_URL;
		delete Bun.env.ANTHROPIC_BASE_URL;
	});
	afterEach(() => {
		if (previous === undefined) delete Bun.env.ANTHROPIC_BASE_URL;
		else Bun.env.ANTHROPIC_BASE_URL = previous;
	});
}

const fableSpec: ModelSpec<"anthropic-messages"> = {
	id: "claude-fable-5",
	name: "Claude Fable 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};

const fableModel: Model<"anthropic-messages"> = buildModel(fableSpec);

const noContextManagementModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5 (proxy)",
	api: "anthropic-messages",
	provider: "custom-anthropic-proxy",
	baseUrl: "https://models.example.test",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
	compat: { supportsContextManagement: false },
} as ModelSpec<"anthropic-messages">);

const SUMMARY = "## Goal\nAudit the handlers.\n\n## Next Steps\n1. Continue with chunk 11.";

const context: Context = {
	messages: [{ role: "user", content: "Continue the audit.", timestamp: Date.now() }],
};

type MockAnthropicEvent = Record<string, unknown>;

function createMockRequest(events: MockAnthropicEvent[]) {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_mock" } });
	const stream = {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
	return {
		async withResponse() {
			return { data: stream, response, request_id: response.headers.get("request-id") };
		},
	};
}

const ENCRYPTED = "enc_opaque_compaction_state";

/**
 * The stream observed live on 2026-09-11 for a paused compaction request. The
 * block and its delta carry `encrypted_content` per the SDK contract
 * (`BetaCompactionBlock` / `BetaCompactionContentBlockDelta`); `iterations`
 * appends further sampling iterations after the compaction one.
 */
function createPausedCompactionEvents(
	content: string | null,
	iterations: Record<string, unknown>[] = [],
): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_compact",
				model: "claude-fable-5",
				usage: {
					input_tokens: 64,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 80_082,
				},
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "compaction", content: "", encrypted_content: null },
		},
		{ type: "ping" },
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "compaction_delta", content, encrypted_content: content === null ? null : ENCRYPTED },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "compaction" },
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				iterations: [
					{
						type: "compaction",
						input_tokens: 64,
						output_tokens: 2002,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 80_082,
					},
					...iterations,
				],
			},
		},
		{ type: "message_stop" },
	];
}

async function captureRequest(
	model: Model<"anthropic-messages">,
	options: Parameters<typeof streamAnthropic>[2],
	messages: Context["messages"] = context.messages,
): Promise<{ beta: string; payload: Record<string, unknown> }> {
	let beta = "";
	const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
		beta = new Headers(init?.headers).get("anthropic-beta") ?? "";
		return new Response(
			JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	await streamAnthropic(
		model,
		{ systemPrompt: ["auditor"], messages },
		{
			apiKey: "sk-ant-test",
			...options,
			fetch: fetchMock,
			onPayload: payload => resolve(payload as Record<string, unknown>),
		},
	).result();
	return { beta, payload: await promise };
}

function compactionSummaryMessage(provider: string, content = SUMMARY, encryptedContent?: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text: `Prior model work available.\n\n<summary>\n${content}\n</summary>` }],
		providerPayload: {
			type: "anthropicCompaction",
			provider,
			content,
			...(encryptedContent ? { encryptedContent } : {}),
		},
		timestamp: 1,
	};
}

withOfficialAnthropicEndpoint();

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic server-side compaction request", () => {
	it("emits the compact edit beside clear_thinking and attaches the compaction beta", async () => {
		const { beta, payload } = await captureRequest(fableModel, {
			thinkingEnabled: true,
			anthropicCompaction: { triggerInputTokens: 120_000, pauseAfterCompaction: true, instructions: "Summarize." },
		});

		expect(payload.context_management).toEqual({
			edits: [
				{ type: "clear_thinking_20251015", keep: "all" },
				{
					type: "compact_20260112",
					trigger: { type: "input_tokens", value: 120_000 },
					pause_after_compaction: true,
					instructions: "Summarize.",
				},
			],
		});
		expect(beta).toContain("compact-2026-01-12");
	});

	it("sends neither the edit nor the beta without the option", async () => {
		const { beta, payload } = await captureRequest(fableModel, { thinkingEnabled: false });

		expect(payload.context_management).toBeUndefined();
		expect(beta).not.toContain("compact-2026-01-12");
	});

	/**
	 * Runs one request on a caller-owned client (its `baseURL` is the endpoint
	 * the SDK would target) and returns the params and per-request headers.
	 */
	async function captureOnClient(
		model: Model<"anthropic-messages">,
		baseURL: string | undefined,
		options: Parameters<typeof streamAnthropic>[2],
		messages = context.messages,
	) {
		let params: Record<string, unknown> | undefined;
		let headers: Record<string, string> | undefined;
		await streamAnthropic(
			model,
			{ systemPrompt: ["auditor"], messages },
			{
				apiKey: "sk-ant-test",
				...options,
				client: {
					...(baseURL === undefined ? {} : { baseURL }),
					messages: {
						create: (requestParams, requestOptions) => {
							params = requestParams as unknown as Record<string, unknown>;
							headers = (requestOptions as { headers?: Record<string, string> } | undefined)?.headers;
							throw new Error("stop-after-capture");
						},
					},
				},
			},
		)
			.result()
			.catch(() => undefined);
		return { params, beta: headers?.["anthropic-beta"] ?? "" };
	}

	it("attaches the compaction beta per request for injected clients, on compaction and on replay", async () => {
		// Injected SDK clients own their default headers, so the beta rides the
		// per-request headers exactly like the effort and control betas do.
		const capture = (options: Parameters<typeof streamAnthropic>[2], messages = context.messages) =>
			captureOnClient(fableModel, "https://api.anthropic.com", options, messages);

		const live = await capture({ anthropicCompaction: { triggerInputTokens: 50_000, pauseAfterCompaction: true } });
		expect(live.params?.context_management).toEqual({
			edits: [
				{
					type: "compact_20260112",
					trigger: { type: "input_tokens", value: 50_000 },
					pause_after_compaction: true,
				},
			],
		});
		expect(live.beta).toContain("compact-2026-01-12");

		const replay = await capture({}, [
			compactionSummaryMessage("anthropic"),
			{ role: "user", content: "next", timestamp: 2 },
		]);
		expect(replay.params?.context_management).toEqual({
			edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 1_000_000 } }],
		});
		expect(replay.beta).toContain("compact-2026-01-12");

		const plain = await capture({});
		expect(plain.params?.context_management).toBeUndefined();
		expect(plain.beta).not.toContain("compact-2026-01-12");
	});
});

describe("anthropic server-side compaction response", () => {
	it("surfaces the summary as the assistant payload with a tagged stop and iteration-summed usage", async () => {
		const create = vi
			.spyOn(AnthropicMessages.prototype, "create")
			.mockImplementation(() => createMockRequest(createPausedCompactionEvents(SUMMARY)) as never);

		const s = streamAnthropic(fableModel, context, {
			apiKey: "sk-ant-test",
			anthropicCompaction: { triggerInputTokens: 50_000, pauseAfterCompaction: true },
		});
		for await (const _ of s) {
			// drain
		}
		const result = await s.result();

		expect(result.providerPayload).toEqual({
			type: "anthropicCompaction",
			provider: "anthropic",
			content: SUMMARY,
			encryptedContent: ENCRYPTED,
		});
		expect(result.content).toEqual([]);
		expect(result.stopReason).toBe("stop");
		expect(result.stopDetails).toEqual({ type: "compaction" });
		expect(result.errorMessage).toBeUndefined();
		// The top-level counts exclude the compaction iteration; the iteration
		// list is the billed total (64 input, 2002 output, 80,082 cache write).
		expect(result.usage.input).toBe(64);
		expect(result.usage.output).toBe(2002);
		expect(result.usage.cacheWrite).toBe(80_082);
		expect(result.usage.cacheRead).toBe(0);
		expect(result.usage.totalTokens).toBe(64 + 2002 + 80_082);
		expect(result.usage.contextTokens).toBeUndefined();
		expect(result.usage.cost.output).toBeCloseTo((2002 * 50) / 1_000_000, 10);
		expect(result.usage.cost.cacheWrite).toBeCloseTo((80_082 * 12.5) / 1_000_000, 10);
		// A compaction pause is a legitimate empty stop: no empty-completion retry.
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("yields no payload when the model called a tool instead of summarizing", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(createPausedCompactionEvents(null)) as never,
		);

		const s = streamAnthropic(fableModel, context, {
			apiKey: "sk-ant-test",
			anthropicCompaction: { triggerInputTokens: 50_000, pauseAfterCompaction: true },
		});
		for await (const _ of s) {
			// drain
		}
		const result = await s.result();

		expect(result.providerPayload).toBeUndefined();
		expect(result.stopDetails).toEqual({ type: "compaction" });
		expect(result.errorMessage).toBeUndefined();
	});
});

describe("anthropic server-side compaction replay", () => {
	it("replays this provider's summary as a leading assistant compaction block", () => {
		const params = convertAnthropicMessages(
			[compactionSummaryMessage("anthropic"), { role: "user", content: "next", timestamp: 2 }],
			fableModel,
			false,
			{ replayCompaction: true },
		);

		expect(params).toEqual([
			{ role: "assistant", content: [{ type: "compaction", content: SUMMARY }] },
			{ role: "user", content: "next", [kConversationalUser]: true } as AnthropicMessageParam &
				ConversationalUserCarrier,
		]);
	});

	it("replays harness file metadata after the native block, not inside it", () => {
		const filesText = "<files>\n# /repo/src/\nhandlers.ts (Read)\n</files>";
		const summary: UserMessage = {
			...compactionSummaryMessage("anthropic", SUMMARY, ENCRYPTED),
			providerPayload: {
				type: "anthropicCompaction",
				provider: "anthropic",
				content: SUMMARY,
				encryptedContent: ENCRYPTED,
				filesText,
			},
		};
		const params = convertAnthropicMessages(
			[summary, { role: "user", content: "next", timestamp: 2 }],
			fableModel,
			false,
			{ replayCompaction: true },
		);

		expect(params).toEqual([
			{ role: "assistant", content: [{ type: "compaction", content: SUMMARY, encrypted_content: ENCRYPTED }] },
			{ role: "user", content: filesText },
			{ role: "user", content: "next", [kConversationalUser]: true } as AnthropicMessageParam &
				ConversationalUserCarrier,
		]);
	});

	it("attaches the compaction beta when the context replays a summary, and keeps the text elsewhere", async () => {
		const official = await captureRequest(fableModel, { thinkingEnabled: false }, [
			compactionSummaryMessage("anthropic"),
			{ role: "user", content: "next", timestamp: 2 },
		]);
		expect(official.beta).toContain("compact-2026-01-12");
		// The API rejects a replayed block without a strategy; the replay edit's
		// trigger sits at the context window so the live turn never compacts.
		expect(official.payload.context_management).toEqual({
			edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 1_000_000 } }],
		});
		// Both tail breakpoints land here: the API accepts cache_control on a
		// compaction block, so a short post-compaction tail caches the summary.
		expect(official.payload.messages).toEqual([
			{
				role: "assistant",
				content: [{ type: "compaction", content: SUMMARY, cache_control: { type: "ephemeral" } }],
			},
			{
				role: "user",
				content: [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }],
				[kConversationalUser]: true,
			} as AnthropicMessageParam & ConversationalUserCarrier,
		]);

		const proxy = await captureRequest(noContextManagementModel, { thinkingEnabled: false }, [
			compactionSummaryMessage("custom-anthropic-proxy"),
			{ role: "user", content: "next", timestamp: 2 },
		]);
		expect(proxy.beta).not.toContain("compact-2026-01-12");
		expect(JSON.stringify(proxy.payload.messages)).not.toContain('"compaction"');
		expect(JSON.stringify(proxy.payload.messages)).toContain("<summary>");
	});
});
