import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { Context, FetchImpl, Model, ProviderSessionState } from "../types";
import {
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
});
