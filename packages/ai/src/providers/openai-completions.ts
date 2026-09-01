import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { isKimiModelId } from "@oh-my-pi/pi-catalog/identity";
import { resolveWireModelId } from "@oh-my-pi/pi-catalog/model-thinking";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { ResolvedOpenAICompat } from "@oh-my-pi/pi-catalog/types";
import { $env, logger, parseStreamingJson, parseStreamingJsonThrottled } from "@oh-my-pi/pi-utils";
import { renderDemotedThinking } from "../dialect/demotion";
import * as AIError from "../error";
import { getKimiCommonHeaders } from "../registry/oauth/kimi";
import { getEnvApiKey } from "../stream";
import type {
	AssistantMessage,
	Context,
	Message,
	MessageAttribution,
	Model,
	ProviderSessionState,
	RawSseEvent,
	ServiceTier,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
} from "../types";
import { normalizeSystemPrompts, resolveCacheRetention } from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { isDemotedThinking, kStreamingLastParseLen } from "../utils/block-symbols";
import { hasVisibleAssistantContent, withEmptyCompletionRetry } from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { RawHttpRequestDump } from "../utils/http-inspector";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
	iterateWithTerminalGrace,
} from "../utils/idle-iterator";
import { OpenAIHttpError, postOpenAIStream } from "../utils/openai-http";
import { notifyProviderResponse } from "../utils/provider-response";
import { callWithCopilotModelRetry } from "../utils/retry";
import {
	adaptSchemaForStrict,
	findStrictToolSchemaViolation,
	flattenExclusiveRequiredRootUnion,
	NO_STRICT,
	normalizeSchemaForMoonshot,
	sanitizeSchemaForGrammar,
	toolWireSchema,
} from "../utils/schema";
import {
	type HealedToolCall,
	StreamMarkupHealing,
	type StreamMarkupHealingEvent,
} from "../utils/stream-markup-healing";
import { isForcedToolChoice, mapToOpenAICompletionsToolChoice } from "../utils/tool-choice";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartInputAudio,
	ChatCompletionContentPartText,
	ChatCompletionContentPartVideo,
	ChatCompletionMessageParam,
	ChatCompletionTool,
	ChatCompletionToolMessageParam,
} from "./openai-chat-wire";
import {
	applyOpenAIReasoningEffortFallback,
	clearOpenAIReasoningEffortFallbackState,
	createOpenAIReasoningEffortFallbackKey,
	createOpenAIReasoningEffortFallbackState,
	getOpenAIReasoningEffortFallback,
	type OpenAIReasoningEffortFallback,
	type OpenAIReasoningEffortFallbackState,
	rememberOpenAIReasoningEffortFallback,
	resolveOpenAIReasoningEffortFallback,
} from "./openai-reasoning-fallback";
import {
	applyChatCompletionsCompatPolicy,
	applyChatCompletionsToolStream,
	applyOpenAIExtraBody,
	applyOpenAIGatewayRouting,
	applyOpenAIServiceTier,
	applyOpenRouterReportedCost,
	applyWireModelIdTransform,
	calculateOpenAIUsageAccounting,
	clearOpenAIStrictToolsState,
	createInitialResponsesAssistantMessage,
	createOpenAIStrictToolsState,
	disableStrictToolsForScope,
	getOpenAIPromptCacheKey,
	getOpenAIStrictToolsScope,
	isCompiledGrammarTooLargeStrictError,
	isOpenRouterAnthropicModel,
	isStrictToolsDisabledForScope,
	type OpenAICompatPolicy,
	type OpenAICompletionsParams,
	type OpenAIPromptCacheOptions,
	type OpenAIRequestSetup,
	type OpenAIStrictToolsState,
	parseAzureDeploymentNameMap,
	resolveOpenAICompatPolicy,
	resolveOpenAICompletionsOutputClamp,
	resolveOpenAIOutputTokenParam,
	resolveOpenAIRequestSetup,
	shouldDropAutoToolChoiceForReasoning,
	shouldRetryWithoutStrictTools,
} from "./openai-shared";
import { transformMessages } from "./transform-messages";
import {
	isOpenAICompletionsVisionSupported,
	joinTextWithImagePlaceholder,
	mediaOmissionNote,
	mediaSupportForModel,
} from "./vision-guard";

export { applyOpenRouterRoutingVariant } from "./openai-shared";

type OpenAICompletionsReasoningField = NonNullable<ResolvedOpenAICompat["reasoningContentField"]>;

type ProviderAttributedChatCompletionChunk = ChatCompletionChunk & {
	provider?: unknown;
};

type OpenAICompletionsChoiceUsage = ChatCompletionChunk.Choice & {
	usage?: unknown;
};

type OpenAICompletionsDeltaWithReasoningDetails = ChatCompletionChunk.Choice["delta"] & {
	reasoning_details?: unknown;
};

type OpenAICompletionsAssistantMessageParam = ChatCompletionAssistantMessageParam &
	Partial<Record<OpenAICompletionsReasoningField, string>> & {
		reasoning_details?: unknown[];
	};

type OpenAICompletionsToolMessageParam = ChatCompletionToolMessageParam & {
	name?: string;
};

type OpenAICompletionsUsageLike = {
	completion_tokens?: unknown;
	prompt_tokens?: unknown;
	cached_tokens?: unknown;
	prompt_cache_hit_tokens?: unknown;
	prompt_cache_miss_tokens?: unknown;
	prompt_tokens_details?: unknown;
	completion_tokens_details?: unknown;
};

type OpenAICompletionsPromptTokenDetails = {
	cached_tokens?: unknown;
	cache_write_tokens?: unknown;
};

type OpenAICompletionsCompletionTokenDetails = {
	reasoning_tokens?: unknown;
};

function firstPositiveNumber(...values: unknown[]): number {
	for (const value of values) {
		if (typeof value === "number" && value > 0) return value;
	}
	return 0;
}

function hasPositiveCacheReadTokenField(rawUsage: object): boolean {
	const usageLike = rawUsage as OpenAICompletionsUsageLike;
	if (typeof usageLike.cached_tokens === "number" && usageLike.cached_tokens > 0) return true;
	if (typeof usageLike.prompt_cache_hit_tokens === "number" && usageLike.prompt_cache_hit_tokens > 0) return true;

	const rawPromptTokenDetails = usageLike.prompt_tokens_details;
	if (typeof rawPromptTokenDetails !== "object" || rawPromptTokenDetails === null) return false;

	const promptTokenDetails = rawPromptTokenDetails as OpenAICompletionsPromptTokenDetails;
	return typeof promptTokenDetails.cached_tokens === "number" && promptTokenDetails.cached_tokens > 0;
}

function normalizeMistralToolId(id: string, isMistral: boolean): string {
	if (!isMistral) return id;

	let normalized = id.replace(/[^a-zA-Z0-9]/g, "");

	if (normalized.length < 9) {
		const padding = "ABCDEFGHI";
		normalized = normalized + padding.slice(0, 9 - normalized.length);
	} else if (normalized.length > 9) {
		normalized = normalized.slice(0, 9);
	}
	return normalized;
}

function resolveOpenAICompletionsRoutingEffort(
	model: Model<"openai-completions">,
	effort: Effort | undefined,
): Effort | undefined {
	if (!effort) return undefined;
	if (model.thinking?.efforts.includes(effort)) return effort;
	const compatMappedEffort = model.compat.reasoningEffortMap?.[effort] as Effort | undefined;
	if (compatMappedEffort && model.thinking?.efforts.includes(compatMappedEffort)) return compatMappedEffort;
	const thinkingMappedEffort = model.thinking?.effortMap?.[effort] as Effort | undefined;
	if (thinkingMappedEffort && model.thinking?.efforts.includes(thinkingMappedEffort)) return thinkingMappedEffort;
	return effort;
}

function resolveOpenAICompletionsModelId(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): string {
	const requestedEffort =
		options?.reasoning && !options.disableReasoning && model.reasoning ? (options.reasoning as Effort) : undefined;
	const effort = resolveOpenAICompletionsRoutingEffort(model, requestedEffort);
	const wireId = resolveWireModelId(model, effort);
	return applyWireModelIdTransform(wireId, model.compat.wireModelIdMode, options?.openrouterVariant);
}

function normalizeStreamingContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		let out = "";
		for (const part of content) {
			if (typeof part === "string") {
				out += part;
			} else if (part && typeof part === "object") {
				const obj = part as { type?: unknown; text?: unknown };
				if ((obj.type === undefined || obj.type === "text") && typeof obj.text === "string") {
					out += obj.text;
				}
			}
		}
		return out;
	}
	if (content && typeof content === "object") {
		const obj = content as { type?: unknown; text?: unknown };
		if ((obj.type === undefined || obj.type === "text") && typeof obj.text === "string") {
			return obj.text;
		}
	}
	return "";
}

function serializeToolArguments(value: unknown): string {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		try {
			return JSON.stringify(value);
		} catch {
			return "{}";
		}
	}

	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) return "{}";
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return JSON.stringify(parsed);
			}
		} catch {}
		return "{}";
	}

	return "{}";
}

function cloneStreamingArgumentValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(cloneStreamingArgumentValue);
	}
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return mergeStreamingArgumentObjects(undefined, value as Record<string, unknown>);
	}
	return value;
}

function streamingArgumentValuesEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) return false;
		for (let i = 0; i < left.length; i++) {
			if (!streamingArgumentValuesEqual(left[i], right[i])) return false;
		}
		return true;
	}
	if (
		left !== null &&
		typeof left === "object" &&
		!Array.isArray(left) &&
		right !== null &&
		typeof right === "object" &&
		!Array.isArray(right)
	) {
		const leftObject = left as Record<string, unknown>;
		const rightObject = right as Record<string, unknown>;
		let leftKeys = 0;
		for (const key in leftObject) {
			if (!Object.hasOwn(leftObject, key) || key === "__proto__" || key === "constructor" || key === "prototype")
				continue;
			leftKeys++;
			if (!Object.hasOwn(rightObject, key) || !streamingArgumentValuesEqual(leftObject[key], rightObject[key])) {
				return false;
			}
		}
		let rightKeys = 0;
		for (const key in rightObject) {
			if (!Object.hasOwn(rightObject, key) || key === "__proto__" || key === "constructor" || key === "prototype")
				continue;
			rightKeys++;
		}
		return leftKeys === rightKeys;
	}
	return false;
}

function streamingArgumentArrayStartsWith(value: unknown[], prefix: unknown[]): boolean {
	if (prefix.length > value.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (!streamingArgumentValuesEqual(value[i], prefix[i])) return false;
	}
	return true;
}

function mergeStreamingArgumentArrays(prev: unknown[], fragment: unknown[]): unknown[] {
	if (streamingArgumentArrayStartsWith(fragment, prev)) {
		return fragment.map(cloneStreamingArgumentValue);
	}
	if (streamingArgumentArrayStartsWith(prev, fragment)) {
		return prev.map(cloneStreamingArgumentValue);
	}
	const merged = prev.map(cloneStreamingArgumentValue);
	for (const value of fragment) {
		merged.push(cloneStreamingArgumentValue(value));
	}
	return merged;
}

function mergeStreamingArgumentValues(prev: unknown, fragment: unknown): unknown {
	if (typeof prev === "string" && typeof fragment === "string") {
		return fragment.startsWith(prev) ? fragment : prev + fragment;
	}
	if (Array.isArray(prev) && Array.isArray(fragment)) {
		return mergeStreamingArgumentArrays(prev, fragment);
	}
	if (
		prev !== null &&
		typeof prev === "object" &&
		!Array.isArray(prev) &&
		fragment !== null &&
		typeof fragment === "object" &&
		!Array.isArray(fragment)
	) {
		return mergeStreamingArgumentObjects(prev as Record<string, unknown>, fragment as Record<string, unknown>);
	}
	return cloneStreamingArgumentValue(fragment);
}

function mergeStreamingArgumentObjects(
	prev: Record<string, unknown> | undefined,
	fragment: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	if (prev) {
		for (const key in prev) {
			if (!Object.hasOwn(prev, key) || key === "__proto__" || key === "constructor" || key === "prototype") continue;
			merged[key] = cloneStreamingArgumentValue(prev[key]);
		}
	}
	for (const key in fragment) {
		if (!Object.hasOwn(fragment, key) || key === "__proto__" || key === "constructor" || key === "prototype")
			continue;
		merged[key] = Object.hasOwn(merged, key)
			? mergeStreamingArgumentValues(merged[key], fragment[key])
			: cloneStreamingArgumentValue(fragment[key]);
	}
	return merged;
}

function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some(block => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}

export function isOpenAICompletionsProgressChunk(chunk: unknown): boolean {
	if (!chunk || typeof chunk !== "object") return false;
	const record = chunk as {
		usage?: unknown;
		choices?: ReadonlyArray<{
			finish_reason?: unknown;
			usage?: unknown;
			delta?: {
				content?: unknown;
				tool_calls?: unknown;
				reasoning?: unknown;
				reasoning_content?: unknown;
				reasoning_text?: unknown;
				refusal?: unknown;
			};
		}>;
	};
	if (record.usage) return true;
	const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
	if (!choice) return false;
	if (choice.finish_reason) return true;
	if (choice.usage) return true;
	const delta = choice.delta;
	if (!delta) return false;
	const content = delta.content;
	if (typeof content === "string" ? content.length > 0 : Array.isArray(content) && content.length > 0) return true;
	if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
	if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) return true;
	if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
	if (typeof delta.reasoning_text === "string" && delta.reasoning_text.length > 0) return true;
	if (typeof delta.refusal === "string" && delta.refusal.length > 0) return true;
	return false;
}

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: ToolChoice;
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

	disableReasoning?: boolean;
	serviceTier?: ServiceTier;

	maxTokensExplicit?: boolean;

	openrouterVariant?: string;

	promptCache?: OpenAIPromptCacheOptions;
}

type AppliedToolStrictMode = "mixed" | "all_strict" | "none";
type ToolStrictModeOverride = Exclude<ResolvedOpenAICompat["toolStrictMode"], "mixed"> | undefined;

type BuiltOpenAICompletionTools = {
	tools: ChatCompletionTool[];
	toolStrictMode: AppliedToolStrictMode;

	strictToolsApplied: boolean;
};

const OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX = "openai-completions:";

type OpenAICompletionsProviderSessionState = ProviderSessionState &
	OpenAIStrictToolsState &
	OpenAIReasoningEffortFallbackState;

function createOpenAICompletionsProviderSessionState(): OpenAICompletionsProviderSessionState {
	const strictToolsState = createOpenAIStrictToolsState();
	const reasoningEffortFallbackState = createOpenAIReasoningEffortFallbackState();
	const state: OpenAICompletionsProviderSessionState = {
		...strictToolsState,
		...reasoningEffortFallbackState,
		close: () => {
			clearOpenAIStrictToolsState(state);
			clearOpenAIReasoningEffortFallbackState(state);
		},
	};
	return state;
}

function getOpenAICompletionsProviderSessionState(
	model: Model<"openai-completions">,
	baseUrl: string | undefined,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): OpenAICompletionsProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = `${OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX}${model.provider}:${baseUrl ?? ""}:${model.id}`;
	const existing = providerSessionState.get(key) as OpenAICompletionsProviderSessionState | undefined;
	if (existing) return existing;
	const created = createOpenAICompletionsProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

const DEEPSEEK_SPECIAL_TOKEN_REGEX = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>/g;
const DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX = /^\s*<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>/;
const DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>\s*$/;
const DEEPSEEK_OPEN_DELIMS = ["<｜", "<|"] as const;

function stripDeepseekSpecialTokens(text: string): string {
	const stripped = text.replace(DEEPSEEK_SPECIAL_TOKEN_REGEX, "");
	if (stripped === text) return text;

	let normalized = stripped;
	if (DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX.test(text)) normalized = normalized.replace(/^\s+/u, "");
	if (DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX.test(text)) normalized = normalized.replace(/\s+$/u, "");
	return normalized;
}

function getTrailingPartialDeepseekToken(text: string): string {
	let bestIdx = -1;
	for (const delim of DEEPSEEK_OPEN_DELIMS) {
		const idx = text.lastIndexOf(delim);
		if (idx > bestIdx) bestIdx = idx;
	}
	if (bestIdx === -1) {
		return text.endsWith("<") ? "<" : "";
	}
	const tail = text.slice(bestIdx);
	if (tail.includes("｜>") || tail.includes("|>")) return "";

	if (tail.length > 256) return "";
	return tail;
}
const OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE =
	"OpenAI completions stream timed out while waiting for the first event";

const OPENAI_COMPLETIONS_POST_FINISH_GRACE_MS = 2_500;

const streamOpenAICompletionsOnce = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;
		const policy = resolveOpenAICompatForRequest(model, options);

		const output: AssistantMessage = createInitialResponsesAssistantMessage(model.api, model.provider, model.id);
		let rawRequestDump: RawHttpRequestDump | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new AIError.StreamTimeoutError(
			OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE,
		);
		const { requestAbortController, requestSignal } = abortTracker;
		const onSseEvent = options?.onSseEvent;
		const rawSseObserver = onSseEvent
			? (event: RawSseEvent) => {
					if (!event.event && event.data && event.data !== "[DONE]") {
						try {
							const parsed = JSON.parse(event.data);
							const resolvedEvent =
								typeof parsed.type === "string"
									? parsed.type
									: typeof parsed.object === "string"
										? parsed.object
										: null;
							if (resolvedEvent) {
								event.event = resolvedEvent;
								event.raw = [`event: ${resolvedEvent}`, ...event.raw];
							}
						} catch {}
					}
					onSseEvent(event, model);
				}
			: undefined;

		let finishOpenBlocksOnError: () => void = () => {};

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const idleTimeoutFallbackMs = model.compat.streamIdleTimeoutMs;
			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs(idleTimeoutFallbackMs);
			const firstEventTimeoutMs =
				options?.streamFirstEventTimeoutMs ??
				getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs, model.compat.streamFirstEventTimeoutMs);
			const requestTimeoutMs =
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;
			const { copilotPremiumRequests, baseUrl, headers, query, requestHeaders } = createRequestSetup(
				model,
				context,
				apiKey,
				options?.headers,
				options?.initiatorOverride,
				getOpenAIPromptCacheKey(options),
			);
			const premiumRequestsTotal = copilotPremiumRequests;
			let appliedStrictTools = false;
			const requestReasoningEffortFallbacks = new Map<string, OpenAIReasoningEffortFallback>();
			const attemptedReasoningEffortFallbacks = new Set<string>();
			let activeReasoningEffortFallbackKey: string | undefined;
			let activeRequestParams: OpenAICompletionsParams | undefined;
			const providerSessionState = getOpenAICompletionsProviderSessionState(
				model,
				baseUrl,
				options?.providerSessionState,
			);
			const strictToolsScope = getOpenAIStrictToolsScope(model, baseUrl);
			let disableStrictTools = isStrictToolsDisabledForScope(providerSessionState, strictToolsScope);
			const trimmedBaseUrl = baseUrl.replace(/\/+$/, "");
			const completionsUrl = query
				? `${trimmedBaseUrl}/chat/completions?${new URLSearchParams(query)}`
				: `${trimmedBaseUrl}/chat/completions`;
			const createCompletionsStream = async (toolStrictModeOverride?: ToolStrictModeOverride) => {
				const effectiveToolStrictModeOverride = disableStrictTools ? "none" : toolStrictModeOverride;
				let { params, strictToolsApplied } = buildParams(model, context, options, effectiveToolStrictModeOverride);
				appliedStrictTools = strictToolsApplied;
				const reasoningEffortFallbackKey = createOpenAIReasoningEffortFallbackKey(
					"chat-completions",
					trimmedBaseUrl,
					params.model,
				);
				const requestReasoningEffortFallback = requestReasoningEffortFallbacks.has(reasoningEffortFallbackKey)
					? requestReasoningEffortFallbacks.get(reasoningEffortFallbackKey)
					: getOpenAIReasoningEffortFallback(providerSessionState, reasoningEffortFallbackKey);
				if (requestReasoningEffortFallback !== undefined) {
					applyOpenAIReasoningEffortFallback(params, requestReasoningEffortFallback);
				}
				activeReasoningEffortFallbackKey = reasoningEffortFallbackKey;
				const replacedParams = await options?.onPayload?.(params, model);
				if (replacedParams !== undefined) params = replacedParams as typeof params;
				activeRequestParams = params;
				rawRequestDump = {
					provider: model.provider,
					api: output.api,
					model: model.id,
					method: "POST",
					url: completionsUrl,
					headers: requestHeaders,
					body: params,
				};
				let requestTimeout: NodeJS.Timeout | undefined;
				if (requestTimeoutMs !== undefined) {
					requestTimeout = setTimeout(
						() => abortTracker.abortLocally(firstEventTimeoutAbortError),
						requestTimeoutMs,
					);
				}
				try {
					const headersWithTimeout = { ...headers };
					if (requestTimeoutMs !== undefined) {
						headersWithTimeout["X-Stainless-Timeout"] = Math.floor(requestTimeoutMs / 1000).toString();
					}
					const { events, response, requestId } = await postOpenAIStream<ChatCompletionChunk>({
						url: completionsUrl,
						headers: headersWithTimeout,
						body: params,
						signal: requestSignal,
						fetch: options?.fetch,

						onSseEvent: rawSseObserver,
					});
					await notifyProviderResponse(options, response, model, requestId);
					return events;
				} finally {
					if (requestTimeout !== undefined) clearTimeout(requestTimeout);
				}
			};
			let openaiStream: AsyncIterable<ChatCompletionChunk>;
			try {
				openaiStream = await callWithCopilotModelRetry(() => createCompletionsStream(), {
					provider: model.provider,
					signal: requestSignal,
				});
			} catch (error) {
				const capturedErrorResponse = error instanceof OpenAIHttpError ? error.captured : undefined;
				const reasoningEffortFallback =
					activeReasoningEffortFallbackKey && activeRequestParams && !requestSignal.aborted
						? resolveOpenAIReasoningEffortFallback(error, capturedErrorResponse, activeRequestParams, {
								explicitDisable: options?.disableReasoning === true && options.reasoning === undefined,
							})
						: undefined;
				if (reasoningEffortFallback !== undefined && activeReasoningEffortFallbackKey) {
					const retryMarker = `${activeReasoningEffortFallbackKey}:${String(reasoningEffortFallback)}`;
					if (attemptedReasoningEffortFallbacks.has(retryMarker)) throw error;
					attemptedReasoningEffortFallbacks.add(retryMarker);
					requestReasoningEffortFallbacks.set(activeReasoningEffortFallbackKey, reasoningEffortFallback);
					openaiStream = await createCompletionsStream();
					rememberOpenAIReasoningEffortFallback(
						providerSessionState,
						activeReasoningEffortFallbackKey,
						reasoningEffortFallback,
					);
				} else if (
					isOpenRouterAnthropicModel(model) &&
					!disableStrictTools &&
					isCompiledGrammarTooLargeStrictError(error, capturedErrorResponse)
				) {
					disableStrictToolsForScope(providerSessionState, strictToolsScope);
					disableStrictTools = true;
					openaiStream = await createCompletionsStream("none");
				} else {
					if (
						!shouldRetryWithoutStrictTools(error, capturedErrorResponse, {
							model,
							strictToolsApplied: appliedStrictTools,
							tools: context.tools,
						})
					) {
						throw error;
					}

					disableStrictToolsForScope(providerSessionState, strictToolsScope);
					disableStrictTools = true;
					openaiStream = await createCompletionsStream("none");
				}
			}
			if (premiumRequestsTotal !== undefined) {
				output.usage.premiumRequests = premiumRequestsTotal;
			}
			stream.push({ type: "start", partial: output });

			const stripDeepseekChatTemplateTokens = policy.stream.stripSpecialTokens === "deepseek";
			type ToolCallStreamBlock = ToolCall & {
				partialArgs?: string | Record<string, unknown>;
				streamIndex?: number;
				[kStreamingLastParseLen]?: number;
			};
			type OpenAIStreamBlock = TextContent | ThinkingContent | ToolCallStreamBlock;
			const pendingToolCallBlocks: ToolCallStreamBlock[] = [];
			const toolCallBlockByIndex = new Map<number, ToolCallStreamBlock>();

			const unkeyedBatchBlocks: (ToolCallStreamBlock | undefined)[] = [];
			const clearUnkeyedBatchSlot = (block: ToolCallStreamBlock): void => {
				for (let index = 0; index < unkeyedBatchBlocks.length; index++) {
					if (unkeyedBatchBlocks[index] === block) unkeyedBatchBlocks[index] = undefined;
				}
			};
			let currentBlock: OpenAIStreamBlock | undefined;
			const blockIndex = (block: OpenAIStreamBlock | undefined): number => {
				if (!block) return Math.max(0, output.content.length - 1);
				return output.content.indexOf(block);
			};
			const finishToolCallBlock = (block: ToolCallStreamBlock): void => {
				if (block.partialArgs === undefined) return;
				const contentIndex = blockIndex(block);
				if (contentIndex < 0) return;

				if (typeof block.partialArgs === "object" && !Array.isArray(block.partialArgs)) {
					const fullJson = JSON.stringify(block.partialArgs);
					if (fullJson.length > 0 && fullJson !== "{}") {
						stream.push({ type: "toolcall_delta", contentIndex, delta: fullJson, partial: output });
					}
				}
				block.arguments =
					typeof block.partialArgs === "string" ? parseStreamingJson(block.partialArgs) : block.partialArgs;
				delete block.partialArgs;
				if (block.streamIndex !== undefined) {
					toolCallBlockByIndex.delete(block.streamIndex);
					delete block.streamIndex;
				}
				const pendingIndex = pendingToolCallBlocks.indexOf(block);
				if (pendingIndex >= 0) pendingToolCallBlocks.splice(pendingIndex, 1);
				clearUnkeyedBatchSlot(block);
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
			};
			const finishPendingToolCallBlocks = (): void => {
				for (const block of [...pendingToolCallBlocks]) {
					finishToolCallBlock(block);
				}
			};
			const finishCurrentBlock = (block: OpenAIStreamBlock | undefined): void => {
				if (!block) return;
				const contentIndex = blockIndex(block);
				if (contentIndex < 0) return;
				if (block.type === "text") {
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
					return;
				}
				if (block.type === "thinking") {
					stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
					return;
				}
				finishToolCallBlock(block);
			};
			finishOpenBlocksOnError = () => {
				if (currentBlock?.type !== "toolCall") finishCurrentBlock(currentBlock);
				finishPendingToolCallBlocks();
			};
			const appendText = (
				message: AssistantMessage,
				eventStream: AssistantMessageEventStream,
				text: string,
			): void => {
				if (currentBlock?.type !== "text") {
					if (currentBlock?.type !== "toolCall") finishCurrentBlock(currentBlock);
					currentBlock = { type: "text", text: "" };
					message.content.push(currentBlock);
					eventStream.push({ type: "text_start", contentIndex: blockIndex(currentBlock), partial: message });
				}
				currentBlock.text += text;
				eventStream.push({
					type: "text_delta",
					contentIndex: blockIndex(currentBlock),
					delta: text,
					partial: message,
				});
			};
			const appendThinking = (
				message: AssistantMessage,
				eventStream: AssistantMessageEventStream,
				thinking: string,
				signature?: string,
			): void => {
				if (
					currentBlock?.type !== "thinking" ||
					(signature !== undefined && currentBlock.thinkingSignature !== signature)
				) {
					if (currentBlock?.type !== "toolCall") finishCurrentBlock(currentBlock);
					currentBlock = { type: "thinking", thinking: "", thinkingSignature: signature };
					message.content.push(currentBlock);
					eventStream.push({
						type: "thinking_start",
						contentIndex: blockIndex(currentBlock),
						partial: message,
					});
				}
				if (signature !== undefined && !currentBlock.thinkingSignature) {
					currentBlock.thinkingSignature = signature;
				}
				currentBlock.thinking += thinking;
				eventStream.push({
					type: "thinking_delta",
					contentIndex: blockIndex(currentBlock),
					delta: thinking,
					partial: message,
				});
			};

			const appendTextDelta = (text: string): void => {
				if (!text) return;
				if (!firstTokenTime) firstTokenTime = performance.now();
				appendText(output, stream, text);
			};

			const lastCumulativeReasoningBySignature = new Map<string, string>();
			const appendThinkingDelta = (
				thinking: string,
				signature?: string,
				source: "delta" | "cumulative" = "delta",
			): void => {
				if (!thinking) return;
				let emittedThinking = thinking;
				if (source === "cumulative") {
					const key = signature ?? "";
					const lastSnapshot = lastCumulativeReasoningBySignature.get(key) ?? "";
					if (thinking.startsWith(lastSnapshot)) {
						emittedThinking = thinking.slice(lastSnapshot.length);
					}
					lastCumulativeReasoningBySignature.set(key, thinking);
					if (!emittedThinking) return;
				}
				if (!firstTokenTime) firstTokenTime = performance.now();
				appendThinking(output, stream, emittedThinking, signature);
			};

			let deepseekStripBuffer = "";
			const flushDeepseekStripBuffer = (final: boolean): void => {
				if (deepseekStripBuffer.length === 0) return;
				let flushable: string;
				if (final) {
					flushable = deepseekStripBuffer;
					deepseekStripBuffer = "";
				} else {
					const trailing = getTrailingPartialDeepseekToken(deepseekStripBuffer);
					flushable = deepseekStripBuffer.slice(0, deepseekStripBuffer.length - trailing.length);
					deepseekStripBuffer = trailing;
				}
				const stripped = stripDeepseekSpecialTokens(flushable);
				if (stripped && (stripped === flushable || stripped.trim().length > 0)) appendTextDelta(stripped);
			};
			const appendProcessedText = (processedText: string): void => {
				if (processedText.length === 0) return;
				if (stripDeepseekChatTemplateTokens) {
					deepseekStripBuffer += processedText;
					flushDeepseekStripBuffer(false);
				} else {
					appendTextDelta(processedText);
				}
			};
			const streamMarkupHealingPattern = policy.stream.markupHealingPattern;
			const streamMarkupHealing = streamMarkupHealingPattern
				? new StreamMarkupHealing({ pattern: streamMarkupHealingPattern })
				: undefined;
			const explicitReasoningDeltasMayBeCumulative = policy.stream.reasoningDeltasMayBeCumulative;
			let suppressHealedThinking = false;
			let healedToolCallEmitted = false;
			const emitHealedToolCall = (call: HealedToolCall): void => {
				finishCurrentBlock(currentBlock);
				const block: ToolCall & { partialArgs: string } = {
					type: "toolCall",
					id: call.id,
					name: call.name,
					arguments: {},
					partialArgs: call.arguments,
				};
				block.arguments = parseStreamingJson(call.arguments);
				currentBlock = block;
				output.content.push(block);
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(block), partial: output });
				stream.push({
					type: "toolcall_delta",
					contentIndex: blockIndex(block),
					delta: call.arguments,
					partial: output,
				});
				finishCurrentBlock(block);
				currentBlock = undefined;
				healedToolCallEmitted = true;
			};
			const emitHealingEvent = (event: StreamMarkupHealingEvent, suppressThinking: boolean): void => {
				if (event.type === "text") {
					appendProcessedText(event.text);
				} else if (event.type === "thinking") {
					if (!suppressThinking) appendThinkingDelta(event.thinking);
				} else {
					emitHealedToolCall(event.call);
				}
			};
			const flushHealedToolCalls = (): void => {
				if (!streamMarkupHealing) return;
				const calls = streamMarkupHealing.drainCompleted();
				for (const call of calls) emitHealedToolCall(call);
			};

			let streamFinishedAt: number | undefined;
			let sawUsagePayload = false;
			let awaitTrailingUsageDetails = false;
			const applyUsagePayload = (rawUsage: object): void => {
				output.usage = parseChunkUsage(rawUsage, model, premiumRequestsTotal);
				sawUsagePayload = true;
				awaitTrailingUsageDetails = !hasPositiveCacheReadTokenField(rawUsage);
			};
			const timedOpenaiStream = iterateWithIdleTimeout(openaiStream, {
				idleTimeoutMs,
				firstItemTimeoutMs: firstEventTimeoutMs,
				firstItemErrorMessage: OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE,
				errorMessage: "OpenAI completions stream stalled while waiting for the next event",
				onIdle: () => requestAbortController.abort(),
				onFirstItemTimeout: () => abortTracker.abortLocally(firstEventTimeoutAbortError),
				abortSignal: options?.signal,
				isProgressItem: isOpenAICompletionsProgressChunk,
			});
			const terminalAwareStream = iterateWithTerminalGrace(timedOpenaiStream, {
				finishedAtMs: () => streamFinishedAt,
				graceMs: OPENAI_COMPLETIONS_POST_FINISH_GRACE_MS,

				onGraceEnd: () => requestAbortController.abort(),
			});
			for await (const chunk of terminalAwareStream) {
				if (!chunk || typeof chunk !== "object") continue;

				output.responseId ||= chunk.id;

				if (!output.upstreamProvider) {
					const upstreamProvider = (chunk as ProviderAttributedChatCompletionChunk).provider;
					output.upstreamProvider =
						typeof upstreamProvider === "string" && upstreamProvider.length > 0 ? upstreamProvider : undefined;
				}

				if (chunk.usage) {
					applyUsagePayload(chunk.usage);
				}

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) {
					if (streamFinishedAt !== undefined && sawUsagePayload) break;
					continue;
				}

				if (!chunk.usage) {
					const choiceUsage = (choice as OpenAICompletionsChoiceUsage).usage;
					if (typeof choiceUsage === "object" && choiceUsage !== null) {
						applyUsagePayload(choiceUsage);
					}
				}

				if (choice.finish_reason) {
					const finishReasonResult = mapStopReason(choice.finish_reason);
					output.stopReason = finishReasonResult.stopReason;
					if (finishReasonResult.errorMessage) {
						output.errorMessage = finishReasonResult.errorMessage;
					}
					streamFinishedAt ??= Date.now();
				}

				if (choice.delta) {
					const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
					const deltaRecord = choice.delta as Record<string, unknown>;
					let foundReasoningField: string | undefined;
					let foundReasoningDelta = "";
					for (const field of reasoningFields) {
						const reasoningDelta = deltaRecord[field];
						if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
							foundReasoningField = field;
							foundReasoningDelta = reasoningDelta;
							break;
						}
					}

					if (foundReasoningField) {
						appendThinkingDelta(
							foundReasoningDelta,
							foundReasoningField,
							explicitReasoningDeltasMayBeCumulative ? "cumulative" : "delta",
						);
						suppressHealedThinking = true;
					}

					const normalizedDeltaText = normalizeStreamingContentText(choice.delta.content);
					if (normalizedDeltaText.length > 0) {
						if (!firstTokenTime) firstTokenTime = performance.now();
						const hasStructuredToolCalls =
							Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length > 0;

						if (streamMarkupHealing) {
							const healingEvents = hasStructuredToolCalls
								? streamMarkupHealing.feedEventsWithoutCalls(normalizedDeltaText)
								: streamMarkupHealing.feedEvents(normalizedDeltaText);
							for (const event of healingEvents) {
								emitHealingEvent(event, suppressHealedThinking);
							}
						} else {
							appendProcessedText(normalizedDeltaText);
						}
					}

					if (choice?.delta?.tool_calls && choice.delta.tool_calls.length > 0) {
						const toolCalls = choice.delta.tool_calls;
						for (let toolCallOffset = 0; toolCallOffset < toolCalls.length; toolCallOffset++) {
							const toolCall = toolCalls[toolCallOffset]!;
							const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
							const incomingName = toolCall.function?.name || "";

							const unkeyedBatchedArrayEntry = toolCalls.length > 1 && streamIndex === undefined && !toolCall.id;
							let block = streamIndex !== undefined ? toolCallBlockByIndex.get(streamIndex) : undefined;
							if (!block && toolCall.id) {
								block = pendingToolCallBlocks.find(candidate => candidate.id === toolCall.id);
							}
							if (!block && unkeyedBatchedArrayEntry) {
								const offsetBlock = unkeyedBatchBlocks[toolCallOffset];
								if (offsetBlock && offsetBlock.partialArgs !== undefined) block = offsetBlock;
							}
							if (
								!block &&
								!unkeyedBatchedArrayEntry &&
								currentBlock?.type === "toolCall" &&
								(!toolCall.id || currentBlock.id === toolCall.id)
							) {
								block = currentBlock;
							}

							if (!block) {
								if (currentBlock?.type !== "toolCall") {
									finishCurrentBlock(currentBlock);
								}
								block = {
									type: "toolCall",
									id: toolCall.id || "",
									name: incomingName,
									arguments: {},
									partialArgs: "",
									streamIndex,
								};
								if (streamIndex !== undefined) toolCallBlockByIndex.set(streamIndex, block);
								pendingToolCallBlocks.push(block);
								currentBlock = block;
								output.content.push(block);
								stream.push({
									type: "toolcall_start",
									contentIndex: blockIndex(block),
									partial: output,
								});
								if (unkeyedBatchedArrayEntry) unkeyedBatchBlocks[toolCallOffset] = block;
							} else {
								if (currentBlock !== block && currentBlock && currentBlock.type !== "toolCall") {
									finishCurrentBlock(currentBlock);
								}
								currentBlock = block;
								if (streamIndex !== undefined && block.streamIndex === undefined) {
									block.streamIndex = streamIndex;
									toolCallBlockByIndex.set(streamIndex, block);
								}
							}

							if (toolCall.id) block.id = toolCall.id;
							if (incomingName) block.name = incomingName;
							let delta = "";

							const rawArgs = toolCall.function?.arguments as string | Record<string, unknown> | undefined;
							if (typeof rawArgs === "string") {
								if (rawArgs.length > 0) {
									delta = rawArgs;
									const prev = typeof block.partialArgs === "string" ? block.partialArgs : "";
									block.partialArgs = prev + rawArgs;
									const throttled = parseStreamingJsonThrottled(
										block.partialArgs,
										block[kStreamingLastParseLen] ?? 0,
									);
									if (throttled) {
										block.arguments = throttled.value;
										block[kStreamingLastParseLen] = throttled.parsedLen;
									}
								}
							} else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
								const prev =
									block.partialArgs !== null &&
									typeof block.partialArgs === "object" &&
									!Array.isArray(block.partialArgs)
										? (block.partialArgs as Record<string, unknown>)
										: undefined;
								const merged = mergeStreamingArgumentObjects(prev, rawArgs);
								block.partialArgs = merged;
								block.arguments = merged;
							}
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex(block),
								delta,
								partial: output,
							});
						}
					}

					const reasoningDetails = (choice.delta as OpenAICompletionsDeltaWithReasoningDetails).reasoning_details;
					if (Array.isArray(reasoningDetails)) {
						for (const detail of reasoningDetails) {
							if (!detail || typeof detail !== "object") continue;
							const detailObject = detail as { type?: unknown; id?: unknown; data?: unknown };
							if (detailObject.type === "reasoning.encrypted" && detailObject.id && detailObject.data) {
								const matchingToolCall = output.content.find(
									b => b.type === "toolCall" && b.id === detailObject.id,
								) as ToolCall | undefined;
								if (matchingToolCall) {
									matchingToolCall.thoughtSignature = JSON.stringify(detailObject);
								}
							}
						}
					}
				}

				if (streamFinishedAt !== undefined && sawUsagePayload && !awaitTrailingUsageDetails) break;
			}

			if (streamMarkupHealing) {
				for (const event of streamMarkupHealing.flushEvents()) {
					emitHealingEvent(event, suppressHealedThinking);
				}
				flushHealedToolCalls();
				if (healedToolCallEmitted && output.stopReason === "stop") {
					output.stopReason = "toolUse";
				}
			}

			if (stripDeepseekChatTemplateTokens) {
				flushDeepseekStripBuffer(true);
			}

			if (streamFinishedAt === undefined && output.content.length > 0) {
				throw new AIError.ProviderResponseError(
					"OpenAI completions stream closed before a finish_reason was received",
					{ provider: model.provider, kind: "incomplete-stream" },
				);
			}

			if (currentBlock?.type === "toolCall") {
				finishPendingToolCallBlocks();
			} else {
				finishCurrentBlock(currentBlock);
				finishPendingToolCallBlocks();
			}

			if (output.stopReason === "stop" && output.content.some(b => b.type === "toolCall")) {
				output.stopReason = "toolUse";
			}

			if (
				policy.stream.emptyLengthFinishIsContextError &&
				output.stopReason === "length" &&
				!hasVisibleAssistantContent(output)
			) {
				output.stopReason = "error";
				output.errorMessage = EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE;
			}
			const localAbortReason = abortTracker.getLocalAbortReason();
			if (localAbortReason) {
				throw localAbortReason;
			}
			if (abortTracker.wasCallerAbort()) {
				throw new AIError.AbortError();
			}

			if (output.stopReason === "aborted") {
				throw new AIError.AbortError();
			}
			if (output.stopReason === "error") {
				throw new AIError.ProviderResponseError(output.errorMessage || "Provider returned an error stop reason", {
					provider: model.provider,
					kind: "runtime",
				});
			}

			output.errorMessage = undefined;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			try {
				finishOpenBlocksOnError();
			} catch {}
			const capturedErrorResponse = error instanceof OpenAIHttpError ? error.captured : undefined;
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				abortTracker,
				rawRequestDump,
				capturedErrorResponse,
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;

			const rawMetadata = (error as { error?: { metadata?: { raw?: string } } })?.error?.metadata?.raw;
			if (rawMetadata) output.errorMessage += `\n${rawMetadata}`;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamOpenAICompletions: StreamFunction<"openai-completions"> = (model, context, options) =>
	withEmptyCompletionRetry(model, context, options, streamOpenAICompletionsOnce);

function createRequestSetup(
	model: Model<"openai-completions">,
	context: Context,
	apiKey?: string,
	extraHeaders?: Record<string, string>,
	initiatorOverride?: MessageAttribution,
	promptCacheSessionId?: string,
): OpenAIRequestSetup & { baseUrl: string } {
	const apiVersion = $env.AZURE_OPENAI_API_VERSION || "2024-10-21";
	const deploymentName = parseAzureDeploymentNameMap($env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(model.id) ?? model.id;
	const setup = resolveOpenAIRequestSetup(model, {
		apiKey,
		extraHeaders,
		initiatorOverride,
		promptCacheSessionId,
		messages: context.messages,
		defaultBaseUrl: "https://api.openai.com/v1",

		prependHeaders: model.provider === "kimi-code" ? getKimiCommonHeaders : undefined,
		alibabaCodingPlanAuth: true,
		azureChatCompletions: { apiVersion, deploymentName },
	});
	if (!setup.baseUrl) {
		throw new AIError.ConfigurationError("OpenAI request setup did not resolve a base URL");
	}
	return setup as OpenAIRequestSetup & { baseUrl: string };
}

function resolveOpenAICompatForRequest(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): OpenAICompatPolicy {
	return resolveOpenAICompatPolicy(model, {
		endpoint: "chat-completions",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: mapToOpenAICompletionsToolChoice(options?.toolChoice),
	});
}

function dropOpenRouterKimiForcedToolReasoning(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	policy: OpenAICompatPolicy,
): void {
	if (
		policy.reasoning.disableReason === "forced-tool-choice" &&
		policy.reasoning.disableMode === "openrouter-enabled-false" &&
		policy.compat.isOpenRouterHost &&
		isKimiModelId(model.id)
	) {
		delete params.reasoning;
	}
}

function hasActiveNativeKimiK3Reasoning(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): boolean {
	if (model.provider !== "kimi-code" || model.id.toLowerCase() !== "k3" || !model.reasoning) return false;
	if (options?.reasoning === undefined || options.disableReasoning) return false;
	try {
		const url = new URL(model.baseUrl);
		return url.hostname === "api.kimi.com" && (url.pathname === "/coding" || url.pathname.startsWith("/coding/"));
	} catch {
		return false;
	}
}

function isChatCompletionsPromptCacheableContentBlock(
	block: unknown,
): block is { type: "text" | "image_url" | "input_audio" | "file"; prompt_cache_breakpoint?: { mode: "explicit" } } {
	if (typeof block !== "object" || block === null || !("type" in block)) return false;
	return block.type === "text" || block.type === "image_url" || block.type === "input_audio" || block.type === "file";
}

function markLatestStableChatCompletionsCacheBreakpoint(messages: ChatCompletionMessageParam[]): boolean {
	let latestInputMessage = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" || message.role === "developer") {
			latestInputMessage = i;
			break;
		}
	}
	if (latestInputMessage <= 0) return false;

	for (let i = latestInputMessage - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user" && message.role !== "developer" && message.role !== "system") continue;
		if (typeof message.content === "string") {
			messages[i] = {
				...message,
				content: [{ type: "text", text: message.content, prompt_cache_breakpoint: { mode: "explicit" } }],
			};
			return true;
		}
		for (let j = message.content.length - 1; j >= 0; j--) {
			const block = message.content[j];
			if (!isChatCompletionsPromptCacheableContentBlock(block)) continue;
			Object.assign(block, { prompt_cache_breakpoint: { mode: "explicit" } });
			return true;
		}
	}
	return false;
}

function applyOpenAIChatCompletionsPromptCachePolicy(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): void {
	const promptCacheKey = getOpenAIPromptCacheKey(options);
	if (model.provider === "kimi-code" && promptCacheKey !== undefined) {
		params.prompt_cache_key = promptCacheKey;
	}

	const promptCache = options?.promptCache;
	if (!promptCache || resolveCacheRetention(options?.cacheRetention) === "none") return;
	if (!model.compat.supportsPromptCacheBreakpoints) {
		if (promptCache.mode === "explicit") {
			throw new AIError.ConfigurationError(
				`OpenAI explicit prompt caching is unsupported for ${model.provider}/${model.id}; enable compat.supportsPromptCacheBreakpoints only for a compatible endpoint.`,
			);
		}
		return;
	}

	params.prompt_cache_key = promptCacheKey;
	params.prompt_cache_options = {
		mode: promptCache.mode,
		ttl: promptCache.ttl ?? model.compat.promptCacheBreakpointTtl,
	};
	if (promptCache.mode === "explicit" && promptCache.breakpoint !== "none")
		markLatestStableChatCompletionsCacheBreakpoint(params.messages);
}

function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions | undefined,
	toolStrictModeOverride?: ToolStrictModeOverride,
): {
	params: OpenAICompletionsParams;
	toolStrictMode: AppliedToolStrictMode;
	strictToolsApplied: boolean;
} {
	const initialPolicy = resolveOpenAICompatForRequest(model, options);
	const initialCompat = initialPolicy.compat as ResolvedOpenAICompat;
	const cacheRetention = resolveCacheRetention(options?.cacheRetention);

	const requestModelId = resolveOpenAICompletionsModelId(model, options);
	const params: OpenAICompletionsParams = {
		model: requestModelId,
		messages: [],
		stream: true,
	};
	let toolStrictMode: AppliedToolStrictMode = "none";
	let strictToolsApplied = false;

	if (initialCompat.supportsUsageInStreaming !== false) {
		params.stream_options = { include_usage: true };
	}

	if (initialCompat.supportsStore) {
		params.store = false;
	}

	if (initialCompat.supportsSamplingParams) {
		if (options?.temperature !== undefined) {
			params.temperature = options.temperature;
		}
		if (options?.topP !== undefined) {
			params.top_p = options.topP;
		}
		if (options?.topK !== undefined) {
			params.top_k = options.topK;
		}
		if (options?.minP !== undefined) {
			params.min_p = options.minP;
		}
		if (initialCompat.supportsPenaltyAndStopParams) {
			if (options?.presencePenalty !== undefined) {
				params.presence_penalty = options.presencePenalty;
			}
			if (options?.repetitionPenalty !== undefined) {
				params.repetition_penalty = options.repetitionPenalty;
			}
			if (options?.frequencyPenalty !== undefined) {
				params.frequency_penalty = options.frequencyPenalty;
			}
		}
	}
	if (options?.stopSequences?.length && initialCompat.supportsPenaltyAndStopParams) {
		const seqs = options.stopSequences;
		params.stop = seqs.length === 1 ? seqs[0] : seqs.slice(0, 4);
	}
	applyOpenAIServiceTier(params, options?.serviceTier, model);

	if (context.tools?.length) {
		const builtTools = convertTools(context.tools, initialCompat, toolStrictModeOverride, model.provider);
		params.tools = builtTools.tools;
		toolStrictMode = builtTools.toolStrictMode;
		strictToolsApplied = builtTools.strictToolsApplied;
	} else if (context.tools === undefined && hasToolHistory(context.messages)) {
		params.tools = [];
	}

	if (options?.toolChoice && initialCompat.supportsToolChoice) {
		params.tool_choice = mapToOpenAICompletionsToolChoice(options.toolChoice);
	}
	const forcedToolName =
		typeof params.tool_choice === "object" && params.tool_choice !== null && "function" in params.tool_choice
			? params.tool_choice.function.name
			: undefined;
	if (
		typeof params.tool_choice === "object" &&
		params.tool_choice !== null &&
		!initialCompat.supportsNamedToolChoice
	) {
		if (
			forcedToolName !== undefined &&
			Array.isArray(params.tools) &&
			params.tools.some(tool => tool.type === "function" && tool.function.name === forcedToolName)
		) {
			params.tools = params.tools.filter(tool => tool.type === "function" && tool.function.name === forcedToolName);
		}
		params.tool_choice = "required";
	}
	if (
		forcedToolName !== undefined &&
		Array.isArray(params.tools) &&
		params.tools.some(tool => tool.type === "function" && tool.function.name === forcedToolName) &&
		hasActiveNativeKimiK3Reasoning(model, options)
	) {
		params.tool_choice = "required";
	}
	if (isForcedToolChoice(params.tool_choice) && !initialCompat.supportsForcedToolChoice) {
		params.tool_choice = "auto";
	}

	if (
		(!Array.isArray(params.tools) || params.tools.length === 0) &&
		(params.tool_choice === "none" || isForcedToolChoice(params.tool_choice))
	) {
		delete params.tool_choice;
	}

	if (
		forcedToolName !== undefined &&
		(!Array.isArray(params.tools) ||
			!params.tools.some(tool => tool.type === "function" && tool.function.name === forcedToolName))
	) {
		delete params.tool_choice;
	}

	if (shouldDropAutoToolChoiceForReasoning(model, initialCompat, params.tool_choice, options)) {
		delete params.tool_choice;
	}

	const finalPolicy = resolveOpenAICompatPolicy(model, {
		endpoint: "chat-completions",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: params.tool_choice,
	});
	const compat = finalPolicy.compat as ResolvedOpenAICompat;
	const messages = convertMessages(model, context, compat);
	maybeAddAnthropicCacheControl(compat, messages);
	params.messages = messages;
	const outputToken = resolveOpenAIOutputTokenParam({
		field: compat.maxTokensField,
		maxTokens: options?.maxTokens,
		maxTokensExplicit: options?.maxTokensExplicit ?? options?.maxTokens !== undefined,
		modelMaxTokens: model.maxTokens,
		omitMaxOutputTokens: model.omitMaxOutputTokens ?? false,
		isOpenRouterHost: compat.isOpenRouterHost,
		alwaysSendMaxTokens: compat.alwaysSendMaxTokens,
		providerOutputClamp: resolveOpenAICompletionsOutputClamp(model, compat),
	});
	if (outputToken) {
		if (outputToken.field === "max_tokens") {
			params.max_tokens = outputToken.value;
		} else if (outputToken.field === "max_completion_tokens") {
			params.max_completion_tokens = outputToken.value;
		}
	}
	applyChatCompletionsToolStream(params, model, compat);

	applyChatCompletionsCompatPolicy(params, finalPolicy);
	dropOpenRouterKimiForcedToolReasoning(params, model, finalPolicy);

	applyOpenAIGatewayRouting(params, compat, cacheRetention !== "none");

	applyOpenAIExtraBody(params, compat.extraBody, {
		dropThinkingWhenReasoningEffort: compat.dropThinkingWhenReasoningEffort,
	});
	applyOpenAIChatCompletionsPromptCachePolicy(params, model, options);

	return { params, toolStrictMode, strictToolsApplied };
}

export function parseChunkUsage(
	rawUsage: object,
	model: Model<"openai-completions">,
	premiumRequests: number | undefined,
): AssistantMessage["usage"] {
	const usageLike = rawUsage as OpenAICompletionsUsageLike;
	const rawPromptTokenDetails = usageLike.prompt_tokens_details;
	const promptTokenDetails =
		typeof rawPromptTokenDetails === "object" && rawPromptTokenDetails !== null
			? (rawPromptTokenDetails as OpenAICompletionsPromptTokenDetails)
			: undefined;
	const rawCompletionTokenDetails = usageLike.completion_tokens_details;
	const completionTokenDetails =
		typeof rawCompletionTokenDetails === "object" && rawCompletionTokenDetails !== null
			? (rawCompletionTokenDetails as OpenAICompletionsCompletionTokenDetails)
			: undefined;
	const completionTokens = usageLike.completion_tokens;
	const promptTokens = usageLike.prompt_tokens;
	const cachedTokens = usageLike.cached_tokens;
	const promptCacheHitTokens = usageLike.prompt_cache_hit_tokens;
	const promptCacheMissTokens = usageLike.prompt_cache_miss_tokens;
	const promptTokenCachedTokens = promptTokenDetails?.cached_tokens;
	const completionReasoningTokens = completionTokenDetails?.reasoning_tokens;
	const cacheWriteTokens = promptTokenDetails?.cache_write_tokens;
	const outputTokens = typeof completionTokens === "number" ? completionTokens : 0;
	const accounting = calculateOpenAIUsageAccounting({
		promptTokens: typeof promptTokens === "number" ? promptTokens : 0,
		outputTokens,
		cachedTokens: firstPositiveNumber(cachedTokens, promptCacheHitTokens, promptTokenCachedTokens),
		reasoningTokens: typeof completionReasoningTokens === "number" ? completionReasoningTokens : 0,
		cacheWriteOpenRouter: typeof cacheWriteTokens === "number" ? cacheWriteTokens : undefined,
		cacheWriteDeepSeek: typeof promptCacheMissTokens === "number" ? promptCacheMissTokens : undefined,
		hasDeepSeekCacheHitAndMiss: typeof promptCacheHitTokens === "number" && typeof promptCacheMissTokens === "number",
	});
	const usage: AssistantMessage["usage"] = {
		...accounting,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...(premiumRequests !== undefined ? { premiumRequests } : {}),
	};
	calculateCost(model, usage);
	applyOpenRouterReportedCost(model, usage, rawUsage);
	return usage;
}

function maybeAddAnthropicCacheControl(compat: ResolvedOpenAICompat, messages: ChatCompletionMessageParam[]): void {
	if (compat.cacheControlFormat !== "anthropic") return;

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "developer") continue;

		const content = msg.content;
		if (typeof content === "string") {
			if (content.trim().length === 0) continue;
			msg.content = [
				Object.assign({ type: "text" as const, text: content }, { cache_control: { type: "ephemeral" } }),
			];
			return;
		}

		if (!Array.isArray(content)) continue;

		for (let j = content.length - 1; j >= 0; j--) {
			const part = content[j];
			if (part?.type === "text" && part.text.trim().length > 0) {
				Object.assign(part, { cache_control: { type: "ephemeral" } });
				return;
			}
		}
	}
}

function openAIAudioFormat(mimeType: string): "wav" | "mp3" | undefined {
	const normalized = mimeType.toLowerCase().split(";")[0]?.trim();
	if (
		normalized === "audio/wav" ||
		normalized === "audio/x-wav" ||
		normalized === "audio/wave" ||
		normalized === "audio/vnd.wave"
	)
		return "wav";
	if (normalized === "audio/mpeg" || normalized === "audio/mp3") return "mp3";
	return undefined;
}

export function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: ResolvedOpenAICompat,
): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];

	const maxNormalizedToolCallIdLength = compat.requiresMistralToolIds
		? 9
		: compat.usesOpenAIToolCallIdLimit
			? 40
			: undefined;
	const duplicateToolCallIdSuffixPrefix = compat.requiresMistralToolIds ? "dup" : undefined;
	const normalizeToolCallId = (id: string, source?: AssistantMessage): string => {
		if (compat.requiresMistralToolIds) return normalizeMistralToolId(id, true);

		const isSameModelSource =
			source !== undefined &&
			source.provider === model.provider &&
			source.api === model.api &&
			source.model === model.id;

		if (!isSameModelSource && id.includes("|")) {
			const [callId] = id.split("|");
			return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
		}

		if (compat.usesOpenAIToolCallIdLimit) return id.length > 40 ? id.slice(0, 40) : id;
		return id;
	};
	const transformedMessages = transformMessages(
		context.messages,
		model,
		(id, _target, source) => normalizeToolCallId(id, source),
		maxNormalizedToolCallIdLength,
		duplicateToolCallIdSuffixPrefix,
		compat,
	);

	const remappedToolCallIds = new Map<string, string[]>();
	let generatedToolCallIdCounter = 0;

	const generateFallbackToolCallId = (seed: string): string => {
		generatedToolCallIdCounter += 1;
		const hash = Bun.hash(`${model.provider}:${model.id}:${seed}:${generatedToolCallIdCounter}`).toString(36);
		return `call_${hash}`;
	};

	const rememberToolCallId = (originalId: string, normalizedId: string): void => {
		const queue = remappedToolCallIds.get(originalId);
		if (queue) {
			queue.push(normalizedId);
			return;
		}
		remappedToolCallIds.set(originalId, [normalizedId]);
	};

	const consumeToolCallId = (originalId: string): string | null => {
		const queue = remappedToolCallIds.get(originalId);
		if (!queue || queue.length === 0) return null;
		const nextId = queue.shift() ?? null;
		if (queue.length === 0) remappedToolCallIds.delete(originalId);
		return nextId;
	};

	const ensureToolCallId = (rawId: string, seed: string, source?: AssistantMessage): string => {
		const normalized = normalizeToolCallId(rawId, source);
		if (normalized.trim().length > 0) return normalized;
		return generateFallbackToolCallId(seed);
	};

	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	if (systemPrompts.length > 0) {
		const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
		const role = useDeveloperRole ? "developer" : "system";

		if (compat.supportsMultipleSystemMessages) {
			for (const systemPrompt of systemPrompts) {
				params.push({ role, content: systemPrompt });
			}
		} else {
			params.push({ role, content: systemPrompts.join("\n\n") });
		}
	}

	let lastRole: string | null = null;

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (
			compat.requiresAssistantAfterToolResult &&
			lastRole === "toolResult" &&
			(msg.role === "user" || msg.role === "developer")
		) {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}

		const devAsUser = !compat.supportsDeveloperRole;
		if (msg.role === "user" || msg.role === "developer") {
			const role = !devAsUser && msg.role === "developer" ? "developer" : "user";
			if (typeof msg.content === "string") {
				const text = msg.content.toWellFormed();
				if (text.trim().length === 0) continue;
				params.push({
					role: role,
					content: text,
				});
			} else {
				const supports = mediaSupportForModel(model);
				const supportsImages = supports.image && isOpenAICompletionsVisionSupported(model);
				const content: ChatCompletionContentPart[] = [];
				for (const item of msg.content) {
					if (item.type === "text") {
						const text = item.text.toWellFormed();
						if (text.trim().length === 0) continue;
						content.push({
							type: "text",
							text,
						} satisfies ChatCompletionContentPartText);
					} else if (item.type === "image") {
						if (supportsImages) {
							content.push({
								type: "image_url",
								image_url: {
									url: item.url ?? `data:${item.mimeType};base64,${item.data}`,

									...(item.detail && item.detail !== "original" ? { detail: item.detail } : {}),
								},
							} satisfies ChatCompletionContentPartImage);
						} else {
							content.push({
								type: "text",
								text: mediaOmissionNote("image"),
							} satisfies ChatCompletionContentPartText);
						}
					} else if (item.type === "audio") {
						const format = openAIAudioFormat(item.mimeType);
						if (supports.audio && format) {
							content.push({
								type: "input_audio",
								input_audio: { data: item.data, format },
							} satisfies ChatCompletionContentPartInputAudio);
						} else {
							content.push({
								type: "text",
								text: mediaOmissionNote("audio"),
							} satisfies ChatCompletionContentPartText);
						}
					} else if (supports.video) {
						content.push({
							type: "video_url",
							video_url: {
								url: `data:${item.mimeType};base64,${item.data}`,
							},
						} satisfies ChatCompletionContentPartVideo);
					} else {
						content.push({
							type: "text",
							text: mediaOmissionNote("video"),
						} satisfies ChatCompletionContentPartText);
					}
				}
				if (content.length === 0) continue;
				params.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			const assistantMsg: OpenAICompletionsAssistantMessageParam = {
				role: "assistant",
				content: null,
			};

			const textBlocks = msg.content.filter(b => b.type === "text") as TextContent[];

			const nonEmptyTextBlocks = textBlocks.filter(b => b.text && b.text.trim().length > 0);
			if (nonEmptyTextBlocks.length > 0) {
				assistantMsg.content = nonEmptyTextBlocks
					.map((b, i) => {
						const text = b.text.toWellFormed();
						return isDemotedThinking(b) && i < nonEmptyTextBlocks.length - 1 ? `${text}\n` : text;
					})
					.join("");
			}

			const thinkingBlocks = msg.content.filter(b => b.type === "thinking") as ThinkingContent[];

			const nonEmptyThinkingBlocks = thinkingBlocks.filter(b => b.thinking && b.thinking.trim().length > 0);
			if (nonEmptyThinkingBlocks.length > 0) {
				if (compat.requiresThinkingAsText) {
					const thinkingText = nonEmptyThinkingBlocks
						.map(b => renderDemotedThinking(model.id, b.thinking))
						.join(" ");

					assistantMsg.content =
						typeof assistantMsg.content === "string" && assistantMsg.content.length > 0
							? `${thinkingText} ${assistantMsg.content}`
							: thinkingText;
				} else if (compat.requiresReasoningContentForToolCalls) {
					const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
					const wireField =
						compat.allowsSyntheticReasoningContentForToolCalls &&
						(signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text")
							? signature
							: signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text"
								? (compat.reasoningContentField ?? "reasoning_content")
								: undefined;
					if (wireField) {
						assistantMsg[wireField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
					}
				} else if (compat.thinkingFormat === "zai" && model.reasoning) {
					const reasoningField = compat.reasoningContentField ?? "reasoning_content";
					assistantMsg[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
				} else if (compat.replayReasoningContent) {
					const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
					const reasoningField: OpenAICompletionsReasoningField =
						signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text"
							? signature
							: (compat.reasoningContentField ?? "reasoning_content");
					assistantMsg[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
				}
			}

			if (compat.requiresReasoningContentForToolCalls) {
				const streamedReasoningField = nonEmptyThinkingBlocks[0]?.thinkingSignature;
				const reasoningField =
					compat.allowsSyntheticReasoningContentForToolCalls &&
					(streamedReasoningField === "reasoning_content" ||
						streamedReasoningField === "reasoning" ||
						streamedReasoningField === "reasoning_text")
						? streamedReasoningField
						: (compat.reasoningContentField ?? "reasoning_content");
				const reasoningContent = assistantMsg[reasoningField];
				if (!reasoningContent) {
					const reasoning = assistantMsg.reasoning;
					const reasoningText = assistantMsg.reasoning_text;
					if (reasoning && reasoningField !== "reasoning") {
						assistantMsg[reasoningField] = reasoning;
					} else if (reasoningText && reasoningField !== "reasoning_text") {
						assistantMsg[reasoningField] = reasoningText;
					} else if (nonEmptyThinkingBlocks.length > 0) {
						assistantMsg[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
					}
				}
			}

			const toolCalls = msg.content.filter(b => b.type === "toolCall") as ToolCall[];

			const canUseSyntheticReasoningContent =
				compat.requiresReasoningContentForToolCalls &&
				compat.allowsSyntheticReasoningContentForToolCalls &&
				(compat.thinkingFormat === "openai" ||
					compat.thinkingFormat === "openrouter" ||
					compat.thinkingFormat === "zai");

			const needsReasoningOnAllTurns = compat.requiresReasoningContentForAllAssistantTurns;
			const needsReasoningField = needsReasoningOnAllTurns || toolCalls.length > 0;
			let hasReasoningField =
				assistantMsg.reasoning_content !== undefined ||
				assistantMsg.reasoning !== undefined ||
				assistantMsg.reasoning_text !== undefined;

			if (
				needsReasoningField &&
				!hasReasoningField &&
				compat.requiresReasoningContentForToolCalls &&
				!compat.allowsSyntheticReasoningContentForToolCalls
			) {
				const allThinkingBlocks = msg.content.filter(b => b.type === "thinking") as ThinkingContent[];
				if (allThinkingBlocks.length > 0) {
					const signature = allThinkingBlocks[0].thinkingSignature;
					if (signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text") {
						const reasoningField = compat.reasoningContentField ?? "reasoning_content";
						assistantMsg[reasoningField] = allThinkingBlocks.map(b => b.thinking).join("\n");
						hasReasoningField = true;
					}
				}
			}

			if (
				needsReasoningField &&
				!hasReasoningField &&
				compat.requiresReasoningContentForToolCalls &&
				!compat.allowsSyntheticReasoningContentForToolCalls
			) {
				const reasoningField = compat.reasoningContentField ?? "reasoning_content";
				assistantMsg[reasoningField] = "";
				hasReasoningField = true;
			}

			if (toolCalls.length > 0 && canUseSyntheticReasoningContent && !hasReasoningField) {
				const reasoningField = compat.reasoningContentField ?? "reasoning_content";
				assistantMsg[reasoningField] = ".";
				hasReasoningField = true;
			}
			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc, toolCallIndex) => {
					const toolCallId = ensureToolCallId(tc.id, `${i}:${toolCallIndex}:${tc.name}`, msg);
					rememberToolCallId(tc.id, toolCallId);
					return {
						id: normalizeMistralToolId(toolCallId, compat.requiresMistralToolIds),
						type: "function" as const,
						function: {
							name: tc.name,
							arguments: serializeToolArguments(tc.arguments),
						},
					};
				});
				const reasoningDetails = toolCalls
					.filter(tc => tc.thoughtSignature)
					.map(tc => {
						try {
							const parsed: unknown = JSON.parse(tc.thoughtSignature!);
							return parsed;
						} catch {
							return null;
						}
					})
					.filter(Boolean);
				if (reasoningDetails.length > 0) {
					assistantMsg.reasoning_details = reasoningDetails;
				}
			}

			if (assistantMsg.content === null && (hasReasoningField || assistantMsg.tool_calls)) {
				assistantMsg.content = "";
			}

			const content = assistantMsg.content;
			const hasContent =
				content !== null &&
				content !== undefined &&
				(typeof content === "string" ? content.length > 0 : content.length > 0);
			if (!hasContent && assistantMsg.tool_calls && compat.requiresAssistantContentForToolCalls) {
				assistantMsg.content = ".";
			}
			if (!hasContent && !assistantMsg.tool_calls && !hasReasoningField) {
				continue;
			}
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
			let j = i;

			for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
				const toolMsg = transformedMessages[j] as ToolResultMessage;

				const textResult = toolMsg.content
					.filter(c => c.type === "text")
					.map(c => (c as TextContent).text)
					.join("\n");
				const supportsImages = isOpenAICompletionsVisionSupported(model);
				const hasImages = toolMsg.content.some(c => c.type === "image");
				const omittedImages = hasImages && !supportsImages;

				const hasText = textResult.length > 0;
				const remappedToolCallId = consumeToolCallId(toolMsg.toolCallId);
				const resolvedToolCallId =
					remappedToolCallId ?? ensureToolCallId(toolMsg.toolCallId, `${j}:${toolMsg.toolName ?? "tool"}`);
				const toolResultContent = omittedImages
					? joinTextWithImagePlaceholder(textResult, true)
					: hasText
						? textResult
						: hasImages
							? "(see attached image)"
							: "";
				const toolResultMsg: OpenAICompletionsToolMessageParam = {
					role: "tool",
					content: toolResultContent.toWellFormed(),
					tool_call_id: normalizeMistralToolId(resolvedToolCallId, compat.requiresMistralToolIds),
				};
				if (compat.requiresToolResultName && toolMsg.toolName) {
					toolResultMsg.name = toolMsg.toolName;
				}
				params.push(toolResultMsg);

				if (hasImages && supportsImages) {
					for (const block of toolMsg.content) {
						if (block.type === "image") {
							imageBlocks.push({
								type: "image_url",
								image_url: {
									url: block.url ?? `data:${block.mimeType};base64,${block.data}`,
								},
							});
						}
					}
				}
			}

			i = j - 1;

			if (imageBlocks.length > 0) {
				if (compat.requiresAssistantAfterToolResult) {
					params.push({
						role: "assistant",
						content: "I have processed the tool results.",
					});
				}

				params.push({
					role: "user",
					content: [
						{
							type: "text",
							text: "Attached image(s) from tool result:",
						},
						...imageBlocks,
					],
				});
				lastRole = "user";
			} else {
				lastRole = "toolResult";
			}
			continue;
		}

		lastRole =
			msg.role === "developer"
				? model.reasoning && compat.supportsDeveloperRole
					? "developer"
					: "system"
				: msg.role;
	}

	return params;
}

function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompat,
	toolStrictModeOverride?: ToolStrictModeOverride,
	provider?: string,
): BuiltOpenAICompletionTools {
	const rejectXaiRootObjectUnion = provider === "xai" || provider === "xai-oauth";
	const adaptedTools = tools.map(tool => {
		const strict = !NO_STRICT && compat.supportsStrictMode !== false && tool.strict !== false;
		const baseParameters = rejectXaiRootObjectUnion
			? flattenExclusiveRequiredRootUnion(toolWireSchema(tool))
			: toolWireSchema(tool);
		const adapted = adaptSchemaForStrict(baseParameters, strict);
		return {
			tool,
			baseParameters,
			parameters: adapted.schema,
			strict: adapted.strict,
		};
	});

	const requestedStrictMode = toolStrictModeOverride ?? compat.toolStrictMode;
	const toolStrictMode =
		requestedStrictMode === "none"
			? "none"
			: requestedStrictMode === "all_strict"
				? adaptedTools.every(tool => tool.strict)
					? "all_strict"
					: "none"
				: "mixed";

	const wireTools: ChatCompletionTool[] = [];
	let anyStrictEmitted = false;
	for (const { tool, baseParameters, parameters, strict } of adaptedTools) {
		const includeStrict = toolStrictMode === "all_strict" || (toolStrictMode === "mixed" && strict);

		const includeExplicitFalse =
			!includeStrict && tool.strict === false && toolStrictMode === "mixed" && compat.supportsStrictMode !== false;
		const wireParameters = includeStrict ? parameters : baseParameters;

		const emittedParameters =
			compat.toolSchemaFlavor === "moonshot-mfjs"
				? (normalizeSchemaForMoonshot(wireParameters) as Record<string, unknown>)
				: compat.toolSchemaFlavor === "grammar"
					? sanitizeSchemaForGrammar(wireParameters)
					: wireParameters;
		const violation = findStrictToolSchemaViolation(emittedParameters, "#", { rejectXaiRootObjectUnion });
		if (violation) {
			logger.warn(
				`Tool "${tool.name}" omitted from the openai-completions request: its parameter schema is invalid for this provider at ${violation} (an enum/const value cannot match its declared type, or leftover xAI object-root union). Other tools are unaffected.`,
			);
			continue;
		}
		if (includeStrict) anyStrictEmitted = true;
		wireTools.push({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description || "",
				parameters: emittedParameters,

				...(includeStrict ? { strict: true } : includeExplicitFalse ? { strict: false } : {}),
			},
		});
	}

	return {
		tools: wireTools,
		toolStrictMode,
		strictToolsApplied: wireTools.length > 0 && anyStrictEmitted,
	};
}

const EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE =
	"Model returned no content: prompt filled the context window; raise Ollama num_ctx or shorten the prompt.";

function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		case "error":
			return { stopReason: "error", errorMessage: "Provider returned error finish_reason" };
		case "insufficient_system_resource":
			return {
				stopReason: "error",
				errorMessage: "Provider returned error finish_reason: insufficient_system_resource",
			};
		default:
			return {
				stopReason: "error",
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}
