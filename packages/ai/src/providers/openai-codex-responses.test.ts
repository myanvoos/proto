import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import * as piUtils from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { Context, FetchImpl, Model, ProviderSessionState } from "../types";
import { formatErrorMessageWithRetryAfter } from "../utils/retry-after";
import { parseCodexError } from "./openai-codex/response-handler";
import {
	buildTransformedCodexRequestBody,
	createCodexProviderStreamError,
	getOpenAICodexTransportDetails,
	openCodexCompactionEventStream,
	streamOpenAICodexResponses,
} from "./openai-codex-responses";

const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

type WsHeaders = Record<string, string>;
type WsOptions = { headers?: WsHeaders; proxy?: string };
type CodexTestUsage = {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	input_tokens_details: { cached_tokens: number };
};

const DEFAULT_USAGE: CodexTestUsage = {
	input_tokens: 5,
	output_tokens: 3,
	total_tokens: 8,
	input_tokens_details: { cached_tokens: 0 },
};

class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readonly url: string;
	readonly options?: WsOptions;
	readyState = MockWebSocket.CONNECTING;
	binaryType: "blob" | "arraybuffer" | "nodebuffer" = "blob";
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;

	constructor(url: string, options?: WsOptions) {
		this.url = url;
		this.options = options;
	}

	send(_data: string): void {}

	close(): void {
		this.readyState = MockWebSocket.CLOSED;
	}

	scheduleOpen(): void {
		queueMicrotask(() => {
			this.readyState = MockWebSocket.OPEN;
			this.onopen?.(new Event("open"));
		});
	}

	sendJson(payload: Record<string, unknown>): void {
		this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
	}

	emitCodexResponse(options: {
		messageId: string;
		responseId: string;
		text: string;
		terminalType?: "response.done" | "response.completed";
		includeCreated?: boolean;
		usage?: CodexTestUsage;
	}): void {
		const {
			messageId,
			responseId,
			text,
			terminalType = "response.done",
			includeCreated = false,
			usage = DEFAULT_USAGE,
		} = options;
		if (includeCreated) {
			this.sendJson({ type: "response.created", response: { id: responseId } });
		}
		this.sendJson({
			type: "response.output_item.added",
			item: { type: "message", id: messageId, role: "assistant", status: "in_progress", content: [] },
		});
		this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
		this.sendJson({ type: "response.output_text.delta", delta: text });
		this.sendJson({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: messageId,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		});
		this.sendJson({
			type: terminalType,
			response: { id: responseId, status: "completed", usage },
		});
	}
}

function installMockWebSocket(create: (url: string, options?: WsOptions) => MockWebSocket): void {
	const nativeWebSocket = globalThis.WebSocket;
	const webSocketGlobal = globalThis as unknown as {
		WebSocket: (url: string | URL, protocols?: string | string[]) => WebSocket;
	};
	const mockConstructor = vi
		.spyOn(webSocketGlobal, "WebSocket")
		.mockImplementation((url: string | URL, protocols?: string | string[]): WebSocket => {
			return create(String(url), protocols as unknown as WsOptions) as unknown as WebSocket;
		});
	Object.defineProperties(mockConstructor, {
		CONNECTING: { value: nativeWebSocket.CONNECTING, configurable: true },
		OPEN: { value: nativeWebSocket.OPEN, configurable: true },
		CLOSING: { value: nativeWebSocket.CLOSING, configurable: true },
		CLOSED: { value: nativeWebSocket.CLOSED, configurable: true },
	});
}

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function createCodexTestModel(): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 128_000,
	});
}

function closeProviderSessionState(providerSessionState: Map<string, ProviderSessionState>): void {
	for (const state of providerSessionState.values()) state.close();
}

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Codex WebSocket abort handling", () => {
	it.each(["during handshake", "before request", "during request"] as const)(
		"preserves a timeout cause when stale socket close throws %s",
		async phase => {
			const controller = new AbortController();
			const timeoutCause = new DOMException("The operation timed out.", "TimeoutError");
			const providerSessionState = new Map<string, ProviderSessionState>();
			const fetchMock = vi.fn<FetchImpl>(() => {
				throw new Error("Aborted compaction must not fall back to SSE");
			});
			let closeCalls = 0;

			class ThrowingCloseWebSocket extends MockWebSocket {
				constructor(url: string, options?: WsOptions) {
					super(url, options);
					if (phase !== "during handshake") this.scheduleOpen();
				}

				override send(): void {
					controller.abort(timeoutCause);
				}

				override close(): void {
					closeCalls += 1;
					throw Object.assign(new Error("Socket is closed"), { code: "ERR_SOCKET_CLOSED" });
				}
			}

			installMockWebSocket((url, options) => new ThrowingCloseWebSocket(url, options));
			if (phase === "during handshake") controller.abort(timeoutCause);

			try {
				const error = await (async () => {
					const events = await openCodexCompactionEventStream(
						createCodexTestModel(),
						{ model: "gpt-5.3-codex-spark", input: [{ type: "compaction_trigger" }] },
						{
							apiKey: createCodexTestToken(),
							signal: controller.signal,
							fetch: fetchMock,
							sessionId: `compaction-timeout-${phase}`,
							providerSessionState,
						},
					);
					if (phase === "before request") controller.abort(timeoutCause);
					return events.next();
				})().then(
					() => {
						throw new Error("Compaction must reject when its deadline expires");
					},
					(error: unknown) => error,
				);

				expect(AIError.is(AIError.classify(error), AIError.Flag.Timeout)).toBe(true);
				expect(fetchMock).not.toHaveBeenCalled();
			} finally {
				expect(() => closeProviderSessionState(providerSessionState)).not.toThrow();
			}
			expect(closeCalls).toBeGreaterThan(0);
		},
	);

	it("keeps caller cancellation distinct when stale socket close throws", async () => {
		const controller = new AbortController();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const fetchMock = vi.fn<FetchImpl>(() => {
			throw new Error("Cancelled compaction must not fall back to SSE");
		});

		class CancelledWebSocket extends MockWebSocket {
			constructor(url: string, options?: WsOptions) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(): void {
				controller.abort();
			}

			override close(): void {
				throw Object.assign(new Error("Socket is closed"), { code: "ERR_SOCKET_CLOSED" });
			}
		}

		installMockWebSocket((url, options) => new CancelledWebSocket(url, options));
		try {
			const events = await openCodexCompactionEventStream(
				createCodexTestModel(),
				{ model: "gpt-5.3-codex-spark", input: [{ type: "compaction_trigger" }] },
				{
					apiKey: createCodexTestToken(),
					signal: controller.signal,
					fetch: fetchMock,
					sessionId: "compaction-caller-cancel",
					providerSessionState,
				},
			);
			const error = await events.next().then(
				() => {
					throw new Error("Compaction must reject when cancelled");
				},
				(error: unknown) => error,
			);

			expect(error).toBeInstanceOf(Error);
			expect(AIError.is(AIError.classify(error), AIError.Flag.Timeout)).toBe(false);
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			expect(() => closeProviderSessionState(providerSessionState)).not.toThrow();
		}
	});
});

describe("Codex WebSocket append state", () => {
	it.each([
		["rate_limit_exceeded", false],
		["slow_down", true],
	] as const)("preserves a completed continuation after %s", async (code, emitPartialResponse) => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("WebSocket continuation must not fall back to SSE");
		});

		class RateLimitedContinuationWebSocket extends MockWebSocket {
			constructor(url: string, options?: WsOptions) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				const requestIndex = sentRequests.length;

				if (requestIndex === 1) {
					this.emitCodexResponse({
						messageId: "msg_1",
						responseId: "resp_1",
						text: "First answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				if (requestIndex === 2) {
					expect(request.previous_response_id).toBe("resp_1");
					if (emitPartialResponse) {
						this.sendJson({ type: "response.created", response: { id: "resp_rejected" } });
						this.sendJson({
							type: "response.output_item.added",
							item: {
								type: "message",
								id: "msg_rejected",
								role: "assistant",
								status: "in_progress",
								content: [],
							},
						});
						this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
						this.sendJson({ type: "response.output_text.delta", delta: "Partial answer" });
					}
					this.sendJson({
						type: "error",
						code,
						message: "Your request rate increased too quickly. Please reduce the request rate.",
					});
					return;
				}

				if (requestIndex === 3) {
					this.emitCodexResponse({
						messageId: "msg_3",
						responseId: "resp_3",
						text: "Second answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				throw new Error(`Unexpected websocket request index: ${requestIndex}`);
			}
		}

		installMockWebSocket((url, options) => new RateLimitedContinuationWebSocket(url, options));
		const model = createCodexTestModel();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const options = {
			fetch: fetchMock as FetchImpl,
			apiKey: createCodexTestToken(),
			sessionId: `ws-${code}-continuation-session`,
			providerSessionState,
		};

		try {
			const firstResponse = await streamOpenAICodexResponses(model, firstContext, options).result();
			const secondContext: Context = {
				systemPrompt: firstContext.systemPrompt,
				messages: [
					...firstContext.messages,
					firstResponse,
					{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
				],
			};

			const rejectedResponse = await streamOpenAICodexResponses(model, secondContext, options).result();
			expect(rejectedResponse.stopReason).toBe("error");
			expect(rejectedResponse.errorMessage).toContain(code);
			if (emitPartialResponse) {
				expect(JSON.stringify(rejectedResponse.content)).toContain("Partial answer");
			} else {
				expect(rejectedResponse.content).toHaveLength(0);
			}

			const retriedResponse = await streamOpenAICodexResponses(model, secondContext, options).result();
			expect(retriedResponse.stopReason).toBe("stop");
			expect(fetchMock).not.toHaveBeenCalled();
			expect(sentRequests).toHaveLength(3);
			expect(sentRequests[2]?.previous_response_id).toBe("resp_1");
			const retryInput = sentRequests[2]?.input;
			expect(Array.isArray(retryInput)).toBe(true);
			expect(retryInput).toHaveLength(1);
			expect(JSON.stringify(retryInput)).toContain("Second question");
			expect(JSON.stringify(retryInput)).not.toContain("First answer");
			expect(JSON.stringify(retryInput)).not.toContain("Partial answer");
			expect(
				getOpenAICodexTransportDetails(model, {
					sessionId: options.sessionId,
					providerSessionState,
				}).websocketConnected,
			).toBe(true);
		} finally {
			closeProviderSessionState(providerSessionState);
		}
	});
	it("carries the server-held prefix when onPayload drops the chain", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];

		class ChainDropWebSocket extends MockWebSocket {
			constructor(url: string, options?: WsOptions) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				this.emitCodexResponse({
					messageId: `msg_${sentRequests.length}`,
					responseId: `resp_${sentRequests.length}`,
					text: sentRequests.length === 1 ? "First answer" : "Second answer",
					includeCreated: true,
				});
			}
		}

		installMockWebSocket((url, options) => new ChainDropWebSocket(url, options));
		const model = createCodexTestModel();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const options = {
			apiKey: createCodexTestToken(),
			sessionId: "ws-onpayload-chain-drop",
			providerSessionState,
			onPayload: (payload: unknown) => {
				const body = payload as Record<string, unknown>;
				delete body.previous_response_id;
				return body;
			},
		};

		try {
			const firstResponse = await streamOpenAICodexResponses(model, firstContext, options).result();
			await streamOpenAICodexResponses(
				model,
				{
					systemPrompt: firstContext.systemPrompt,
					messages: [
						...firstContext.messages,
						firstResponse,
						{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
					],
				},
				options,
			).result();

			// The hook removed the anchor, so the frame must replay what the server
			// would otherwise still hold instead of sending a bare delta.
			expect(sentRequests).toHaveLength(2);
			expect(sentRequests[1]?.previous_response_id).toBeUndefined();
			const replay = JSON.stringify(sentRequests[1]?.input);
			expect(replay).toContain("First question");
			expect(replay).toContain("First answer");
			expect(replay).toContain("Second question");
		} finally {
			closeProviderSessionState(providerSessionState);
		}
	});
});

describe("Codex service tiers", () => {
	it("keeps the sent priority tier when the backend echoes default", async () => {
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", service_tier: "default", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const model = buildModel({
			id: "gpt-5.5",
			serviceTiers: ["priority"],
			name: "Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		});
		const result = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			{
				fetch: async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
				apiKey: createCodexTestToken(),
				serviceTier: "priority",
			},
		).result();
		expect(result.serviceTier).toBe("priority");
		expect(result.usage.premiumRequests).toBe(1);
		expect(result.usage.cost.input).toBeCloseTo(0.0000125);
		expect(result.usage.cost.output).toBeCloseTo(0.000015);
	});

	it("Codex billing uses published catalog multipliers instead of falling back to base Ultrafast estimates", async () => {
		const target = buildModel({
			id: "gpt-6-astra",
			name: "Astra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
			serviceTiers: ["ultrafast"],
			serviceTierCost: { ultrafast: 8 },
			contextWindow: 400000,
			maxTokens: 128000,
		});
		const frames = [
			{
				type: "response.output_item.added",
				item: {
					type: "message",
					id: "tier-message",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "ok" }],
				},
			},
			{
				type: "response.completed",
				response: { status: "completed", service_tier: "ultrafast", usage: DEFAULT_USAGE },
			},
		];
		const result = await streamOpenAICodexResponses(
			target,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: createCodexTestToken(),
				serviceTier: "ultrafast",
				fetch: async () =>
					new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
						headers: { "content-type": "text/event-stream" },
					}),
			},
		).result();
		expect(result.serviceTier).toBe("ultrafast");
		expect(result.usage.cost.input).toBeCloseTo(0.00004);
		expect(result.usage.cost.output).toBeCloseTo(0.000048);
	});

	it("sends a full websocket create when entering or leaving the advertised Ultrafast tier", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class UltrafastWebSocket extends MockWebSocket {
			constructor(url: string, options?: WsOptions) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				const responseIndex = sentRequests.length;
				this.emitCodexResponse({
					messageId: `msg_${responseIndex}`,
					responseId: `resp_${responseIndex}`,
					text: `Answer ${responseIndex}`,
					terminalType: "response.completed",
					includeCreated: true,
				});
			}
		}

		installMockWebSocket((url, options) => new UltrafastWebSocket(url, options));
		const spec = {
			id: "gpt-6.1-sol",
			name: "GPT-6.1 Sol",
			api: "openai-codex-responses" as const,
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"] as ("text" | "image" | "audio" | "video")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 128_000,
		};
		const model = buildModel({ ...spec, serviceTiers: ["priority", "ultrafast"] });
		const providerSessionState = new Map<string, ProviderSessionState>();
		const baseOptions = {
			fetch: fetchMock as FetchImpl,
			apiKey: createCodexTestToken(),
			sessionId: "ws-ultrafast-session",
			providerSessionState,
		};
		const startedAt = Date.now();
		let context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Question 1", timestamp: startedAt }],
		};
		try {
			for (const [turn, serviceTier] of [undefined, "ultrafast", "ultrafast", undefined].entries()) {
				if (turn > 0) {
					context = {
						systemPrompt: context.systemPrompt,
						messages: [
							...context.messages,
							{ role: "user", content: `Question ${turn + 1}`, timestamp: startedAt + turn },
						],
					};
				}
				const response = await streamOpenAICodexResponses(model, context, {
					...baseOptions,
					...(serviceTier ? { serviceTier } : {}),
				}).result();
				context = { systemPrompt: context.systemPrompt, messages: [...context.messages, response] };
			}

			expect(fetchMock).not.toHaveBeenCalled();
			expect(sentRequests.map(request => [request.service_tier, request.previous_response_id])).toEqual([
				[undefined, undefined],
				// Standard → Ultrafast: full create, the whole transcript replayed.
				["ultrafast", undefined],
				// Ultrafast → Ultrafast: chained delta.
				["ultrafast", "resp_2"],
				// Ultrafast → Standard: full create again.
				[undefined, undefined],
			]);
			expect(JSON.stringify(sentRequests[1]?.input)).toContain("Question 1");
			expect(JSON.stringify(sentRequests[2]?.input)).not.toContain("Question 2");
			expect(JSON.stringify(sentRequests[3]?.input)).toContain("Question 1");

			// A Codex model that does not advertise the tier never receives it.
			sentRequests.length = 0;
			await streamOpenAICodexResponses(buildModel({ ...spec, serviceTiers: ["priority"] }), context, {
				...baseOptions,
				sessionId: "ws-ultrafast-unadvertised",
				serviceTier: "ultrafast",
			}).result();
			expect(sentRequests).toHaveLength(1);
			expect(sentRequests[0]?.service_tier).toBeUndefined();
		} finally {
			closeProviderSessionState(providerSessionState);
		}
	});
});

describe("Codex concurrent transport ownership", () => {
	it("routes an overlapping request over SSE without closing the active websocket", async () => {
		const sent = Promise.withResolvers<MockWebSocket>();
		let socket: MockWebSocket | undefined;
		class HeldWebSocket extends MockWebSocket {
			constructor(url: string, options?: WsOptions) {
				super(url, options);
				this.scheduleOpen();
			}
			override send(): void {
				sent.resolve(this);
			}
		}
		installMockWebSocket((url, options) => {
			socket = new HeldWebSocket(url, options);
			return socket;
		});
		const states = new Map<string, ProviderSessionState>();
		const body = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "sse_msg", role: "assistant", content: [] },
			},
			{ type: "response.output_text.delta", delta: "SSE answer" },
			{ type: "response.completed", response: { status: "completed" } },
		]
			.map(frame => `data: ${JSON.stringify(frame)}\n\n`)
			.join("");
		const fetchImpl = vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
		const options = {
			apiKey: createCodexTestToken(),
			sessionId: "overlap",
			providerSessionState: states,
			fetch: fetchImpl as FetchImpl,
		};
		const context: Context = { messages: [{ role: "user", content: "question", timestamp: 1 }] };
		try {
			const first = streamOpenAICodexResponses(createCodexTestModel(), context, options).result();
			await sent.promise;
			const second = await streamOpenAICodexResponses(createCodexTestModel(), context, options).result();
			expect(second.content).toMatchObject([{ type: "text", text: "SSE answer" }]);
			expect(socket?.readyState).toBe(MockWebSocket.OPEN);
			socket?.emitCodexResponse({
				messageId: "first_msg",
				responseId: "first_response",
				text: "WS answer",
				terminalType: "response.completed",
			});
			expect((await first).content).toMatchObject([{ type: "text", text: "WS answer" }]);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		} finally {
			closeProviderSessionState(states);
		}
	});

	it("retries a busy native turn as an independent create without the sticky lane token", async () => {
		const requests: Record<string, unknown>[] = [];
		class NativeLaneWebSocket extends MockWebSocket {
			constructor(url: string, options?: WsOptions) {
				super(url, options);
				this.scheduleOpen();
			}
			override send(data: string): void {
				requests.push(JSON.parse(data));
				if (requests.length === 2) {
					this.sendJson({
						type: "error",
						code: "unsupported_native_inflight_message",
						message: "native lane busy",
					});
					return;
				}
				this.sendJson({ type: "response.metadata", headers: { "x-codex-turn-state": "sticky-lane" } });
				this.emitCodexResponse({
					messageId: `msg_${requests.length}`,
					responseId: `resp_${requests.length}`,
					text: "answer",
					terminalType: "response.completed",
					includeCreated: true,
				});
			}
		}
		installMockWebSocket((url, options) => new NativeLaneWebSocket(url, options));
		const states = new Map<string, ProviderSessionState>();
		const options = { apiKey: createCodexTestToken(), sessionId: "native-lane", providerSessionState: states };
		const context: Context = { messages: [{ role: "user", content: "first", timestamp: 1 }] };
		try {
			const first = await streamOpenAICodexResponses(createCodexTestModel(), context, options).result();
			const second = await streamOpenAICodexResponses(
				createCodexTestModel(),
				{ messages: [...context.messages, first, { role: "user", content: "second", timestamp: 2 }] },
				options,
			).result();
			expect(second.stopReason).toBe("stop");
			expect(requests).toHaveLength(3);
			expect(requests[1]?.previous_response_id).toBe("resp_1");
			expect(requests[2]?.previous_response_id).toBeUndefined();
			expect(requests[2]?.client_metadata).not.toHaveProperty("x-codex-turn-state");
			expect(JSON.stringify(requests[2]?.input)).toContain("first");
		} finally {
			closeProviderSessionState(states);
		}
	});
});

describe("Codex retry hints", () => {
	it("uses usable outer retry headers when nested stream error headers are absent or malformed", () => {
		const error = createCodexProviderStreamError({
			type: "error",
			headers: { "Retry-After": "7" },
			error: { code: "rate_limit_exceeded", message: "at capacity", headers: { "Retry-After": "bad" } },
		});
		expect(formatErrorMessageWithRetryAfter(error)).toContain("retry-after-ms=7000");
	});

	it("prefers a usable nested stream retry hint to a different outer hint", () => {
		const error = createCodexProviderStreamError({
			type: "response.failed",
			headers: { "Retry-After": "7" },
			response: { error: { code: "rate_limit_exceeded", message: "at capacity", headers: { "Retry-After": "3" } } },
		});
		expect(formatErrorMessageWithRetryAfter(error)).toContain("retry-after-ms=3000");
	});

	it("does not turn a capacity 429 with remaining plan headroom into an hours-long reset wait", async () => {
		const now = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const info = await parseCodexError(
			new Response(JSON.stringify({ error: { code: "turn_rate_limit_exceeded", message: "at capacity" } }), {
				status: 429,
				headers: { "x-codex-primary-used-percent": "50", "x-codex-primary-reset-at": String(now / 1000 + 7200) },
			}),
		);
		expect(info.friendlyMessage).not.toContain("Try again");
		const exhausted = await parseCodexError(
			new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
				status: 429,
				headers: {
					"x-codex-primary-used-percent": "100",
					"x-codex-primary-reset-at": String(now / 1000 + 120),
					"x-codex-secondary-used-percent": "100",
					"x-codex-secondary-reset-at": String(now / 1000 + 300),
				},
			}),
		);
		expect(exhausted.friendlyMessage).toContain("~5 min");
	});
});

describe("Codex request controls", () => {
	it("honors explicit reasoning disable with the model disable dialect rather than the requested effort", async () => {
		const base = createCodexTestModel();
		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
		const none = buildModel({
			...base,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
			compat: { ...base.compat, reasoningDisableMode: "none-effort" },
		});
		const lowest = buildModel({
			...base,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
			compat: { ...base.compat, reasoningDisableMode: "lowest-effort" },
		});
		expect(
			(await buildTransformedCodexRequestBody(none, context, { reasoning: "high", disableReasoning: true }))
				.reasoning?.effort,
		).toBe("none");
		expect(
			(await buildTransformedCodexRequestBody(lowest, context, { reasoning: "high", disableReasoning: true }))
				.reasoning?.effort,
		).toBe("low");
	});

	it("records the service tier actually sent after an onPayload websocket override", async () => {
		class TierWebSocket extends MockWebSocket {
			constructor(url: string, options?: WsOptions) {
				super(url, options);
				this.scheduleOpen();
			}
			override send(): void {
				this.emitCodexResponse({
					messageId: "tier_msg",
					responseId: "tier_resp",
					text: "answer",
					terminalType: "response.completed",
				});
			}
		}
		installMockWebSocket((url, options) => new TierWebSocket(url, options));
		const states = new Map<string, ProviderSessionState>();
		try {
			const result = await streamOpenAICodexResponses(
				createCodexTestModel(),
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{
					apiKey: createCodexTestToken(),
					sessionId: "tier-override",
					providerSessionState: states,
					serviceTier: "priority",
					onPayload: payload => ({ ...(payload as Record<string, unknown>), service_tier: "flex" }),
				},
			).result();
			expect(result.serviceTier).toBe("flex");
		} finally {
			closeProviderSessionState(states);
		}
	});

	it("releases one conversation socket without disposing another conversation sharing the provider", async () => {
		const sockets: MockWebSocket[] = [];
		class SessionWebSocket extends MockWebSocket {
			constructor(url: string, options?: WsOptions) {
				super(url, options);
				sockets.push(this);
				this.scheduleOpen();
			}
			override send(): void {
				this.emitCodexResponse({
					messageId: "session_msg",
					responseId: "session_resp",
					text: "answer",
					terminalType: "response.completed",
				});
			}
		}
		installMockWebSocket((url, options) => new SessionWebSocket(url, options));
		const states = new Map<string, ProviderSessionState>();
		try {
			for (const sessionId of ["owned-one", "owned-two"]) {
				await streamOpenAICodexResponses(
					createCodexTestModel(),
					{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
					{ apiKey: createCodexTestToken(), sessionId, providerSessionState: states },
				).result();
			}
			for (const state of states.values()) state.releaseSession?.("owned-one");
			expect(sockets[0]?.readyState).toBe(MockWebSocket.CLOSED);
			expect(sockets[1]?.readyState).toBe(MockWebSocket.OPEN);
		} finally {
			closeProviderSessionState(states);
		}
	});
});
