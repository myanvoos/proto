import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { toFirepassWireModelId, toFireworksWireModelId } from "@oh-my-pi/pi-catalog/fireworks-model-id";
import { isGlm52ReasoningEffortModelId, isKimiK3ModelId } from "@oh-my-pi/pi-catalog/identity";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type {
	OpenAICompat,
	OpenAIReasoningDisableMode,
	OpenAIStreamMarkupHealingPattern,
	OpenRouterRouting,
	ResolvedOpenAICompat,
	ResolvedOpenAIResponsesCompat,
	ResolvedOpenAISharedCompat,
	VercelGatewayRouting,
} from "@oh-my-pi/pi-catalog/types";
import { parseAlibabaTokenPlanCredential } from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";
import {
	COREWEAVE_PROJECT_HEADER,
	coreWeaveProjectHeaders,
	hasCoreWeaveProjectHeader,
	removeBlankCoreWeaveProjectHeaders,
} from "@oh-my-pi/pi-catalog/wire/coreweave";
import { parseGitHubCopilotApiKey } from "@oh-my-pi/pi-catalog/wire/github-copilot";
import {
	$env,
	classifyJsonPrefix,
	extractHttpStatusFromError,
	isRecord,
	logger,
	parseImageMetadata,
	parseStreamingJson,
	parseStreamingJsonThrottled,
	stringifyJson,
	structuredCloneJSON,
	USER_AGENT,
} from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import {
	type Api,
	type AssistantMessage,
	type AudioContent,
	type CacheRetention,
	type ComputerAction,
	type ComputerToolCallMetadata,
	type Context,
	type ImageContent,
	type Message,
	type MessageAttribution,
	type Model,
	OPENAI_MAX_OUTPUT_TOKENS,
	type ServiceTier,
	type StopReason,
	type StreamOptions,
	shouldSendServiceTier,
	type TextContent,
	type TextSignatureV1,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	type Usage,
	type VideoContent,
} from "../types";

export type { OpenAIPromptCacheOptions } from "../types";

import {
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	normalizeResponsesToolCallId,
	normalizeSystemPrompts,
	resolveCacheRetention,
	sanitizeOpenAIResponsesAssistantFallbackItemsForReplay,
	sanitizeOpenAIResponsesAssistantHistoryItemsForReplay,
	sanitizeOpenAIResponsesHistoryItemsForReplay,
	stripUnpairedOpenAIResponsesComputerReasoningIdsForReplay,
} from "../utils";
import {
	clearStreamingPartialJson,
	kStreamingArgumentsDone,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import { hasVisibleAssistantContent } from "../utils/empty-completion-retry";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import {
	escapeHarmonyControlTokens,
	escapeHarmonyControlTokensInJson,
	isHarmonyDialectModel,
} from "../utils/harmony-leak";
import type { CapturedHttpErrorResponse } from "../utils/http-inspector";
import { getOpenRouterHeaders } from "../utils/openrouter-headers";
import { isForcedToolChoice } from "../utils/tool-choice";
import {
	buildCopilotDynamicHeaders,
	hasCopilotVisionInput,
	resolveGitHubCopilotBaseUrl,
} from "./github-copilot-headers";
import type { ChatCompletionCreateParamsStreaming } from "./openai-chat-wire";
import type { InputItem } from "./openai-codex/request-transformer";
import type {
	Response as OpenAIResponse,
	ResponseComputerToolCall,
	ResponseContentPartAddedEvent,
	ResponseCreateParamsStreaming,
	ResponseCustomToolCall,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputItem,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStatus,
	ResponseStreamEvent,
} from "./openai-responses-wire";
import { transformMessages } from "./transform-messages";
import { joinTextWithImagePlaceholder, joinTextWithOmissions, partitionUserMediaContent } from "./vision-guard";

export const NO_AUTH_SENTINEL = "N/A";

export interface OpenAIModelIdentity {
	provider: string;
	id: string;
	baseUrl?: string;
}

export interface OpenAIStrictToolsScope {
	provider: string;
	baseUrl: string | undefined;
	modelId: string;
}

export interface OpenAIStrictToolsState {
	strictTools: {
		disabledModelScopes: Set<string>;
	};
}

export interface OpenAIRequestSetupModel extends OpenAIModelIdentity {
	headers?: Record<string, string>;
	premiumMultiplier?: number;
	compat?: Pick<ResolvedOpenAISharedCompat, "promptCacheSessionHeader">;
}

export interface OpenAICacheOptions {
	cacheRetention?: CacheRetention;
	sessionId?: string;
	promptCacheKey?: string;
}

export interface OpenAIRequestSetupOptions {
	apiKey?: string;
	extraHeaders?: Record<string, string>;
	initiatorOverride?: MessageAttribution;
	messages: Message[];
	defaultBaseUrl?: string;
	prependHeaders?: () => Record<string, string>;
	alibabaCodingPlanAuth?: boolean;
	azureChatCompletions?: {
		apiVersion: string;
		deploymentName: string;
	};
	openAISessionId?: string;
	promptCacheSessionId?: string;
}

export interface OpenAIRequestSetup {
	copilotPremiumRequests: number | undefined;
	baseUrl: string | undefined;
	headers: Record<string, string>;
	query: Record<string, string> | undefined;
	requestHeaders: Record<string, string>;
}

function normalizeSakanaRequestBaseUrl(baseUrl: string | undefined): string | undefined {
	const value = baseUrl?.trim();
	if (!value) return undefined;
	const normalized = value.replace(/\/+$/, "");
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function resolveSakanaRequestBaseUrl(): string | undefined {
	return normalizeSakanaRequestBaseUrl($env.SAKANA_BASE_URL) ?? normalizeSakanaRequestBaseUrl($env.FUGU_BASE_URL);
}

function applyCoreWeaveProjectHeader(headers: Record<string, string>): void {
	removeBlankCoreWeaveProjectHeaders(headers);
	if (hasCoreWeaveProjectHeader(headers)) {
		return;
	}
	const projectHeaders = coreWeaveProjectHeaders($env);
	if (projectHeaders) {
		headers[COREWEAVE_PROJECT_HEADER] = projectHeaders[COREWEAVE_PROJECT_HEADER];
	}
}

function setHeaderIfAbsent(headers: Record<string, string>, name: string, value: string): void {
	const normalizedName = name.toLowerCase();
	for (const existingName in headers) {
		if (existingName.toLowerCase() === normalizedName) return;
	}
	headers[name] = value;
}

export function resolveOpenAIRequestSetup(
	model: OpenAIRequestSetupModel,
	options: OpenAIRequestSetupOptions,
): OpenAIRequestSetup {
	let apiKey = options.apiKey;
	if (!apiKey) {
		if (!$env.OPENAI_API_KEY) {
			throw new AIError.MissingApiKeyError(
				undefined,
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = $env.OPENAI_API_KEY;
	}
	const rawApiKey = apiKey;
	let headers = { ...(model.headers ?? {}) };
	if (model.provider === "openrouter") {
		Object.assign(headers, getOpenRouterHeaders());
	}
	Object.assign(headers, options.extraHeaders);
	if (model.provider === "coreweave") {
		applyCoreWeaveProjectHeader(headers);
	}
	if (options.prependHeaders) {
		headers = { ...options.prependHeaders(), ...headers };
	}

	let copilotPremiumRequests: number | undefined;
	let baseUrl = model.baseUrl;
	if (model.provider === "moonshot") {
		const moonshotBaseUrl = $env.MOONSHOT_BASE_URL?.trim();
		if (moonshotBaseUrl) {
			baseUrl = moonshotBaseUrl;
		}
	}
	if (model.provider === "sakana") {
		const sakanaBaseUrl = resolveSakanaRequestBaseUrl();
		if (sakanaBaseUrl) {
			baseUrl = sakanaBaseUrl;
		}
	}
	if (model.provider === "github-copilot") {
		apiKey = parseGitHubCopilotApiKey(rawApiKey).accessToken;
		const copilot = buildCopilotDynamicHeaders({
			messages: options.messages,
			hasImages: hasCopilotVisionInput(options.messages),
			premiumMultiplier: model.premiumMultiplier,
			headers,
			initiatorOverride: options.initiatorOverride,
		});
		Object.assign(headers, copilot.headers);
		copilotPremiumRequests = copilot.premiumRequests;
		baseUrl = resolveGitHubCopilotBaseUrl(model.baseUrl, rawApiKey) ?? model.baseUrl;
	}

	if (model.provider === "alibaba-token-plan") {
		if (!options.apiKey) {
			throw new AIError.MissingApiKeyError("alibaba-token-plan");
		}
		const credential = parseAlibabaTokenPlanCredential(rawApiKey);
		if (!credential) throw new AIError.ConfigurationError("Invalid QwenCloud Token Plan credential");
		apiKey = credential.token;
		if (credential.baseUrl) baseUrl = credential.baseUrl;
	}

	if (options.alibabaCodingPlanAuth && model.provider === "alibaba-coding-plan") {
		try {
			const parsed = JSON.parse(rawApiKey);
			if (typeof parsed?.token === "string") {
				apiKey = parsed.token;
			}
			if (typeof parsed?.enterpriseUrl === "string") {
				baseUrl = parsed.enterpriseUrl;
			}
		} catch {}
	}

	let query: Record<string, string> | undefined;
	if (options.azureChatCompletions && baseUrl?.includes(".openai.azure.com")) {
		if (!baseUrl.includes("/deployments/")) {
			baseUrl = `${baseUrl}/deployments/${options.azureChatCompletions.deploymentName}`;
		}
		query = { "api-version": options.azureChatCompletions.apiVersion };
	}

	if (options.openAISessionId && model.provider === "openai") {
		setHeaderIfAbsent(headers, "session_id", options.openAISessionId);
		setHeaderIfAbsent(headers, "x-client-request-id", options.openAISessionId);
	}
	if (options.promptCacheSessionId && model.compat?.promptCacheSessionHeader) {
		setHeaderIfAbsent(headers, model.compat.promptCacheSessionHeader, options.promptCacheSessionId);
	}

	if (options.defaultBaseUrl !== undefined) {
		baseUrl = baseUrl ?? ($env.OPENAI_BASE_URL?.trim() || options.defaultBaseUrl);
	}

	if (model.provider === "xai" || model.provider === "xai-oauth") {
		setHeaderIfAbsent(headers, "User-Agent", USER_AGENT);
	}
	const requestHeaders = { ...headers };

	if (apiKey !== NO_AUTH_SENTINEL) {
		headers.Authorization ??= `Bearer ${apiKey}`;
	}
	return { copilotPremiumRequests, baseUrl, headers, query, requestHeaders };
}

export function applyOpenAIServiceTier(
	params: { service_tier?: ServiceTier | null | undefined },
	serviceTier: ServiceTier | null | undefined,
	model: Pick<Model, "provider" | "api" | "id">,
): void {
	if (!shouldSendServiceTier(serviceTier, model)) return;
	params.service_tier = serviceTier;
}

function getOpenAIResponsesServiceTierCostMultiplier(tier: string | null | undefined): number {
	switch (tier) {
		case "flex":
			return 0.5;
		case "priority":
			return 2;
		default:
			return 1;
	}
}

export function applyOpenAIResponsesServiceTierCost(
	model: Pick<Model, "provider">,
	usage: AssistantMessage["usage"],
	responseServiceTier: unknown,
	requestServiceTier: ServiceTier | null | undefined,
): void {
	if (model.provider !== "openai") return;

	const served = typeof responseServiceTier === "string" ? responseServiceTier : (requestServiceTier ?? undefined);
	const multiplier = getOpenAIResponsesServiceTierCostMultiplier(served);
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

export function applyOpenRouterReportedCost(model: Pick<Model, "provider">, usage: Usage, rawUsage: unknown): void {
	if (model.provider !== "openrouter" || typeof rawUsage !== "object" || rawUsage === null) return;
	const reportedCost = Reflect.get(rawUsage, "cost");
	if (typeof reportedCost !== "number" || !Number.isFinite(reportedCost) || reportedCost < 0) return;

	const estimatedCost = usage.cost.total;
	if (Number.isFinite(estimatedCost) && estimatedCost > 0) {
		const scale = reportedCost / estimatedCost;
		usage.cost.input *= scale;
		usage.cost.output *= scale;
		usage.cost.cacheRead *= scale;
		usage.cost.cacheWrite *= scale;
	} else {
		usage.cost.input = reportedCost;
		usage.cost.output = 0;
		usage.cost.cacheRead = 0;
		usage.cost.cacheWrite = 0;
	}
	usage.cost.total = reportedCost;
}

export interface OpenAIUsageAccountingInput {
	promptTokens: number;
	outputTokens: number;
	cachedTokens: number;
	reasoningTokens: number;
	cacheWriteOpenRouter: number | undefined;
	cacheWriteDeepSeek: number | undefined;
	hasDeepSeekCacheHitAndMiss: boolean;
}

export interface OpenAIUsageAccounting {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	reasoningTokens?: number;
	orchestration?: Usage["orchestration"];
}

export function calculateOpenAIUsageAccounting(accounting: OpenAIUsageAccountingInput): OpenAIUsageAccounting {
	const cacheWriteTokens = accounting.cacheWriteOpenRouter ?? accounting.cacheWriteDeepSeek ?? 0;
	const isDeepSeekUsage =
		accounting.hasDeepSeekCacheHitAndMiss &&
		accounting.cacheWriteOpenRouter === undefined &&
		(accounting.cacheWriteDeepSeek ?? 0) > 0;
	const input = isDeepSeekUsage
		? Math.max(0, accounting.promptTokens - accounting.cachedTokens)
		: Math.max(0, accounting.promptTokens - accounting.cachedTokens - cacheWriteTokens);
	const cacheWrite = isDeepSeekUsage ? 0 : cacheWriteTokens;
	return {
		input,
		output: accounting.outputTokens,
		cacheRead: accounting.cachedTokens,
		cacheWrite,
		totalTokens: input + accounting.outputTokens + accounting.cachedTokens + cacheWrite,
		...(accounting.reasoningTokens > 0 ? { reasoningTokens: accounting.reasoningTokens } : {}),
	};
}

export function normalizeOpenAIPromptCacheKey(sessionId: string | undefined): string | undefined {
	return normalizeOpenAIStableId(sessionId, 64, "pc_");
}

export function normalizeOpenRouterResponsesSessionId(sessionId: string | undefined): string | undefined {
	return normalizeOpenAIStableId(sessionId, 256, "session_");
}

export function getOpenAIPromptCacheKey(options: OpenAICacheOptions | undefined): string | undefined {
	if (resolveCacheRetention(options?.cacheRetention) === "none") return undefined;
	return normalizeOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId);
}

export function getOpenAIResponsesRoutingSessionId(
	options: Pick<OpenAICacheOptions, "cacheRetention" | "sessionId"> | undefined,
): string | undefined {
	if (resolveCacheRetention(options?.cacheRetention) === "none") return undefined;
	return normalizeOpenAIPromptCacheKey(options?.sessionId);
}

export function getOpenRouterResponsesSessionId(
	options: Pick<OpenAICacheOptions, "cacheRetention" | "sessionId"> | undefined,
): string | undefined {
	if (resolveCacheRetention(options?.cacheRetention) === "none") return undefined;
	return normalizeOpenRouterResponsesSessionId(options?.sessionId);
}

export function parseAzureDeploymentNameMap(value: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!value) return map;
	for (const entry of value.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;
		map.set(modelId.trim(), deploymentName.trim());
	}
	return map;
}

export function createOpenAIStrictToolsState(): OpenAIStrictToolsState {
	return {
		strictTools: {
			disabledModelScopes: new Set<string>(),
		},
	};
}

export function clearOpenAIStrictToolsState(state: OpenAIStrictToolsState): void {
	state.strictTools.disabledModelScopes.clear();
}

export function getOpenAIStrictToolsScope(
	model: OpenAIModelIdentity,
	resolvedBaseUrl: string | undefined,
): OpenAIStrictToolsScope {
	return {
		provider: model.provider,
		baseUrl: resolvedBaseUrl ?? model.baseUrl,
		modelId: model.id,
	};
}

export function isStrictToolsDisabledForScope(
	state: OpenAIStrictToolsState | undefined,
	scope: OpenAIStrictToolsScope | undefined,
): boolean {
	if (!scope) return false;
	return (
		state?.strictTools.disabledModelScopes.has(`${scope.provider}:${scope.baseUrl ?? ""}:${scope.modelId}`) ?? false
	);
}

export function disableStrictToolsForScope(
	state: OpenAIStrictToolsState | undefined,
	scope: OpenAIStrictToolsScope | undefined,
): void {
	if (!scope) return;
	state?.strictTools.disabledModelScopes.add(`${scope.provider}:${scope.baseUrl ?? ""}:${scope.modelId}`);
}

export function isOpenRouterAnthropicModel(model: OpenAIModelIdentity): boolean {
	return model.provider === "openrouter" && model.id.toLowerCase().startsWith("anthropic/");
}

export function applyOpenRouterRoutingVariant(modelId: string, variant: string | undefined): string {
	if (!variant) return modelId;
	const lastSlash = modelId.lastIndexOf("/");
	const lastColon = modelId.lastIndexOf(":");
	if (lastColon > lastSlash) return modelId;
	return `${modelId}:${variant}`;
}

export function applyWireModelIdTransform(
	baseId: string,
	mode: ResolvedOpenAISharedCompat["wireModelIdMode"],
	openrouterVariant?: string,
): string {
	switch (mode) {
		case "firepass":
			return toFirepassWireModelId(baseId);
		case "fireworks":
			return toFireworksWireModelId(baseId);
		case "openrouter":
			return applyOpenRouterRoutingVariant(baseId, openrouterVariant);
		default:
			return baseId;
	}
}

export interface OpenAIOutputTokenParam {
	field: "max_tokens" | "max_completion_tokens" | "max_output_tokens";
	value: number;
}

export interface ResolveOpenAIOutputTokenInput {
	field: OpenAIOutputTokenParam["field"];

	maxTokens: number | null | undefined;

	maxTokensExplicit: boolean;

	modelMaxTokens: number | null | undefined;

	omitMaxOutputTokens: boolean;

	isOpenRouterHost: boolean;

	alwaysSendMaxTokens: boolean;

	providerOutputClamp?: number;
}

export function resolveOpenAIOutputTokenParam(
	input: ResolveOpenAIOutputTokenInput,
): OpenAIOutputTokenParam | undefined {
	if (input.omitMaxOutputTokens) return undefined;
	const requested =
		input.maxTokens ?? (input.alwaysSendMaxTokens ? (input.modelMaxTokens ?? OPENAI_MAX_OUTPUT_TOKENS) : undefined);
	if (requested === undefined) return undefined;
	if (input.isOpenRouterHost && !input.alwaysSendMaxTokens && !input.maxTokensExplicit) return undefined;
	const value = Math.min(
		requested,
		input.modelMaxTokens ?? Number.POSITIVE_INFINITY,
		input.providerOutputClamp ?? OPENAI_MAX_OUTPUT_TOKENS,
	);
	if (!(value > 0)) return undefined;
	return { field: input.field, value };
}

export interface OpenAIGatewayRoutingParams {
	provider?: OpenRouterRouting;
	providerOptions?: { gateway?: Pick<VercelGatewayRouting, "only" | "order" | "caching"> };
}

export interface OpenAIGatewayRoutingCompat {
	isOpenRouterHost: boolean;
	openRouterRouting?: OpenRouterRouting;
	isVercelGatewayHost?: boolean;
	vercelGatewayRouting?: VercelGatewayRouting;
}

export function applyOpenAIGatewayRouting(
	params: OpenAIGatewayRoutingParams,
	compat: OpenAIGatewayRoutingCompat,
	cacheEnabled = true,
): void {
	if (compat.isOpenRouterHost && compat.openRouterRouting) {
		params.provider = compat.openRouterRouting;
	}
	if (compat.isVercelGatewayHost && compat.vercelGatewayRouting) {
		const routing = compat.vercelGatewayRouting;
		if (routing.only || routing.order || (cacheEnabled && routing.caching)) {
			const gatewayOptions: Pick<VercelGatewayRouting, "only" | "order" | "caching"> = {};
			if (routing.only) gatewayOptions.only = routing.only;
			if (routing.order) gatewayOptions.order = routing.order;
			if (cacheEnabled && routing.caching) gatewayOptions.caching = routing.caching;
			params.providerOptions = { gateway: gatewayOptions };
		}
	}
}

export interface VercelResponsesCacheParams {
	caching?: "auto";
	cache_anchor_items?: number;
	cache_ttl?: "5m" | "1h";
	providerOptions?: { gateway?: Pick<VercelGatewayRouting, "only" | "order"> };
}

export interface VercelResponsesCacheCompat {
	isVercelGatewayHost: boolean;
	vercelGatewayRouting?: VercelGatewayRouting;
}

export function applyVercelResponsesCacheControls(
	params: VercelResponsesCacheParams,
	compat: VercelResponsesCacheCompat,
	cacheRetention: CacheRetention = "short",
): void {
	const routing = compat.vercelGatewayRouting;
	if (!compat.isVercelGatewayHost) return;

	if (routing?.only || routing?.order) {
		const gateway: Pick<VercelGatewayRouting, "only" | "order"> = {};
		if (routing.only) gateway.only = routing.only;
		if (routing.order) gateway.order = routing.order;
		params.providerOptions = { gateway };
	}

	if (cacheRetention === "none" || routing?.caching !== "auto") return;

	params.caching = "auto";
	if (routing.cacheAnchorItems !== undefined) params.cache_anchor_items = routing.cacheAnchorItems;

	if (routing.cacheTtl !== undefined && (routing.cacheTtl !== "1h" || cacheRetention === "long")) {
		params.cache_ttl = routing.cacheTtl;
	}
}

export interface OpenAIExtraBodyOptions {
	dropThinkingWhenReasoningEffort?: boolean;
}

export function applyOpenAIExtraBody<P extends object>(
	params: P & { venice_parameters?: Record<string, unknown> },
	extraBody: Record<string, unknown> | undefined,
	options?: OpenAIExtraBodyOptions,
): void {
	if (!extraBody) return;
	const encodedVeniceParameters = params.venice_parameters;
	Object.assign(params, extraBody);
	if (encodedVeniceParameters?.disable_thinking === true) {
		const configuredVeniceParameters = extraBody.venice_parameters;
		params.venice_parameters = {
			...(isRecord(configuredVeniceParameters) ? configuredVeniceParameters : {}),
			...encodedVeniceParameters,
		};
	}
	if (options?.dropThinkingWhenReasoningEffort) {
		const shaped = params as { reasoning_effort?: unknown; thinking?: unknown };
		if (shaped.reasoning_effort !== undefined) {
			delete shaped.thinking;
		}
	}
}

export type OpenAICompletionsParams = Omit<ChatCompletionCreateParamsStreaming, "reasoning_effort" | "service_tier"> & {
	top_k?: number;
	min_p?: number;
	repetition_penalty?: number;
	thinking?: { type: "enabled" | "disabled"; effort?: string; keep?: "all" };
	enable_thinking?: boolean;
	preserve_thinking?: boolean;
	chat_template_kwargs?: { enable_thinking?: boolean; preserve_thinking?: boolean; reasoning_effort?: string };
	reasoning?: { effort?: string } | { enabled: false };
	venice_parameters?: { disable_thinking?: boolean; [key: string]: unknown };
	reasoning_effort?: string | null;
	service_tier?: ServiceTier;
	tool_stream?: boolean;
	provider?: OpenAICompat["openRouterRouting"];
	providerOptions?: { gateway?: { only?: string[]; order?: string[] } };
};

export interface ChatCompletionsReasoningOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	disableReasoning?: boolean;
}

export type OpenAICompatEndpoint = "chat-completions" | "responses";

export type OpenAIReasoningDisableReason = "caller" | "forced-tool-choice" | "tool-choice" | "not-requested";

export type OpenAICompatPolicyCompat = ResolvedOpenAISharedCompat &
	Partial<ResolvedOpenAICompat> &
	Partial<ResolvedOpenAIResponsesCompat>;

export interface ResolveOpenAICompatPolicyOptions {
	endpoint: OpenAICompatEndpoint;
	compat?: OpenAICompatPolicyCompat;
	reasoning?: string;
	disableReasoning?: boolean;
	toolChoice?: unknown;
	strictResponsesPairing?: boolean;
	includeEncryptedReasoning?: boolean;
	filterReasoningHistory?: boolean;
	omitReasoningEffort?: boolean;
}

export interface OpenAICompatPolicy {
	endpoint: OpenAICompatEndpoint;
	compat: OpenAICompatPolicyCompat;
	reasoning: {
		modelSupported: boolean;
		supportsParams: boolean;
		requestedEffort?: string;
		wireEffort?: string;
		enabled: boolean;
		disabled: boolean;
		disableReason?: OpenAIReasoningDisableReason;
		dialect: ResolvedOpenAISharedCompat["thinkingFormat"];
		disableMode: OpenAIReasoningDisableMode;
		omitReasoningEffort: boolean;
		includeEncryptedReasoning: boolean;
		filterReasoningHistory: boolean;
		requiresReasoningContentForToolCalls: boolean;
		requiresReasoningContentForAllAssistantTurns: boolean;
		allowsSyntheticReasoningContentForToolCalls: boolean;
		reasoningContentField?: OpenAICompat["reasoningContentField"];
		requiresThinkingAsText: boolean;
	};
	tools: {
		strictResponsesPairing: boolean;
		toolCallIdKind: "default" | "openai-40" | "mistral-9-alnum";
	};
	messages: {
		systemRole: "system" | "developer";
		supportsDeveloperRole: boolean;
		supportsMultipleSystemMessages: boolean;
	};
	stream: {
		stripSpecialTokens: "deepseek" | false;
		markupHealingPattern?: OpenAIStreamMarkupHealingPattern;
		reasoningDeltasMayBeCumulative: boolean;
		emptyLengthFinishIsContextError: boolean;
	};
}

export function mapOpenAIReasoningEffort(
	model: Pick<Model, "thinking">,
	compat: { reasoningEffortMap?: Partial<Record<Effort, string>> } | undefined,
	effort: string,
): string {
	const level = effort as Effort;
	return compat?.reasoningEffortMap?.[level] ?? model.thinking?.effortMap?.[level] ?? effort;
}

function isImplicitDisableWhenNotRequested(disableMode: OpenAIReasoningDisableMode): boolean {
	return (
		disableMode === "zai-thinking-disabled" ||
		disableMode === "qwen-enable-thinking-false" ||
		disableMode === "qwen-template-false"
	);
}

export function shouldDropAutoToolChoiceForReasoning(
	model: Pick<Model, "reasoning">,
	compat: { disableReasoningOnToolChoice: boolean },
	toolChoice: unknown,
	options: { reasoning?: string; disableReasoning?: boolean } | undefined,
): boolean {
	return (
		toolChoice === "auto" &&
		compat.disableReasoningOnToolChoice &&
		Boolean(model.reasoning) &&
		options?.reasoning !== undefined &&
		!options.disableReasoning
	);
}

export function resolveOpenAICompatPolicy<TApi extends Api>(
	model: Model<TApi>,
	options: ResolveOpenAICompatPolicyOptions,
): OpenAICompatPolicy {
	const baseCompat = (options.compat ?? model.compat) as OpenAICompatPolicyCompat;
	const requestedEffort = options.reasoning;
	const modelSupported = Boolean(model.reasoning);
	const forcedToolChoiceSuppressesReasoning =
		baseCompat.disableReasoningOnForcedToolChoice &&
		baseCompat.supportsForcedToolChoice &&
		isForcedToolChoice(options.toolChoice);
	const anyToolChoiceSuppressesReasoning =
		!forcedToolChoiceSuppressesReasoning &&
		baseCompat.disableReasoningOnToolChoice &&
		options.toolChoice !== undefined;
	const requestedAndAllowed = requestedEffort !== undefined && !options.disableReasoning && modelSupported;
	const conflictDisableReason: OpenAIReasoningDisableReason | undefined = forcedToolChoiceSuppressesReasoning
		? "forced-tool-choice"
		: anyToolChoiceSuppressesReasoning
			? "tool-choice"
			: undefined;
	const disableReason: OpenAIReasoningDisableReason | undefined = options.disableReasoning
		? "caller"
		: conflictDisableReason;
	const enabledBeforeThinkingVariant = requestedAndAllowed && disableReason === undefined;
	const baseWireEffort =
		enabledBeforeThinkingVariant && requestedEffort !== undefined
			? mapOpenAIReasoningEffort(model, baseCompat, requestedEffort)
			: undefined;
	const disabledByNoneEffort =
		enabledBeforeThinkingVariant &&
		baseCompat.reasoningDisableMode === "zai-thinking-disabled" &&
		baseWireEffort === "none";
	const enabled = enabledBeforeThinkingVariant && !disabledByNoneEffort;
	const compat =
		enabled && baseCompat.whenThinking ? (baseCompat.whenThinking as OpenAICompatPolicyCompat) : baseCompat;
	const omitReasoningEffort =
		options.omitReasoningEffort ?? (compat.omitReasoningEffort || !compat.supportsReasoningEffort);
	const disableMode = compat.reasoningDisableMode;
	let wireEffort =
		enabled && requestedEffort !== undefined ? mapOpenAIReasoningEffort(model, compat, requestedEffort) : undefined;
	const disabledWithoutRequest =
		modelSupported &&
		requestedEffort === undefined &&
		!options.disableReasoning &&
		isImplicitDisableWhenNotRequested(disableMode);
	const disabled =
		(modelSupported && disableReason === "caller") ||
		conflictDisableReason !== undefined ||
		(modelSupported && disabledWithoutRequest) ||
		disabledByNoneEffort;
	if (disabled && compat.supportsReasoningEffort && !omitReasoningEffort) {
		if (disableMode === "none-effort") {
			wireEffort = "none";
		} else if (disableReason === "caller" && requestedEffort === undefined && disableMode === "lowest-effort") {
			const minEffort = getSupportedEfforts(model)[0];
			if (minEffort === undefined) {
				throw new AIError.ConfigurationError(
					`Model ${model.provider}/${model.id} has no supported reasoning efforts`,
				);
			}
			wireEffort = mapOpenAIReasoningEffort(model, compat, minEffort);
		}
	}

	return {
		endpoint: options.endpoint,
		compat,
		reasoning: {
			modelSupported,
			supportsParams: compat.supportsReasoningParams,
			requestedEffort,
			wireEffort,
			enabled,
			disabled,
			disableReason: disableReason ?? (disabledWithoutRequest || disabledByNoneEffort ? "not-requested" : undefined),
			dialect: compat.thinkingFormat,
			requiresReasoningContentForToolCalls: compat.requiresReasoningContentForToolCalls,
			requiresReasoningContentForAllAssistantTurns: compat.requiresReasoningContentForAllAssistantTurns,
			allowsSyntheticReasoningContentForToolCalls: compat.allowsSyntheticReasoningContentForToolCalls,
			reasoningContentField: compat.reasoningContentField,
			requiresThinkingAsText: compat.requiresThinkingAsText,
			disableMode,
			omitReasoningEffort,
			includeEncryptedReasoning: options.includeEncryptedReasoning ?? compat.includeEncryptedReasoning,
			filterReasoningHistory: options.filterReasoningHistory ?? compat.filterReasoningHistory,
		},
		tools: {
			strictResponsesPairing: options.strictResponsesPairing ?? compat.strictResponsesPairing ?? false,
			toolCallIdKind: compat.requiresMistralToolIds
				? "mistral-9-alnum"
				: compat.usesOpenAIToolCallIdLimit
					? "openai-40"
					: "default",
		},
		messages: {
			systemRole: modelSupported && compat.supportsDeveloperRole ? "developer" : "system",
			supportsDeveloperRole: compat.supportsDeveloperRole,
			supportsMultipleSystemMessages: compat.supportsMultipleSystemMessages ?? true,
		},
		stream: {
			stripSpecialTokens: compat.stripDeepseekSpecialTokens ? "deepseek" : false,
			markupHealingPattern: compat.streamMarkupHealingPattern,
			reasoningDeltasMayBeCumulative: compat.reasoningDeltasMayBeCumulative,
			emptyLengthFinishIsContextError: compat.emptyLengthFinishIsContextError,
		},
	};
}

function encodeChatCompletionsDisabledReasoning(
	params: OpenAICompletionsParams,
	disableMode: OpenAIReasoningDisableMode,
): void {
	delete params.reasoning_effort;
	switch (disableMode) {
		case "none-effort":
			params.reasoning_effort = "none";
			break;
		case "zai-thinking-disabled":
			params.thinking = { type: "disabled" };
			break;
		case "qwen-enable-thinking-false":
			params.enable_thinking = false;
			break;
		case "qwen-template-false":
			params.chat_template_kwargs = { ...params.chat_template_kwargs, enable_thinking: false };
			break;
		case "openrouter-enabled-false":
			(params as typeof params & { reasoning?: { effort?: string } | { enabled: false } }).reasoning = {
				enabled: false,
			};
			break;
		case "venice-disable-thinking":
			params.venice_parameters = { ...params.venice_parameters, disable_thinking: true };
			break;
		default:
			delete params.reasoning;
			break;
	}
}

export function applyChatCompletionsCompatPolicy(params: OpenAICompletionsParams, policy: OpenAICompatPolicy): void {
	if (policy.compat.qwenPreserveThinking) {
		if (policy.compat.thinkingFormat === "qwen") {
			params.preserve_thinking = true;
		}
		params.chat_template_kwargs = { ...params.chat_template_kwargs, preserve_thinking: true };
	}

	const reasoning = policy.reasoning;
	if ((!reasoning.modelSupported && !reasoning.disabled) || !reasoning.supportsParams) return;
	if (reasoning.enabled) {
		switch (reasoning.disableMode) {
			case "zai-thinking-disabled":
				if (reasoning.wireEffort === "none") {
					encodeChatCompletionsDisabledReasoning(params, reasoning.disableMode);
					return;
				}
				if (reasoning.dialect === "kimi" && reasoning.wireEffort !== undefined) {
					params.thinking = { type: "enabled", effort: reasoning.wireEffort };
					if (policy.compat.thinkingKeep) params.thinking.keep = policy.compat.thinkingKeep;
					break;
				}
				params.thinking = { type: "enabled" };
				if (policy.compat.thinkingKeep) params.thinking.keep = policy.compat.thinkingKeep;
				if (policy.compat.supportsReasoningEffort && reasoning.wireEffort !== undefined) {
					params.reasoning_effort = reasoning.wireEffort as Effort;
				}
				break;
			case "qwen-enable-thinking-false":
				params.enable_thinking = true;

				if (policy.compat.qwenTemplateReasoningEffort && reasoning.wireEffort !== undefined) {
					params.reasoning_effort = reasoning.wireEffort;
					params.chat_template_kwargs = {
						...params.chat_template_kwargs,
						reasoning_effort: reasoning.wireEffort,
					};
				}
				break;
			case "qwen-template-false":
				params.chat_template_kwargs = {
					...params.chat_template_kwargs,
					enable_thinking: true,
					...(policy.compat.qwenTemplateReasoningEffort && reasoning.wireEffort !== undefined
						? { reasoning_effort: reasoning.wireEffort }
						: {}),
				};
				break;
			case "openrouter-enabled-false":
				if (reasoning.wireEffort !== undefined) {
					(params as typeof params & { reasoning?: { effort?: string } }).reasoning = {
						effort: reasoning.wireEffort,
					};
				}
				break;
			default:
				if (!reasoning.omitReasoningEffort && reasoning.wireEffort !== undefined) {
					params.reasoning_effort = reasoning.wireEffort as Effort;
				}
				break;
		}
		return;
	}
	if (!reasoning.disabled) return;
	if (
		reasoning.disableReason === "caller" &&
		reasoning.requestedEffort === undefined &&
		(reasoning.disableMode === "lowest-effort" || reasoning.disableMode === "none-effort") &&
		reasoning.wireEffort !== undefined
	) {
		params.reasoning_effort = reasoning.wireEffort as Effort;
		return;
	}
	encodeChatCompletionsDisabledReasoning(params, reasoning.disableMode);
}

export function applyChatCompletionsReasoningParams(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
	options: (ChatCompletionsReasoningOptions & { toolChoice?: unknown }) | undefined,
): void {
	applyChatCompletionsCompatPolicy(
		params,
		resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			compat,
			reasoning: options?.reasoning,
			disableReasoning: options?.disableReasoning,
			toolChoice: options?.toolChoice,
		}),
	);
}

export function disableChatCompletionsReasoningForDialect(
	params: OpenAICompletionsParams,
	compat: ResolvedOpenAICompat,
): void {
	encodeChatCompletionsDisabledReasoning(params, compat.reasoningDisableMode);
}

function isZaiReasoningEffortDialect(model: Model<"openai-completions">, compat: ResolvedOpenAICompat): boolean {
	return compat.thinkingFormat === "zai" && isGlm52ReasoningEffortModelId(model.id);
}

export function resolveOpenAICompletionsOutputClamp(
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): number | undefined {
	if (isZaiReasoningEffortDialect(model, compat)) {
		return model.maxTokens ?? OPENAI_MAX_OUTPUT_TOKENS;
	}
	if (model.provider === "moonshot" && isKimiK3ModelId(model.id)) {
		return model.maxTokens ?? OPENAI_MAX_OUTPUT_TOKENS;
	}
	return undefined;
}

export function resolveOpenAIResponsesOutputClamp(model: Pick<Model, "provider" | "maxTokens">): number | undefined {
	if (model.provider === "meta") {
		return model.maxTokens ?? OPENAI_MAX_OUTPUT_TOKENS;
	}
	return undefined;
}

export function applyChatCompletionsToolStream(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): void {
	if (
		isZaiReasoningEffortDialect(model, compat) &&
		compat.supportsReasoningEffort &&
		Array.isArray(params.tools) &&
		params.tools.length > 0
	) {
		params.tool_stream = true;
	}
}

export function isCompiledGrammarTooLargeStrictError(
	error: unknown,
	capturedErrorResponse: CapturedHttpErrorResponse | undefined,
): boolean {
	const status = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
	if (status !== 400) return false;
	const messageParts = [error instanceof Error ? error.message : undefined, capturedErrorResponse?.bodyText]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join("\n");
	return (
		/invalid_request_error/i.test(messageParts) &&
		/compiled grammar/i.test(messageParts) &&
		/too large/i.test(messageParts)
	);
}

interface StrictToolsRetryContext {
	model: OpenAIModelIdentity;
	strictToolsApplied: boolean;
	tools: Tool[] | undefined;
}

export function shouldRetryWithoutStrictTools(
	error: unknown,
	capturedErrorResponse: CapturedHttpErrorResponse | undefined,
	context: StrictToolsRetryContext,
): boolean {
	const { model, strictToolsApplied, tools } = context;
	if (!tools || tools.length === 0 || !strictToolsApplied) return false;
	const status = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
	if (status !== 400 && status !== 422) return false;
	const errorMessage = error instanceof Error ? error.message.trim() : "";
	const messageParts = [error instanceof Error ? error.message : undefined, capturedErrorResponse?.bodyText]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join("\n");
	if (
		/wrong_api_format|mixed values for 'strict'|tool[s]?\b.*strict|\bstrict\b.*tool|tool parameters? schema|invalid schema for function|structured[_ -]?outputs?\b[^\n]*(?:not (?:supported|available|enabled)|unsupported)|(?:not support|unsupported)[^\n]*structured[_ -]?outputs?\b/i.test(
			messageParts,
		)
	) {
		return true;
	}
	if (model.provider !== "openrouter" || !/^(?:400\s+)?Provider returned error$/i.test(errorMessage)) return false;
	const body = capturedErrorResponse?.bodyJson;
	if (body && typeof body === "object" && "error" in body) {
		const errorBody = body.error;
		if (errorBody && typeof errorBody === "object" && "metadata" in errorBody) {
			const metadata = errorBody.metadata;
			if (metadata && typeof metadata === "object" && "raw" in metadata) {
				const raw = metadata.raw;
				if (typeof raw === "string" ? raw.trim().length > 0 : raw != null) return false;
			}
		}
	}
	return true;
}

function normalizeOpenAIStableId(value: string | undefined, maxLength: number, hashPrefix: string): string | undefined {
	if (!value || value.length === 0) return undefined;
	const wellFormed = value.toWellFormed();
	if (wellFormed.length <= maxLength) return wellFormed;
	return `${hashPrefix}${Bun.hash(wellFormed).toString(36)}`;
}

export const OPENAI_RESPONSES_PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
	"response.created",
	"response.output_item.added",
	"response.reasoning_summary_part.added",
	"response.reasoning_summary_text.delta",
	"response.reasoning_summary_text.done",
	"response.reasoning_summary_part.done",
	"response.reasoning_text.delta",
	"response.content_part.added",
	"response.output_text.delta",
	"response.refusal.delta",
	"response.function_call_arguments.delta",
	"response.function_call_arguments.done",
	"response.custom_tool_call_input.delta",
	"response.custom_tool_call_input.done",
	"response.output_item.done",
	"response.completed",
	"response.incomplete",
	"response.failed",
	"error",
]);

export function isOpenAIResponsesProgressEvent(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const type = (event as { type?: unknown }).type;
	return typeof type === "string" && OPENAI_RESPONSES_PROGRESS_EVENT_TYPES.has(type);
}

export function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

export function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {}
	}
	return { id: signature };
}

export function encodeResponsesToolCallId(callId: string, itemId: string | null | undefined): string {
	const stableItemId = itemId && itemId.length > 0 ? itemId : `fc_${Bun.hash(callId).toString(36)}`;
	return `${callId}|${stableItemId}`;
}

export function normalizeResponsesToolCallIdForTransform(
	id: string,
	model?: Model<Api>,
	source?: AssistantMessage,
): string {
	if (!id.includes("|")) return id;
	const isForeignToolCall =
		source != null && model != null && (source.provider !== model.provider || source.api !== model.api);
	if (isForeignToolCall) {
		const [callId, itemId] = id.split("|");
		const normalizeIdPart = (part: string): string => {
			const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
			const truncated = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
			return truncated.replace(/_+$/, "");
		};
		const normalizedCallId = normalizeIdPart(callId);
		let normalizedItemId = `fc_${Bun.hash(itemId).toString(36)}`;
		if (normalizedItemId.length > 64) normalizedItemId = normalizedItemId.slice(0, 64);
		return `${normalizedCallId}|${normalizedItemId}`;
	}
	const normalized = normalizeResponsesToolCallId(id);
	return `${normalized.callId}|${normalized.itemId}`;
}

type ResponsesToolCallKind = "function" | "custom" | "computer";

function responsesToolCallKind(type: unknown): ResponsesToolCallKind | undefined {
	if (type === "function_call") return "function";
	if (type === "custom_tool_call") return "custom";
	if (type === "computer_call") return "computer";
	return undefined;
}

function responsesToolOutputKind(type: unknown): ResponsesToolCallKind | undefined {
	if (type === "function_call_output") return "function";
	if (type === "custom_tool_call_output") return "custom";
	if (type === "computer_call_output") return "computer";
	return undefined;
}
function responseInputCallId(item: ResponseInput[number]): string | undefined {
	if (!("call_id" in item)) return undefined;
	return typeof item.call_id === "string" ? item.call_id : undefined;
}

export function collectKnownCallIds(messages: ResponseInput): Set<string> {
	const knownCallIds = new Set<string>();
	for (const item of messages) {
		if (responsesToolCallKind(item.type) === undefined) continue;
		const callId = responseInputCallId(item);
		if (callId) knownCallIds.add(callId);
	}
	return knownCallIds;
}

export function collectCustomCallIds(messages: ResponseInput): Set<string> {
	const customCallIds = new Set<string>();
	for (const item of messages) {
		if (item.type !== "custom_tool_call") continue;
		const callId = responseInputCallId(item);
		if (callId) customCallIds.add(callId);
	}
	return customCallIds;
}

export function collectComputerCallIds(messages: ResponseInput): Set<string> {
	const computerCallIds = new Set<string>();
	for (const item of messages) {
		if (item.type !== "computer_call") continue;
		const callId = responseInputCallId(item);
		if (callId) computerCallIds.add(callId);
	}
	return computerCallIds;
}

export function repairOrphanResponsesToolOutputs(input: ResponseInput): ResponseInput {
	const precedingCalls = new Set<string>();
	let repaired: ResponseInput | undefined;
	for (let index = 0; index < input.length; index++) {
		const item = input[index];
		const callKind = responsesToolCallKind(item.type);
		const callId = responseInputCallId(item);
		if (callKind && callId) precedingCalls.add(`${callKind}\0${callId}`);

		const outputKind = responsesToolOutputKind(item.type);
		if (!outputKind || !callId || precedingCalls.has(`${outputKind}\0${callId}`)) {
			repaired?.push(item);
			continue;
		}

		if (!repaired) repaired = input.slice(0, index);
		const toolName = outputKind === "computer" ? "computer" : "tool";
		const rawOutput = "output" in item ? item.output : undefined;
		let text: string;
		if (typeof rawOutput === "string") text = rawOutput;
		else if (rawOutput == null) text = "";
		else {
			try {
				text = JSON.stringify(rawOutput);
			} catch {
				text = String(rawOutput);
			}
		}
		const ORPHAN_OUTPUT_LIMIT = 16_000;
		if (text.length > ORPHAN_OUTPUT_LIMIT) text = `${text.slice(0, ORPHAN_OUTPUT_LIMIT)}\n...[truncated]`;
		repaired.push({
			type: "message",
			role: "assistant",
			content: `[Orphan ${toolName} result; call_id=${callId}]: ${text}`,
		} as ResponseInput[number]);
	}
	return repaired ?? input;
}

const ORPHAN_TOOL_CALL_PLACEHOLDER =
	"[No tool output recorded: the tool call was interrupted before it produced a result.]";

export function repairOrphanResponsesToolCalls(input: ResponseInput): ResponseInput {
	const laterOutputs = new Set<string>();
	const orphanIndexes = new Set<number>();
	for (let index = input.length - 1; index >= 0; index--) {
		const item = input[index];
		const callId = responseInputCallId(item);
		const outputKind = responsesToolOutputKind(item.type);
		if (outputKind && callId) laterOutputs.add(`${outputKind}\0${callId}`);

		const callKind = responsesToolCallKind(item.type);
		if (callKind && callId && !laterOutputs.has(`${callKind}\0${callId}`)) orphanIndexes.add(index);
	}
	if (orphanIndexes.size === 0) return input;

	const repaired: ResponseInput = [];
	for (let index = 0; index < input.length; index++) {
		const item = input[index];
		if (!orphanIndexes.has(index)) {
			repaired.push(item);
			continue;
		}
		const kind = responsesToolCallKind(item.type);
		const callId = responseInputCallId(item);
		if (!kind || !callId) {
			repaired.push(item);
			continue;
		}
		if (kind === "computer") {
			repaired.push({
				type: "message",
				role: "assistant",
				content: `[Computer call interrupted before a screenshot was recorded; call_id=${callId}]`,
			} as ResponseInput[number]);
			continue;
		}
		repaired.push(item);
		repaired.push({
			type: kind === "custom" ? "custom_tool_call_output" : "function_call_output",
			call_id: callId,
			output: ORPHAN_TOOL_CALL_PLACEHOLDER,
		} as ResponseInput[number]);
	}
	return repaired;
}

type ResponsesBatchItemKind = "call" | "output" | "assistant-message" | "other";

function classifyResponsesBatchItem(item: object): ResponsesBatchItemKind {
	const type = "type" in item ? item.type : undefined;
	if (responsesToolCallKind(type) !== undefined) return "call";
	if (responsesToolOutputKind(type) !== undefined) return "output";
	const role = "role" in item ? item.role : undefined;
	if (type === "message" && role === "assistant") return "assistant-message";
	return "other";
}

export function hoistInterleavedResponsesToolBatchMessages<T extends object>(items: readonly T[]): T[] {
	const moved = new Set<number>();
	const insertBefore = new Map<number, number[]>();
	for (let index = 0; index < items.length; index++) {
		if (classifyResponsesBatchItem(items[index]) !== "output") continue;

		if (index > 0 && classifyResponsesBatchItem(items[index - 1]) === "output") continue;

		let start = index;
		let sawCall = false;
		const messageIndexes: number[] = [];
		while (start > 0) {
			const kind = classifyResponsesBatchItem(items[start - 1]);
			if (kind === "call") {
				sawCall = true;
			} else if (kind === "assistant-message") {
				messageIndexes.push(start - 1);
			} else {
				break;
			}
			start -= 1;
		}

		if (!sawCall || messageIndexes.length === 0) continue;
		messageIndexes.reverse();
		const target = insertBefore.get(start) ?? [];
		for (const messageIndex of messageIndexes) {
			moved.add(messageIndex);
			target.push(messageIndex);
		}
		insertBefore.set(start, target);
	}
	if (moved.size === 0) return items.slice();
	const result: T[] = [];
	for (let index = 0; index < items.length; index++) {
		const pending = insertBefore.get(index);
		if (pending) for (const messageIndex of pending) result.push(items[messageIndex]);
		if (moved.has(index)) continue;
		result.push(items[index]);
	}
	return result;
}

function clampResponsesImageDetail(
	detail: ImageContent["detail"],
	supportsImageDetailOriginal: boolean,
): ResponseInputImage["detail"] {
	const resolved = detail ?? "auto";
	return resolved === "original" && !supportsImageDetailOriginal ? "auto" : resolved;
}

function convertResponsesInputImage(image: ImageContent, supportsImageDetailOriginal: boolean): ResponseInputImage {
	const detail = clampResponsesImageDetail(image.detail, supportsImageDetailOriginal);
	if (image.providerFile?.provider === "openai" && image.providerFile.id) {
		return { type: "input_image", detail, file_id: image.providerFile.id };
	}
	return {
		type: "input_image",
		detail,
		image_url: image.url ?? `data:${image.mimeType};base64,${image.data}`,
	};
}

export function convertResponsesInputContent(
	content: string | Array<AudioContent | ImageContent | TextContent | VideoContent>,
	supportsImages: boolean,
	supportsImageDetailOriginal: boolean,
	escapeControlTokens = false,
): ResponseInputContent[] | undefined {
	if (typeof content === "string") {
		if (content.trim().length === 0) return undefined;
		const text = content.toWellFormed();
		return [
			{
				type: "input_text",
				text: escapeControlTokens ? escapeHarmonyControlTokens(text) : text,
			} satisfies ResponseInputText,
		];
	}

	const { textBlocks, imageBlocks, omissions } = partitionUserMediaContent(content, {
		image: supportsImages,
		audio: false,
		video: false,
	});
	const normalizedContent: ResponseInputContent[] = [];
	for (const item of textBlocks) {
		const raw = item.text.toWellFormed();
		const text = escapeControlTokens ? escapeHarmonyControlTokens(raw) : raw;
		if (text.trim().length === 0) continue;
		normalizedContent.push({
			type: "input_text",
			text,
		} satisfies ResponseInputText);
	}
	for (const item of imageBlocks) {
		normalizedContent.push(convertResponsesInputImage(item, supportsImageDetailOriginal));
	}
	if (omissions.length > 0) {
		normalizedContent.push({
			type: "input_text",
			text: joinTextWithOmissions("", omissions),
		} satisfies ResponseInputText);
	}
	return normalizedContent.length > 0 ? normalizedContent : undefined;
}

function buildCustomToolWireNameMap(tools: readonly Tool[] | undefined): ReadonlyMap<string, string> | undefined {
	if (!tools?.length) return undefined;
	const map = new Map<string, string>();
	for (const tool of tools) {
		if (tool.customWireName) map.set(tool.customWireName, tool.name);
	}
	return map.size > 0 ? map : undefined;
}

function resolveReplayCustomToolName(wireName: string, wireNameMap: ReadonlyMap<string, string> | undefined): string {
	return wireNameMap?.get(wireName) ?? (wireName === "apply_patch" ? "edit" : wireName);
}

function adaptResponsesReplayItemsForModel(
	input: ResponseInput,
	supportsCustomToolCalls: boolean,
	wireNameMap: ReadonlyMap<string, string> | undefined,
	supportsComputerUse: boolean,
): ResponseInput {
	if (supportsCustomToolCalls && supportsComputerUse) return input;

	let changed = false;
	const adapted: ResponseInput = [];
	for (const item of input) {
		if (!supportsCustomToolCalls && item.type === "custom_tool_call") {
			changed = true;
			adapted.push({
				type: "function_call",
				...(item.id ? { id: item.id } : {}),
				call_id: item.call_id,
				name: resolveReplayCustomToolName(item.name, wireNameMap),
				arguments: JSON.stringify({ input: item.input }),
				...(item.namespace ? { namespace: item.namespace } : {}),
			});
			continue;
		}
		if (!supportsCustomToolCalls && item.type === "custom_tool_call_output") {
			changed = true;
			adapted.push({
				type: "function_call_output",
				call_id: item.call_id,
				output: item.output,
			});
			continue;
		}
		if (!supportsComputerUse && (item.type === "computer_call" || item.type === "computer_call_output")) {
			changed = true;
			const callId = responseInputCallId(item) ?? "unknown";
			adapted.push({
				type: "message",
				role: "assistant",
				content: `[Previous computer ${item.type === "computer_call" ? "call" : "result"}; call_id=${callId}]: ${stringifyJson(item) ?? ""}`,
			} as ResponseInput[number]);
			continue;
		}
		adapted.push(item);
	}
	return changed ? adapted : input;
}

export interface BuildResponsesInputOptions<TApi extends Api> {
	model: Model<TApi>;
	context: Context;
	strictResponsesPairing: boolean;
	supportsImageDetailOriginal: boolean;
	systemRole?: "system" | "developer";
	nativeHistory?: {
		replay: boolean;
		filterReasoning: boolean;
	};
	includeThinkingSignatures?: boolean;
	developerStringContent?: boolean;
	repairOrphanOutputs?: boolean;

	preserveAssistantMessageIds?: boolean;

	requiresReasoningReplayForAllTurns?: boolean;

	requiresReasoningReplayForToolCalls?: boolean;
}

export function escapeReplayedControlTokens(items: ResponseInput): ResponseInput {
	return items.map(item => {
		if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
			return typeof item.output === "string" ? { ...item, output: escapeHarmonyControlTokens(item.output) } : item;
		}
		if (item.type === "function_call") {
			return typeof item.arguments === "string"
				? { ...item, arguments: escapeHarmonyControlTokensInJson(item.arguments) }
				: item;
		}
		if (item.type === "custom_tool_call") {
			return typeof item.input === "string" ? { ...item, input: escapeHarmonyControlTokens(item.input) } : item;
		}

		const isTypedMessage = item.type === "message" || item.type === undefined;
		if (!isTypedMessage || !("role" in item) || !("content" in item)) return item;
		if (item.role === "assistant") {
			if ("status" in item && Array.isArray(item.content)) {
				return {
					...item,
					content: item.content.map(part =>
						part.type === "output_text"
							? { ...part, text: escapeHarmonyControlTokens(part.text) }
							: part.type === "refusal"
								? { ...part, refusal: escapeHarmonyControlTokens(part.refusal) }
								: part,
					),
				};
			}
			return item;
		}
		const content = item.content;
		if (typeof content === "string") {
			return { ...item, content: escapeHarmonyControlTokens(content) };
		}
		if (Array.isArray(content)) {
			return {
				...item,
				content: content.map(part =>
					part.type === "input_text" ? { ...part, text: escapeHarmonyControlTokens(part.text) } : part,
				),
			};
		}
		return item;
	});
}

export function buildResponsesInput<TApi extends Api>(options: BuildResponsesInputOptions<TApi>): ResponseInput {
	const messages: ResponseInput = [];
	const systemPrompts = options.systemRole ? normalizeSystemPrompts(options.context.systemPrompt) : [];
	for (const systemPrompt of systemPrompts) {
		messages.push({ role: options.systemRole as "system" | "developer", content: systemPrompt });
	}

	const supportsImageDetailOriginal = options.supportsImageDetailOriginal;

	const supportsCustomToolCalls = options.model.applyPatchToolType === "freeform";
	const customToolWireNameMap = supportsCustomToolCalls
		? undefined
		: buildCustomToolWireNameMap(options.context.tools);
	let knownCallIds = new Set<string>();
	const customCallIds = new Set<string>();
	const computerCallIds = new Set<string>();
	const transformedMessages = transformMessages(
		options.context.messages,
		options.model,
		normalizeResponsesToolCallIdForTransform,
	);
	const filterReasoning = <T extends { type?: string }>(items: T[]): T[] =>
		options.nativeHistory?.filterReasoning ? items.filter(item => item?.type !== "reasoning") : items;
	const includeThinkingSignatures = options.includeThinkingSignatures ?? options.nativeHistory?.replay ?? true;

	const escapeControlTokens = isHarmonyDialectModel(options.model);

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user" || msg.role === "developer") {
			const providerPayload = (msg as { providerPayload?: AssistantMessage["providerPayload"] }).providerPayload;
			const historyItems = options.nativeHistory
				? getOpenAIResponsesHistoryItems(providerPayload, options.model.provider)
				: undefined;
			const shouldReplayPayloadItems =
				options.nativeHistory?.replay ||
				(historyItems?.some(item => {
					if (!item || typeof item !== "object") return false;
					const candidate = item as { type?: unknown };
					return candidate.type === "compaction" || candidate.type === "compaction_summary";
				}) ??
					false);
			if (historyItems && shouldReplayPayloadItems) {
				const sanitizedItems = sanitizeOpenAIResponsesHistoryItemsForReplay(filterReasoning(historyItems), {
					supportsImageDetailOriginal,
					supportsComputerUse: options.model.supportsComputerUse === true,
				});
				const replayItems = adaptResponsesReplayItemsForModel(
					sanitizedItems,
					supportsCustomToolCalls,
					customToolWireNameMap,
					options.model.supportsComputerUse === true,
				);
				messages.push(...(escapeControlTokens ? escapeReplayedControlTokens(replayItems) : replayItems));
				knownCallIds = collectKnownCallIds(messages);
				for (const id of collectCustomCallIds(messages)) customCallIds.add(id);
				for (const id of collectComputerCallIds(messages)) computerCallIds.add(id);
				msgIndex++;
				continue;
			}
			const content = convertResponsesInputContent(
				msg.content,
				options.model.input.includes("image"),
				supportsImageDetailOriginal,
				escapeControlTokens,
			);
			if (!content) continue;
			const developerText =
				options.developerStringContent && msg.role === "developer" && typeof msg.content === "string"
					? msg.content.toWellFormed()
					: undefined;
			messages.push({
				role: "user",
				content:
					developerText !== undefined
						? escapeControlTokens
							? escapeHarmonyControlTokens(developerText)
							: developerText
						: content,
			});
		} else if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;

			const providerPayload =
				assistantMsg.api === options.model.api && assistantMsg.model === options.model.id
					? getOpenAIResponsesHistoryPayload(
							assistantMsg.providerPayload,
							options.model.provider,
							assistantMsg.provider,
						)
					: undefined;
			const nativeReplayEnabled = options.nativeHistory?.replay === true;
			const historyItems = providerPayload?.items;
			let suppressHiddenEmptyFallback = false;
			if (historyItems) {
				const rawSanitizedHistoryItems = sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(
					filterReasoning(historyItems),
					{
						supportsImageDetailOriginal,
						supportsComputerUse: options.model.supportsComputerUse === true,
					},
				);
				const sanitizedHistoryItems = rawSanitizedHistoryItems
					? adaptResponsesReplayItemsForModel(
							rawSanitizedHistoryItems,
							supportsCustomToolCalls,
							customToolWireNameMap,
							options.model.supportsComputerUse === true,
						)
					: undefined;
				if (nativeReplayEnabled && sanitizedHistoryItems) {
					const wireItems = escapeControlTokens
						? escapeReplayedControlTokens(sanitizedHistoryItems)
						: sanitizedHistoryItems;
					if (providerPayload?.dt) {
						messages.push(...wireItems);
					} else {
						messages.splice(0, messages.length, ...wireItems);
						customCallIds.clear();
						computerCallIds.clear();
					}
					knownCallIds = collectKnownCallIds(messages);
					for (const id of collectCustomCallIds(messages)) customCallIds.add(id);
					for (const id of collectComputerCallIds(messages)) computerCallIds.add(id);
					msgIndex++;
					continue;
				}
				if (!sanitizedHistoryItems) suppressHiddenEmptyFallback = true;
			}

			const convertedOutputItems = convertResponsesAssistantMessage(
				assistantMsg,
				options.model,
				msgIndex,
				knownCallIds,
				suppressHiddenEmptyFallback ? false : includeThinkingSignatures,
				customCallIds,
				options.preserveAssistantMessageIds,
				supportsCustomToolCalls,
				customToolWireNameMap,
				computerCallIds,
				options.requiresReasoningReplayForAllTurns ?? false,
				options.requiresReasoningReplayForToolCalls ?? false,
			);
			const outputItems = suppressHiddenEmptyFallback
				? sanitizeOpenAIResponsesAssistantFallbackItemsForReplay(convertedOutputItems)
				: convertedOutputItems;
			if (outputItems.length === 0) continue;
			messages.push(...(escapeControlTokens ? escapeReplayedControlTokens(outputItems) : outputItems));
		} else if (msg.role === "toolResult") {
			appendResponsesToolResultMessages(
				messages,
				msg,
				options.model,
				options.strictResponsesPairing,
				supportsImageDetailOriginal,
				knownCallIds,
				customCallIds,
				supportsCustomToolCalls,
				computerCallIds,
			);
		}
		msgIndex++;
	}

	const hoisted = hoistInterleavedResponsesToolBatchMessages(messages);
	const withRepairedOutputs = options.repairOrphanOutputs ? repairOrphanResponsesToolOutputs(hoisted) : hoisted;
	const withRepairedCalls = repairOrphanResponsesToolCalls(withRepairedOutputs);
	return stripUnpairedOpenAIResponsesComputerReasoningIdsForReplay(withRepairedCalls);
}

type ResponsesReplayAssistantMessage = Omit<ResponseOutputMessage, "id"> & { id?: string };

function parseResponseReasoningReplayItem(signature: string | undefined): ResponseReasoningItem | undefined {
	if (!signature) return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;
		if (!("type" in parsed) || parsed.type !== "reasoning") return undefined;
		if (!("id" in parsed) || typeof parsed.id !== "string") return undefined;
		return parsed as ResponseReasoningItem;
	} catch {
		return undefined;
	}
}

export function convertResponsesAssistantMessage<TApi extends Api>(
	assistantMsg: AssistantMessage,
	model: Model<TApi>,
	msgIndex: number,
	knownCallIds: Set<string>,
	includeThinkingSignatures = true,
	customCallIds?: Set<string>,
	preserveMessageIds = false,
	supportsCustomToolCalls = true,
	customToolWireNameMap?: ReadonlyMap<string, string>,
	computerCallIds?: Set<string>,
	requiresReasoningReplayForAllTurns = false,
	requiresReasoningReplayForToolCalls = false,
): ResponseInput {
	const outputItems: ResponseInput = [];
	let unsignedTextBlocks = 0;
	const hasReplayableReasoningItem =
		includeThinkingSignatures &&
		assistantMsg.stopReason !== "error" &&
		assistantMsg.content.some(
			block => block.type === "thinking" && parseResponseReasoningReplayItem(block.thinkingSignature) !== undefined,
		);
	const isDifferentModel =
		assistantMsg.model !== model.id && assistantMsg.provider === model.provider && assistantMsg.api === model.api;

	const requiresReasoningItem =
		assistantMsg.stopReason !== "error" &&
		(requiresReasoningReplayForAllTurns ||
			(requiresReasoningReplayForToolCalls && assistantMsg.content.some(block => block.type === "toolCall")));
	let reasoningItemEmitted = false;
	const carriedReasoningTexts: string[] = [];
	let synthesizedReasoningItemId: string | undefined;

	for (const block of assistantMsg.content) {
		if (block.type === "thinking" && assistantMsg.stopReason !== "error") {
			if (requiresReasoningItem) {
				if (block.itemId) synthesizedReasoningItemId ??= block.itemId;
				if (block.thinking.trim().length > 0) carriedReasoningTexts.push(block.thinking);
			}
			if (!includeThinkingSignatures) {
				continue;
			}
			const reasoningItem = parseResponseReasoningReplayItem(block.thinkingSignature);
			if (reasoningItem) {
				outputItems.push(reasoningItem);
				reasoningItemEmitted = true;
			}
			continue;
		}

		if (block.type === "text") {
			const parsedSignature = parseTextSignature(block.textSignature);
			let msgId = parsedSignature?.id;
			if (!msgId) {
				if (hasReplayableReasoningItem) {
					msgId = unsignedTextBlocks === 0 ? `msg_${msgIndex}` : `msg_${msgIndex}_${unsignedTextBlocks}`;
					unsignedTextBlocks += 1;
				}
			} else if (!preserveMessageIds && !hasReplayableReasoningItem) {
				msgId = undefined;
			} else if (msgId.length > 64) {
				msgId = `msg_${Bun.hash(msgId).toString(36)}`;
			}
			const messageItem: ResponsesReplayAssistantMessage = {
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: block.text.toWellFormed(), annotations: [] }],
				status: "completed",
				...(msgId ? { id: msgId } : {}),
				...(parsedSignature?.phase ? { phase: parsedSignature.phase } : {}),
			};
			outputItems.push(messageItem as ResponseInput[number]);
			continue;
		}

		if (block.type !== "toolCall") {
			continue;
		}

		if (block.providerMetadata?.type === "computer") {
			if (model.supportsComputerUse !== true) {
				const callId = normalizeResponsesToolCallId(block.id, "ctc").callId;
				outputItems.push({
					type: "message",
					role: "assistant",
					content: `[Previous computer call; call_id=${callId}]: ${stringifyJson(block.providerMetadata.actions) ?? ""}`,
				} as ResponseInput[number]);
				continue;
			}
			const normalized = normalizeResponsesToolCallId(block.id, "ctc");
			knownCallIds.add(normalized.callId);
			computerCallIds?.add(normalized.callId);
			outputItems.push({
				type: "computer_call",
				id: block.providerMetadata.providerItemId,
				call_id: normalized.callId,
				actions: structuredCloneJSON(block.providerMetadata.actions),
				pending_safety_checks: structuredCloneJSON(block.providerMetadata.pendingSafetyChecks),
				status: "completed",
			} as ResponseInput[number]);
			continue;
		}
		const normalized = normalizeResponsesToolCallId(block.id, block.customWireName ? "ctc" : "fc");
		let itemId: string | undefined = normalized.itemId;
		if (
			!hasReplayableReasoningItem &&
			(itemId?.startsWith("fc_") || itemId?.startsWith("fcr_") || itemId?.startsWith("ctc_"))
		) {
			itemId = undefined;
		} else if (
			isDifferentModel &&
			(itemId?.startsWith("fc_") || itemId?.startsWith("fcr_") || itemId?.startsWith("ctc_"))
		) {
			itemId = undefined;
		}
		knownCallIds.add(normalized.callId);
		if (block.customWireName && supportsCustomToolCalls) {
			const rawInput = typeof block.arguments?.input === "string" ? block.arguments.input : "";
			customCallIds?.add(normalized.callId);
			outputItems.push({
				type: "custom_tool_call",
				...(itemId ? { id: itemId } : {}),
				call_id: normalized.callId,
				name: block.customWireName,
				input: rawInput,
			} as ResponseInput[number]);
			continue;
		}
		const functionName =
			block.customWireName && !supportsCustomToolCalls
				? resolveReplayCustomToolName(block.customWireName, customToolWireNameMap)
				: block.name;
		outputItems.push({
			type: "function_call",
			...(itemId ? { id: itemId } : {}),
			call_id: normalized.callId,
			name: functionName,
			arguments: stringifyJson(block.arguments) ?? "null",
		});
	}

	if (requiresReasoningItem && !reasoningItemEmitted && outputItems.length > 0) {
		const reasoningText = carriedReasoningTexts.join("\n");
		const reasoningId =
			synthesizedReasoningItemId ?? `rs_${Bun.hash(`${model.id}:${msgIndex}:${reasoningText}`).toString(36)}`;
		const reasoningItem: ResponseReasoningItem = {
			type: "reasoning",
			id: reasoningId,
			summary: [],
			content: [{ type: "reasoning_text", text: reasoningText }],
		};
		outputItems.unshift(reasoningItem);
	}

	return outputItems;
}

const syntheticToolImageMessages = new WeakSet<object>();

function insertResponsesToolOutput(messages: ResponseInput, output: ResponseInput[number]): void {
	let index = messages.length;
	while (index > 0) {
		const previous = messages[index - 1];
		if (typeof previous !== "object" || previous === null || !syntheticToolImageMessages.has(previous)) {
			break;
		}
		index -= 1;
	}
	messages.splice(index, 0, output);
}

export function appendResponsesToolResultMessages<TApi extends Api>(
	messages: ResponseInput,
	toolResult: ToolResultMessage,
	model: Model<TApi>,
	strictResponsesPairing: boolean,
	supportsImageDetailOriginal: boolean,
	knownCallIds: ReadonlySet<string>,
	customCallIds?: ReadonlySet<string>,
	supportsCustomToolCalls = true,
	computerCallIds?: ReadonlySet<string>,
): void {
	const supportsImages = model.input.includes("image");
	const textResult = toolResult.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
	const hasImages = toolResult.content.some((block): block is ImageContent => block.type === "image");
	const omittedImages = hasImages && !supportsImages;
	const normalized = normalizeResponsesToolCallId(toolResult.toolCallId);

	const rawOutput = (
		omittedImages
			? joinTextWithImagePlaceholder(textResult, true)
			: textResult.length > 0
				? textResult
				: hasImages
					? "(see attached image)"
					: ""
	).toWellFormed();

	const output = isHarmonyDialectModel(model) ? escapeHarmonyControlTokens(rawOutput) : rawOutput;
	if (toolResult.providerMetadata?.type === "computer" && model.supportsComputerUse !== true) {
		messages.push({
			type: "message",
			role: "assistant",
			content: `[Previous computer result; call_id=${normalized.callId}]: ${stringifyJson(toolResult.providerMetadata.screenshot) ?? ""}`,
		} as ResponseInput[number]);
		return;
	}
	if (computerCallIds?.has(normalized.callId)) {
		if (toolResult.providerMetadata?.type !== "computer") {
			const limit = 16_000;
			const noteText = output.length > limit ? `${output.slice(0, limit)}\n...[truncated]` : output;
			messages.push({
				type: "message",
				role: "assistant",
				content: `[Computer tool failed before a screenshot was produced; call_id=${normalized.callId}]: ${noteText}`,
			} as ResponseInput[number]);
			return;
		}
		if (strictResponsesPairing && !knownCallIds.has(normalized.callId)) {
			messages.push({
				type: "message",
				role: "assistant",
				content: `[Orphan computer result; call_id=${normalized.callId}]`,
			} as ResponseInput[number]);
			return;
		}
		insertResponsesToolOutput(messages, {
			type: "computer_call_output",
			call_id: normalized.callId,
			output: structuredCloneJSON(toolResult.providerMetadata.screenshot),
			acknowledged_safety_checks: structuredCloneJSON(toolResult.providerMetadata.acknowledgedSafetyChecks),
		} as ResponseInput[number]);
		return;
	}
	if (strictResponsesPairing && !knownCallIds.has(normalized.callId)) {
		const limit = 16_000;
		const noteText = output.length > limit ? `${output.slice(0, limit)}\n...[truncated]` : output;
		messages.push({
			type: "message",
			role: "assistant",
			content: `[Orphan ${toolResult.toolName || "tool"} result; call_id=${normalized.callId}]: ${noteText}`,
		} as ResponseInput[number]);
		return;
	}
	if (supportsCustomToolCalls && customCallIds?.has(normalized.callId)) {
		insertResponsesToolOutput(messages, {
			type: "custom_tool_call_output",
			call_id: normalized.callId,
			output,
		} as ResponseInput[number]);
	} else {
		insertResponsesToolOutput(messages, {
			type: "function_call_output",
			call_id: normalized.callId,
			output,
		});
	}

	if (!hasImages || !supportsImages) {
		return;
	}

	const contentParts: ResponseInputContent[] = [
		{ type: "input_text", text: "Attached image(s) from tool result:" } satisfies ResponseInputText,
	];
	for (const block of toolResult.content) {
		if (block.type === "image") {
			contentParts.push(convertResponsesInputImage(block, supportsImageDetailOriginal));
		}
	}
	const imageMessage = { role: "user", content: contentParts } satisfies ResponseInput[number];
	syntheticToolImageMessages.add(imageMessage);
	messages.push(imageMessage);
}

type ResponsesToolCallBlock = ToolCall & { [kStreamingPartialJson]: string; [kStreamingLastParseLen]?: number };

function ensureReasoningSummaryPart(
	item: ResponseReasoningItem,
	summaryIndex: number,
): ResponseReasoningItem["summary"][number] {
	item.summary = item.summary || [];
	while (item.summary.length <= summaryIndex) {
		item.summary.push({ type: "summary_text", text: "" });
	}
	return item.summary[summaryIndex]!;
}

export function appendReasoningSummaryPart(
	item: ResponseReasoningItem,
	part: ResponseReasoningItem["summary"][number],
): void {
	item.summary = item.summary || [];
	item.summary.push(part);
}

export interface SequentialCutoffSummaryState {
	summary: ResponseReasoningItem["summary"];

	emitted: string;
}

export function createSequentialCutoffSummaryState(): SequentialCutoffSummaryState {
	return { summary: [], emitted: "" };
}

function foldReasoningSummary(parts: ResponseReasoningItem["summary"] | undefined): string {
	if (!parts) return "";
	let canonical = "";
	for (const part of parts) {
		const text = part.text;
		if (!text || text === canonical) continue;
		const extendsCanonical = text.startsWith(canonical) && text[canonical.length] === "\n";
		canonical = !canonical || extendsCanonical ? text : `${canonical}\n\n${text}`;
	}
	return canonical;
}

export function finalizeReasoningThinking(
	item: ResponseReasoningItem,
	streamedThinking: string,
	cutoff?: SequentialCutoffSummaryState,
): string {
	if (cutoff) return finalizeCutoffReasoningThinking(item, streamedThinking, cutoff);
	const summaryThinking = item.summary?.map(part => part.text).join("\n\n") ?? "";
	if (summaryThinking) return summaryThinking;
	const contentThinking = item.content?.[0]?.type === "reasoning_text" ? (item.content[0].text ?? "") : "";
	return contentThinking || streamedThinking || "";
}

function finalizeCutoffReasoningThinking(
	item: ResponseReasoningItem,
	streamedThinking: string,
	cutoff: SequentialCutoffSummaryState,
): string {
	if (streamedThinking) return streamedThinking;
	const summaryThinking = foldReasoningSummary(item.summary);
	if (summaryThinking) {
		if (cutoff.emitted.startsWith(summaryThinking)) return "";
		if (!cutoff.emitted || summaryThinking.startsWith(cutoff.emitted)) {
			const suffix = summaryThinking.slice(cutoff.emitted.length).replace(/^\n+/, "");

			cutoff.summary = item.summary?.map(part => ({ ...part })) ?? [];
			cutoff.emitted = summaryThinking;
			return suffix;
		}

		return "";
	}
	return item.content?.[0]?.type === "reasoning_text" ? (item.content[0].text ?? "") : "";
}

export function appendReasoningSummaryTextDelta(
	item: ResponseReasoningItem,
	block: ThinkingContent,
	delta: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
	summaryIndex = 0,
): void {
	const part = ensureReasoningSummaryPart(item, summaryIndex);
	block.thinking += delta;
	part.text += delta;
	stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
}

export function applyReasoningSummaryTextDone(
	item: ResponseReasoningItem,
	block: ThinkingContent,
	text: string,
	summaryIndex: number,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	const part = ensureReasoningSummaryPart(item, summaryIndex);
	const previous = part.text;
	part.text = text;
	if (!text || text === previous) return;
	if (!block.thinking) {
		block.thinking = text;
		stream.push({ type: "thinking_delta", contentIndex, delta: text, partial: output });
		return;
	}
	if (text.startsWith(block.thinking)) {
		const delta = text.slice(block.thinking.length);
		if (!delta) return;
		block.thinking += delta;
		stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
	}
}

export function appendReasoningSummaryPartDone(
	item: ResponseReasoningItem,
	block: ThinkingContent,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	item.summary = item.summary || [];
	const lastPart = item.summary[item.summary.length - 1];
	if (!lastPart) return;
	block.thinking += "\n\n";
	lastPart.text += "\n\n";
	stream.push({ type: "thinking_delta", contentIndex, delta: "\n\n", partial: output });
}

export function applyReasoningSummaryDone(
	state: SequentialCutoffSummaryState,
	block: ThinkingContent,
	text: string,
	summaryIndex: number,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	while (state.summary.length <= summaryIndex) {
		state.summary.push({ type: "summary_text", text: "" });
	}
	state.summary[summaryIndex].text = text;
	const after = foldReasoningSummary(state.summary);
	if (!after.startsWith(state.emitted)) return;
	let delta = after.slice(state.emitted.length);
	if (!delta) return;
	state.emitted = after;

	if (!block.thinking) delta = delta.replace(/^\n+/, "");
	if (!delta) return;
	block.thinking += delta;
	stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
}

export function appendMessageContentPart(
	item: ResponseOutputMessage,
	part: ResponseContentPartAddedEvent["part"] | undefined,
): void {
	item.content = item.content || [];
	if (part && (part.type === "output_text" || part.type === "refusal")) {
		item.content.push(part);
	}
}

export function appendMessageTextDelta(
	item: ResponseOutputMessage,
	block: TextContent,
	delta: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
	partType: "output_text" | "refusal",
): void {
	item.content = item.content || [];
	let lastPart = item.content[item.content.length - 1];
	if (lastPart?.type !== partType) {
		lastPart =
			partType === "output_text"
				? { type: "output_text", text: "", annotations: [] }
				: { type: "refusal", refusal: "" };
		item.content.push(lastPart);
	}
	block.text += delta;
	if (lastPart.type === "output_text") {
		lastPart.text += delta;
	} else {
		lastPart.refusal += delta;
	}
	stream.push({ type: "text_delta", contentIndex, delta, partial: output });
}

export function finalizeMessageText(item: ResponseOutputMessage, streamedText: string): string {
	if (!item.content?.length) return streamedText || "";
	return item.content.map(part => (part.type === "output_text" ? (part.text ?? "") : (part.refusal ?? ""))).join("");
}
export const JUICE_EFFORT_MAP: Record<string, number> = {
	none: 0,
	minimal: 2,
	low: 4,
	medium: 8,
	high: 48,
	xhigh: 112,
	max: 960,
};

export function getJuiceValue(effort?: string): number {
	if (!effort) return 8;
	return JUICE_EFFORT_MAP[effort] ?? 8;
}

export function accumulateToolCallArgumentsDelta(
	block: ResponsesToolCallBlock,
	delta: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	block[kStreamingPartialJson] += delta;
	const throttled = parseStreamingJsonThrottled(block[kStreamingPartialJson], block[kStreamingLastParseLen] ?? 0);
	if (throttled) {
		block.arguments = throttled.value;
		block[kStreamingLastParseLen] = throttled.parsedLen;
	}
	stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
}

export function finalizeToolCallArgumentsDone(block: ResponsesToolCallBlock, args: string): void {
	block[kStreamingPartialJson] = args;
	block.arguments = parseStreamingJson(block[kStreamingPartialJson]);
	clearStreamingPartialJson(block);
}

export function accumulateCustomToolCallInputDelta(
	block: ResponsesToolCallBlock,
	delta: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	block[kStreamingPartialJson] += delta;
	block.arguments = { input: block[kStreamingPartialJson] };
	stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
}

export function finalizeCustomToolCallInputDone(block: ResponsesToolCallBlock, input: string): void {
	block.arguments = { input };
}

type OpenAIResponsesTerminalStreamEvent =
	| Extract<ResponseStreamEvent, { type: "response.completed" | "response.incomplete" }>
	| { type: "response.done"; response?: Partial<OpenAIResponse> };

function getOpenAIResponsesTerminalEvent(event: ResponseStreamEvent): OpenAIResponsesTerminalStreamEvent | undefined {
	const type = (event as { type?: unknown }).type;
	return type === "response.completed" || type === "response.incomplete" || type === "response.done"
		? (event as OpenAIResponsesTerminalStreamEvent)
		: undefined;
}

export interface ProcessResponsesStreamOptions {
	onFirstToken?: () => void;
	onOutputItemDone?: (item: ResponseOutputItem) => void;

	onCompleted?: () => void;

	requestServiceTier?: ServiceTier;
}

export function computerCallMetadata(item: ResponseComputerToolCall): ComputerToolCallMetadata {
	const actions = item.actions?.length ? item.actions : item.action ? [item.action] : [];
	return {
		type: "computer",
		providerItemId: item.id,
		actions: structuredCloneJSON(actions) as ComputerAction[],
		pendingSafetyChecks: structuredCloneJSON(item.pending_safety_checks ?? []),
	};
}

export function appendResponsesImageResult(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	result: string,
): void {
	const image: ImageContent = {
		type: "image",
		data: result,
		mimeType: parseImageMetadata(Buffer.from(result, "base64"))?.mimeType ?? "image/png",
	};
	output.content.push(image);
	stream.push({
		type: "image_end",
		contentIndex: output.content.length - 1,
		content: image,
		partial: output,
	});
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: ProcessResponsesStreamOptions,
): Promise<void> {
	type StreamingToolCallBlock = ToolCall & {
		[kStreamingPartialJson]: string;
		[kStreamingLastParseLen]?: number;
		[kStreamingArgumentsDone]?: boolean;
	};
	interface StreamingItem {
		item:
			| ResponseReasoningItem
			| ResponseOutputMessage
			| ResponseFunctionToolCall
			| ResponseCustomToolCall
			| ResponseComputerToolCall;
		block: ThinkingContent | TextContent | StreamingToolCallBlock;
	}

	const openItemsByOutputIndex = new Map<number, StreamingItem>();
	const openItemsByItemId = new Map<string, StreamingItem>();
	const openItemsByPrefixedCallId = new Map<string, StreamingItem>();
	let lastOpenItem: StreamingItem | null = null;
	const openItemsInOrder: StreamingItem[] = [];

	const prefixedFunctionCallItemKey = (callId: string | undefined): string | undefined =>
		callId ? `fc_${callId}` : undefined;

	const registerOpenItem = (
		outputIndex: number | undefined,
		itemId: string | undefined,
		entry: StreamingItem,
		alternateItemKey?: string,
		prefixedAlternateItemKey?: string,
	): void => {
		if (typeof outputIndex === "number") openItemsByOutputIndex.set(outputIndex, entry);
		if (itemId) openItemsByItemId.set(itemId, entry);
		if (alternateItemKey && alternateItemKey !== itemId) openItemsByItemId.set(alternateItemKey, entry);
		if (
			prefixedAlternateItemKey &&
			prefixedAlternateItemKey !== itemId &&
			prefixedAlternateItemKey !== alternateItemKey
		) {
			openItemsByPrefixedCallId.set(prefixedAlternateItemKey, entry);
		}
		openItemsInOrder.push(entry);
		lastOpenItem = entry;
	};
	const lookupOpenItem = (event: { output_index?: number; item_id?: string }): StreamingItem | undefined => {
		const hasKey = typeof event.output_index === "number" || event.item_id !== undefined;
		if (typeof event.output_index === "number") {
			const found = openItemsByOutputIndex.get(event.output_index);
			if (found) return found;
		}
		if (event.item_id) {
			const found = openItemsByItemId.get(event.item_id);
			if (found) return found;
		}

		return hasKey ? undefined : (lastOpenItem ?? undefined);
	};
	const hasOpenItemKey = (event: { output_index?: number; item_id?: string }): boolean =>
		typeof event.output_index === "number" || event.item_id !== undefined;
	const startsJsonObjectDelta = (delta: unknown): boolean => {
		if (typeof delta !== "string") return false;
		for (let index = 0; index < delta.length; index++) {
			const code = delta.charCodeAt(index);
			if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20) continue;
			return code === 0x7b;
		}
		return false;
	};
	const shouldAdvanceIdentifierlessFunctionDelta = (
		event: { output_index?: number; item_id?: string; delta?: unknown },
		candidate: StreamingItem,
	): boolean => {
		const delta = event.delta;
		if (
			hasOpenItemKey(event) ||
			typeof delta !== "string" ||
			!startsJsonObjectDelta(delta) ||
			candidate.item.type !== "function_call" ||
			candidate.block.type !== "toolCall"
		) {
			return false;
		}
		const partial = candidate.block[kStreamingPartialJson];
		if (partial.trim().length === 0) return false;

		const state = classifyJsonPrefix(partial);
		if (state !== "prefix") return true;
		return classifyJsonPrefix(partial + delta) === "invalid";
	};
	const hasLaterUnfinishedFunctionCall = (start: number): boolean => {
		for (let index = start + 1; index < openItemsInOrder.length; index++) {
			const candidate = openItemsInOrder[index];
			if (
				candidate?.item.type === "function_call" &&
				candidate.block.type === "toolCall" &&
				!candidate.block[kStreamingArgumentsDone]
			) {
				return true;
			}
		}
		return false;
	};

	let identifierlessFunctionDeltaTarget: StreamingItem | undefined;

	const lookupOpenToolCallAlias = (
		event: { output_index?: number; item_id?: string },
		type: "function_call" | "custom_tool_call",
	): StreamingItem | undefined => {
		if (typeof event.output_index === "number") {
			const byOutputIndex = openItemsByOutputIndex.get(event.output_index);
			if (byOutputIndex) return byOutputIndex;
		}
		if (event.item_id) {
			const alias = openItemsByPrefixedCallId.get(event.item_id);
			if (alias?.item.type === type) return alias;
			const exact = openItemsByItemId.get(event.item_id);
			if (exact) return exact;
		}
		return lookupOpenItem(event);
	};
	const lookupOpenFunctionCallItem = (event: {
		output_index?: number;
		item_id?: string;
		delta?: unknown;
	}): StreamingItem | undefined => {
		if (hasOpenItemKey(event)) return lookupOpenToolCallAlias(event, "function_call");
		const canContinuePreviousIdentifierlessDelta = typeof event.delta === "string";
		if (canContinuePreviousIdentifierlessDelta && identifierlessFunctionDeltaTarget) {
			const targetIndex = openItemsInOrder.indexOf(identifierlessFunctionDeltaTarget);
			const target = targetIndex >= 0 ? openItemsInOrder[targetIndex] : undefined;
			if (
				target?.item.type === "function_call" &&
				target.block.type === "toolCall" &&
				!target.block[kStreamingArgumentsDone]
			) {
				const shouldAdvanceFromTarget =
					shouldAdvanceIdentifierlessFunctionDelta(event, target) && hasLaterUnfinishedFunctionCall(targetIndex);
				if (!shouldAdvanceFromTarget) return target;
			} else {
				identifierlessFunctionDeltaTarget = undefined;
			}
		}
		let skippedStartedCandidate = false;
		for (let index = 0; index < openItemsInOrder.length; index++) {
			const candidate = openItemsInOrder[index]!;
			if (
				candidate.item.type === "function_call" &&
				candidate.block.type === "toolCall" &&
				!candidate.block[kStreamingArgumentsDone]
			) {
				if (shouldAdvanceIdentifierlessFunctionDelta(event, candidate) && hasLaterUnfinishedFunctionCall(index)) {
					skippedStartedCandidate = true;
					continue;
				}
				if (canContinuePreviousIdentifierlessDelta) identifierlessFunctionDeltaTarget = candidate;
				return candidate;
			}
		}
		if (skippedStartedCandidate && startsJsonObjectDelta(event.delta)) return undefined;
		return lastOpenItem?.item.type === "function_call" ? lastOpenItem : undefined;
	};
	const closeOpenItem = (
		outputIndex: number | undefined,
		itemId: string | undefined,
		entry: StreamingItem | undefined,
		alternateItemKey?: string,
		prefixedAlternateItemKey?: string,
	): void => {
		if (typeof outputIndex === "number") openItemsByOutputIndex.delete(outputIndex);
		if (itemId) openItemsByItemId.delete(itemId);
		if (alternateItemKey && alternateItemKey !== itemId) openItemsByItemId.delete(alternateItemKey);
		if (
			prefixedAlternateItemKey &&
			prefixedAlternateItemKey !== itemId &&
			prefixedAlternateItemKey !== alternateItemKey &&
			openItemsByPrefixedCallId.get(prefixedAlternateItemKey) === entry
		) {
			openItemsByPrefixedCallId.delete(prefixedAlternateItemKey);
		}
		if (entry) {
			const index = openItemsInOrder.indexOf(entry);
			if (index >= 0) openItemsInOrder.splice(index, 1);
		}
		if (entry && identifierlessFunctionDeltaTarget === entry) identifierlessFunctionDeltaTarget = undefined;
		if (entry && lastOpenItem === entry) lastOpenItem = null;
	};
	const contentIndexOf = (block: ThinkingContent | TextContent | StreamingToolCallBlock): number =>
		output.content.indexOf(block);

	let sawFirstToken = false;

	let sawCompletedWebSearchCall = false;

	for await (const event of openaiStream) {
		const terminalEvent = getOpenAIResponsesTerminalEvent(event);
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			if (!sawFirstToken) {
				sawFirstToken = true;
				options?.onFirstToken?.();
			}
			const item = event.item;
			if (item.type === "reasoning") {
				const block: ThinkingContent = { type: "thinking", thinking: "", itemId: item.id };
				output.content.push(block);
				registerOpenItem(event.output_index, item.id, { item, block });
				stream.push({ type: "thinking_start", contentIndex: contentIndexOf(block), partial: output });
			} else if (item.type === "message") {
				const block: TextContent = {
					type: "text",
					text: "",
					textSignature: encodeTextSignatureV1(item.id, item.phase ?? undefined),
				};
				output.content.push(block);
				registerOpenItem(event.output_index, item.id, { item, block });
				stream.push({ type: "text_start", contentIndex: contentIndexOf(block), partial: output });
			} else if (item.type === "function_call") {
				const block: StreamingToolCallBlock = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: {},
					[kStreamingPartialJson]: item.arguments || "",
				};
				output.content.push(block);
				registerOpenItem(
					event.output_index,
					item.id,
					{ item, block },
					item.call_id,
					prefixedFunctionCallItemKey(item.call_id),
				);
				stream.push({ type: "toolcall_start", contentIndex: contentIndexOf(block), partial: output });
			} else if (item.type === "computer_call") {
				const block: StreamingToolCallBlock = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: "computer",
					arguments: {},
					providerMetadata: computerCallMetadata(item),
					[kStreamingPartialJson]: "",
				};
				output.content.push(block);
				registerOpenItem(event.output_index, item.id, { item, block }, item.call_id);
				stream.push({ type: "toolcall_start", contentIndex: contentIndexOf(block), partial: output });
			} else if (item.type === "custom_tool_call") {
				const block: StreamingToolCallBlock = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),

					name: item.name,
					arguments: { input: item.input ?? "" },
					customWireName: item.name,

					[kStreamingPartialJson]: item.input ?? "",
				};
				output.content.push(block);
				registerOpenItem(
					event.output_index,
					item.id,
					{ item, block },
					item.call_id,
					prefixedFunctionCallItemKey(item.call_id),
				);
				stream.push({ type: "toolcall_start", contentIndex: contentIndexOf(block), partial: output });
			}
		} else if (event.type === "response.reasoning_summary_part.added") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning") appendReasoningSummaryPart(entry.item, event.part);
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				appendReasoningSummaryTextDelta(
					entry.item,
					entry.block,
					event.delta,
					stream,
					output,
					contentIndexOf(entry.block),
					event.summary_index,
				);
			}
		} else if (event.type === "response.reasoning_summary_text.done") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				applyReasoningSummaryTextDone(
					entry.item,
					entry.block,
					event.text,
					event.summary_index,
					stream,
					output,
					contentIndexOf(entry.block),
				);
			}
		} else if (event.type === "response.reasoning_summary_part.done") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				appendReasoningSummaryPartDone(entry.item, entry.block, stream, output, contentIndexOf(entry.block));
			}
		} else if (event.type === "response.reasoning_text.delta") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				entry.block.thinking += event.delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: contentIndexOf(entry.block),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.content_part.added") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "message") appendMessageContentPart(entry.item, event.part);
		} else if (event.type === "response.output_text.delta") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "message" && entry.block.type === "text") {
				appendMessageTextDelta(
					entry.item,
					entry.block,
					event.delta,
					stream,
					output,
					contentIndexOf(entry.block),
					"output_text",
				);
			}
		} else if (event.type === "response.refusal.delta") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "message" && entry.block.type === "text") {
				appendMessageTextDelta(
					entry.item,
					entry.block,
					event.delta,
					stream,
					output,
					contentIndexOf(entry.block),
					"refusal",
				);
			}
		} else if (event.type === "response.function_call_arguments.delta") {
			const entry = lookupOpenFunctionCallItem(event);
			if (entry?.item.type === "function_call" && entry.block.type === "toolCall") {
				accumulateToolCallArgumentsDelta(entry.block, event.delta, stream, output, contentIndexOf(entry.block));
			}
		} else if (event.type === "response.function_call_arguments.done") {
			const entry = lookupOpenFunctionCallItem(event);
			if (entry?.item.type === "function_call" && entry.block.type === "toolCall") {
				finalizeToolCallArgumentsDone(entry.block, event.arguments);
				entry.block[kStreamingArgumentsDone] = true;
			}
		} else if (event.type === "response.custom_tool_call_input.delta") {
			const entry = lookupOpenToolCallAlias(event, "custom_tool_call");
			if (entry?.item.type === "custom_tool_call" && entry.block.type === "toolCall") {
				accumulateCustomToolCallInputDelta(entry.block, event.delta, stream, output, contentIndexOf(entry.block));
			}
		} else if (event.type === "response.custom_tool_call_input.done") {
			const entry = lookupOpenToolCallAlias(event, "custom_tool_call");
			if (entry?.item.type === "custom_tool_call" && entry.block.type === "toolCall") {
				finalizeCustomToolCallInputDone(entry.block, event.input);
				entry.block[kStreamingArgumentsDone] = true;
			}
		} else if (event.type === "response.output_item.done") {
			const item = structuredCloneJSON(event.item);
			options?.onOutputItemDone?.(item);
			const entry =
				item.type === "function_call" || item.type === "custom_tool_call"
					? lookupOpenItem({ output_index: event.output_index, item_id: item.id ?? item.call_id })
					: lookupOpenItem({ output_index: event.output_index, item_id: item.id });
			if (item.type === "reasoning") {
				const reasoningBlock =
					entry?.block.type === "thinking"
						? entry.block
						: (output.content.find(b => b.type === "thinking" && (b as ThinkingContent).itemId === item.id) as
								| ThinkingContent
								| undefined);
				if (reasoningBlock) {
					reasoningBlock.thinking = finalizeReasoningThinking(item, reasoningBlock.thinking);
					reasoningBlock.thinkingSignature = JSON.stringify(item);
					stream.push({
						type: "thinking_end",
						contentIndex: contentIndexOf(reasoningBlock),
						content: reasoningBlock.thinking,
						partial: output,
					});
				}
				closeOpenItem(event.output_index, item.id, entry);
			} else if (item.type === "message") {
				const block = entry?.block.type === "text" ? entry.block : undefined;
				const text = finalizeMessageText(item, block?.text ?? "");
				const textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				let contentIndex: number;
				if (block) {
					block.text = text;
					block.textSignature = textSignature;
					contentIndex = contentIndexOf(block);
				} else {
					const synthesized: TextContent = { type: "text", text, textSignature };
					output.content.push(synthesized);
					contentIndex = output.content.length - 1;
				}
				stream.push({ type: "text_end", contentIndex, content: text, partial: output });
				closeOpenItem(event.output_index, item.id, entry);
			} else if (item.type === "function_call") {
				const block = entry?.block.type === "toolCall" ? entry.block : undefined;
				const args = block?.[kStreamingArgumentsDone]
					? block.arguments
					: item.arguments
						? parseStreamingJson(item.arguments)
						: block?.[kStreamingPartialJson]
							? parseStreamingJson(block[kStreamingPartialJson])
							: parseStreamingJson("{}");
				const toolCall: ToolCall = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: args,
				};
				let contentIndex: number;
				if (block) {
					block.arguments = args;
					clearStreamingPartialJson(block);
					contentIndex = contentIndexOf(block);
				} else {
					output.content.push(toolCall);
					contentIndex = output.content.length - 1;
				}
				closeOpenItem(event.output_index, item.id, entry, item.call_id, prefixedFunctionCallItemKey(item.call_id));
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			} else if (item.type === "computer_call") {
				const block = entry?.block.type === "toolCall" ? entry.block : undefined;
				const toolCall: ToolCall = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: "computer",
					arguments: {},
					providerMetadata: computerCallMetadata(item),
				};
				let contentIndex: number;
				if (block) {
					block.id = toolCall.id;
					block.providerMetadata = toolCall.providerMetadata;
					clearStreamingPartialJson(block);
					contentIndex = contentIndexOf(block);
				} else {
					output.content.push(toolCall);
					contentIndex = output.content.length - 1;
				}
				closeOpenItem(event.output_index, item.id, entry, item.call_id);
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			} else if (item.type === "custom_tool_call") {
				const block = entry?.block.type === "toolCall" ? entry.block : undefined;
				const rawInput = block?.[kStreamingPartialJson] ? block[kStreamingPartialJson] : (item.input ?? "");
				const toolCall: ToolCall = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: { input: rawInput },
					customWireName: item.name,
				};
				let contentIndex: number;
				if (block) {
					block.arguments = { input: rawInput };
					clearStreamingPartialJson(block);
					contentIndex = contentIndexOf(block);
				} else {
					output.content.push(toolCall);
					contentIndex = output.content.length - 1;
				}
				closeOpenItem(event.output_index, item.id, entry, item.call_id, prefixedFunctionCallItemKey(item.call_id));
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			} else if (item.type === "web_search_call" && (item.status === undefined || item.status === "completed")) {
				sawCompletedWebSearchCall = true;
			} else if (item.type === "image_generation_call" && item.status === "completed" && item.result) {
				appendResponsesImageResult(output, stream, item.result);
			}
		} else if (terminalEvent) {
			const response = terminalEvent.response;
			const shouldPromoteIncompleteToolUse =
				response?.status === "incomplete" &&
				response.incomplete_details?.reason === "max_output_tokens" &&
				hasExecutableIncompleteResponsesToolCalls(output);
			finalizePendingResponsesToolCalls(output);
			if (response?.id) {
				output.responseId = response.id;
			}
			populateResponsesUsageFromResponse(output, response?.usage);
			calculateCost(model, output.usage);
			applyOpenRouterReportedCost(model, output.usage, response?.usage);
			applyOpenAIResponsesServiceTierCost(
				model,
				output.usage,
				(response as { service_tier?: unknown } | undefined)?.service_tier,
				options?.requestServiceTier,
			);
			output.stopReason = mapOpenAIResponsesStopReason(response?.status);
			if (response?.status === "failed" || response?.status === "cancelled") {
				const error = response?.error ?? (response as any)?.status_details?.error;
				const details = response?.incomplete_details;
				const statusDetailsReason = (response as any)?.status_details?.reason;
				const message = error
					? `${error.code || "unknown"}: ${error.message || "no message"}`
					: details?.reason
						? `incomplete: ${details.reason}`
						: typeof statusDetailsReason === "string" && statusDetailsReason.length > 0
							? `status_details: ${statusDetailsReason}`
							: "Unknown error (no error details in response)";
				throw new AIError.ProviderResponseError(message, { provider: model.provider, kind: "output" });
			}
			if (response?.status === "incomplete" && response.incomplete_details?.reason === "content_filter") {
				throw new AIError.ProviderResponseError("incomplete: content_filter", {
					provider: model.provider,
					kind: "content-blocked",
				});
			}
			promoteResponsesToolUseStopReason(
				output,
				(response as { end_turn?: boolean } | undefined)?.end_turn,
				shouldPromoteIncompleteToolUse,
			);

			if (sawCompletedWebSearchCall && output.stopReason === "stop" && !hasVisibleAssistantContent(output)) {
				output.stopDetails = { type: "pause_turn" };
			}
			options?.onCompleted?.();

			break;
		} else if (event.type === "error") {
			const err = (event as any).error ?? event;
			const code = err.code ?? "unknown";
			const message = err.message ?? "no message";
			throw new AIError.ProviderResponseError(`Error Code ${code}: ${message}`, {
				provider: model.provider,
				kind: "output",
			});
		} else if (event.type === "response.failed") {
			populateResponsesUsageFromResponse(output, event.response?.usage);
			const error = event.response?.error ?? (event.response as any)?.status_details?.error;
			const details = event.response?.incomplete_details;
			const message = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new AIError.ProviderResponseError(message, { provider: model.provider, kind: "output" });
		}
	}
}

export function mapOpenAIResponsesStopReason(status: ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		case "in_progress":
		case "queued":
			return "stop";
		default: {
			const exhaustive: never = status;
			logger.warn("Unhandled OpenAI Responses stop reason", { status: exhaustive });
			return "stop";
		}
	}
}

export function hasExecutableIncompleteResponsesToolCalls(output: AssistantMessage): boolean {
	let hasToolCall = false;
	for (const block of output.content) {
		if (block.type !== "toolCall") continue;
		hasToolCall = true;
		const pending = block as ToolCall & {
			[kStreamingPartialJson]?: string;
			[kStreamingArgumentsDone]?: boolean;
		};
		if (pending.providerMetadata?.type === "computer") {
			if (pending.providerMetadata.actions.length === 0) return false;
			continue;
		}
		const rawArguments = pending[kStreamingPartialJson];

		if (pending[kStreamingArgumentsDone]) continue;
		if (pending.customWireName !== undefined || rawArguments === undefined) return false;
		if (classifyJsonPrefix(rawArguments) !== "complete") return false;
	}
	return hasToolCall;
}

export function finalizePendingResponsesToolCalls(output: AssistantMessage): void {
	for (const block of output.content) {
		if (block.type !== "toolCall") continue;
		const pending = block as ToolCall & {
			[kStreamingPartialJson]?: string;
			[kStreamingLastParseLen]?: number;
			[kStreamingArgumentsDone]?: boolean;
		};
		if (pending[kStreamingPartialJson] && !pending[kStreamingArgumentsDone]) {
			pending.arguments =
				pending.customWireName !== undefined
					? { input: pending[kStreamingPartialJson] }
					: parseStreamingJson(pending[kStreamingPartialJson]);
		}
		clearStreamingPartialJson(pending);
	}
}

export function promoteResponsesToolUseStopReason(
	output: AssistantMessage,
	endTurn: boolean | undefined,
	promoteIncompleteToolUse = false,
): void {
	if (
		output.content.some(block => block.type === "toolCall") &&
		(output.stopReason === "stop" || (promoteIncompleteToolUse && output.stopReason === "length"))
	) {
		output.stopReason = "toolUse";
	}
	if (endTurn === false && output.stopReason === "stop") {
		output.stopDetails = { type: "pause_turn" };
	}
}

export function createInitialResponsesAssistantMessage(api: Api, provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider,
		model: modelId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export type ResponsesSamplingParamsExtras = {
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
};

type CommonResponsesParams = ResponseCreateParamsStreaming & ResponsesSamplingParamsExtras;

type CommonSamplingOptions = Pick<
	StreamOptions,
	"temperature" | "topP" | "topK" | "minP" | "presencePenalty" | "repetitionPenalty" | "maxTokens"
> & { serviceTier?: ServiceTier };

export function applyCommonResponsesSamplingParams<P extends CommonResponsesParams>(
	params: P,
	options: CommonSamplingOptions | undefined,
	model: Pick<Model, "provider" | "api" | "id" | "omitMaxOutputTokens" | "maxTokens"> & {
		compat: Pick<ResolvedOpenAISharedCompat, "supportsSamplingParams" | "supportsPenaltyAndStopParams">;
	},
): void {
	if (options?.maxTokens && !model.omitMaxOutputTokens) {
		params.max_output_tokens = Math.min(
			options.maxTokens,
			model.maxTokens ?? Number.POSITIVE_INFINITY,
			resolveOpenAIResponsesOutputClamp(model) ?? OPENAI_MAX_OUTPUT_TOKENS,
		);
	}

	if (model.compat.supportsSamplingParams) {
		if (options?.temperature !== undefined) params.temperature = options.temperature;
		if (options?.topP !== undefined) params.top_p = options.topP;
		if (options?.topK !== undefined) params.top_k = options.topK;
		if (options?.minP !== undefined) params.min_p = options.minP;
		if (model.compat.supportsPenaltyAndStopParams) {
			if (options?.presencePenalty !== undefined) params.presence_penalty = options.presencePenalty;
			if (options?.repetitionPenalty !== undefined) params.repetition_penalty = options.repetitionPenalty;
		}
	}
	applyOpenAIServiceTier(params, options?.serviceTier, model);
}

type ReasoningOptions = {
	reasoning?: string;
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	disableReasoning?: boolean;
	toolChoice?: unknown;
};

export interface ApplyResponsesCompatPolicyOptions {
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	mapEffort?: (effort: string) => string;

	forceReasoningOff?: boolean;
}

export function applyResponsesCompatPolicy<P extends ResponseCreateParamsStreaming>(
	params: P,
	policy: OpenAICompatPolicy,
	options: ApplyResponsesCompatPolicyOptions | undefined,
): void {
	const reasoning = policy.reasoning;
	if (options?.forceReasoningOff) {
		params.reasoning = { effort: "none" } as P["reasoning"];
		return;
	}
	if (!reasoning.modelSupported) return;
	if (reasoning.includeEncryptedReasoning) {
		const include = params.include ?? [];
		if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
		params.include = include;
	}

	if (reasoning.disabled) {
		if (reasoning.disableMode === "openrouter-enabled-false") {
			params.reasoning = { enabled: false } as P["reasoning"];
			return;
		}
		if (
			(reasoning.disableMode === "lowest-effort" || reasoning.disableMode === "none-effort") &&
			reasoning.wireEffort !== undefined &&
			!reasoning.omitReasoningEffort
		) {
			type ReasoningParam = NonNullable<ResponseCreateParamsStreaming["reasoning"]>;
			params.reasoning = { effort: reasoning.wireEffort as ReasoningParam["effort"] } as P["reasoning"] &
				ReasoningParam;
			return;
		}
		return;
	}

	if (reasoning.requestedEffort !== undefined || options?.reasoningSummary !== undefined) {
		if (reasoning.omitReasoningEffort) {
			if (options?.reasoningSummary !== undefined && options.reasoningSummary !== null) {
				type ReasoningParam = NonNullable<ResponseCreateParamsStreaming["reasoning"]>;
				params.reasoning = { summary: options.reasoningSummary || "auto" } as P["reasoning"] & ReasoningParam;
			}
			return;
		}

		const requested = reasoning.requestedEffort ?? "medium";
		const wireEffort = reasoning.wireEffort ?? options?.mapEffort?.(requested) ?? requested;
		type ReasoningParam = NonNullable<ResponseCreateParamsStreaming["reasoning"]>;
		const reasoningParams: ReasoningParam = {
			effort: wireEffort as ReasoningParam["effort"],
		};
		if (options?.reasoningSummary !== null) {
			reasoningParams.summary = options?.reasoningSummary || "auto";
		}
		params.reasoning = reasoningParams as P["reasoning"];
		return;
	}
}

export function applyResponsesReasoningParams<P extends ResponseCreateParamsStreaming>(
	params: P,
	model: Model<"openai-responses" | "azure-openai-responses" | "openai-codex-responses">,
	options: ReasoningOptions | undefined,
	mapEffort?: (effort: string) => string,
	includeEncryptedReasoning?: boolean,
	omitReasoningEffort?: boolean,
): void {
	return applyResponsesCompatPolicy(
		params,
		resolveOpenAICompatPolicy(model, {
			endpoint: "responses",
			reasoning: options?.reasoning,
			disableReasoning: options?.disableReasoning,
			toolChoice: options?.toolChoice,
			includeEncryptedReasoning,
			omitReasoningEffort,
		}),
		{ reasoningSummary: options?.reasoningSummary, mapEffort },
	);
}

export function populateResponsesUsageFromResponse(
	output: AssistantMessage,
	usage:
		| {
				input_tokens?: number | null;
				output_tokens?: number | null;
				total_tokens?: number | null;
				prompt_cache_hit_tokens?: number | null;
				prompt_cache_miss_tokens?: number | null;
				input_tokens_details?: {
					cached_tokens?: number | null;
					cache_write_tokens?: number | null;
					orchestration_input_tokens?: number | null;
					orchestration_input_cached_tokens?: number | null;
				} | null;
				output_tokens_details?: {
					reasoning_tokens?: number | null;
					orchestration_output_tokens?: number | null;
				} | null;
		  }
		| null
		| undefined,
): void {
	if (!usage) return;
	const details = usage.input_tokens_details;
	const outputDetails = usage.output_tokens_details;
	const reportedInputTokens = usage.input_tokens ?? 0;
	const reportedOutputTokens = usage.output_tokens ?? 0;
	const reportedCachedTokens = details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
	const orchestrationInputTokens = details?.orchestration_input_tokens ?? 0;
	const orchestrationInputCachedTokens = details?.orchestration_input_cached_tokens ?? 0;
	const orchestrationOutputTokens = outputDetails?.orchestration_output_tokens ?? 0;
	const reportedTotalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
	const reportedPrimaryTokens = reportedInputTokens + reportedOutputTokens;
	const reportedWithSeparateOrchestration =
		reportedPrimaryTokens + orchestrationInputTokens + orchestrationOutputTokens;
	const primaryIncludesOrchestration =
		reportedTotalTokens !== undefined &&
		orchestrationInputTokens + orchestrationOutputTokens > 0 &&
		Math.abs(reportedTotalTokens - reportedPrimaryTokens) <=
			Math.abs(reportedTotalTokens - reportedWithSeparateOrchestration);
	const orchestrationInputCached = Math.min(orchestrationInputTokens, orchestrationInputCachedTokens);
	const orchestrationInput = Math.max(0, orchestrationInputTokens - orchestrationInputCached);
	const accounting = calculateOpenAIUsageAccounting({
		promptTokens: Math.max(0, reportedInputTokens - (primaryIncludesOrchestration ? orchestrationInputTokens : 0)),
		outputTokens: Math.max(0, reportedOutputTokens - (primaryIncludesOrchestration ? orchestrationOutputTokens : 0)),
		cachedTokens: Math.max(0, reportedCachedTokens - (primaryIncludesOrchestration ? orchestrationInputCached : 0)),
		reasoningTokens: outputDetails?.reasoning_tokens ?? 0,
		cacheWriteOpenRouter: details?.cache_write_tokens ?? undefined,
		cacheWriteDeepSeek: usage.prompt_cache_miss_tokens ?? undefined,
		hasDeepSeekCacheHitAndMiss:
			usage.prompt_cache_hit_tokens !== undefined && usage.prompt_cache_miss_tokens !== undefined,
	});
	const orchestrationTotal = orchestrationInput + orchestrationInputCached + orchestrationOutputTokens;
	if (orchestrationTotal > 0) {
		accounting.orchestration = {
			...(orchestrationInput > 0 ? { input: orchestrationInput } : {}),
			...(orchestrationInputCached > 0 ? { cacheRead: orchestrationInputCached } : {}),
			...(orchestrationOutputTokens > 0 ? { output: orchestrationOutputTokens } : {}),
		};
		accounting.totalTokens = reportedTotalTokens ?? accounting.totalTokens + orchestrationTotal;
	}

	const premiumRequests = output.usage.premiumRequests;
	output.usage = {
		...accounting,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	if (premiumRequests !== undefined) {
		output.usage.premiumRequests = premiumRequests;
	}
}

function deepEqualsWithout(a: unknown, b: unknown, omitKeys?: Record<string, boolean>): boolean {
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return Bun.deepEquals(a, b);
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	for (const key in ao) {
		if (omitKeys?.[key]) continue;
		const av = ao[key];
		const bv = bo[key];
		if (av !== bv && !Bun.deepEquals(av, bv)) return false;
	}
	for (const key in bo) {
		if (omitKeys?.[key]) continue;
		if (bo[key] !== undefined && !(key in ao)) return false;
	}
	return true;
}

const TOP_LEVEL_EXCLUDE_MAP = {
	input: true,
	client_metadata: true,
};

const ITEM_LIFECYCLE_EXCLUDE_MAP = {
	status: true,
};

const REPLAY_SANITIZED_ITEM_EXCLUDE_MAP = {
	status: true,
	id: true,
};

export function buildResponsesDeltaInput<TItem extends ResponseInputItem | InputItem>(
	previous: { input?: TItem[] } | undefined,
	previousResponseItems: readonly TItem[] | undefined,
	current: { input?: TItem[] },
): TItem[] | null {
	if (!previous) return null;
	if (!Array.isArray(previous.input) || !Array.isArray(current.input)) return null;
	if (!deepEqualsWithout(previous, current, TOP_LEVEL_EXCLUDE_MAP)) {
		return null;
	}

	const baselineLen = (previous.input?.length ?? 0) + (previousResponseItems?.length ?? 0);
	if (current.input.length <= baselineLen) return null;

	let index = 0;
	for (const series of [previous.input, previousResponseItems]) {
		if (!series) continue;
		for (const item of series) {
			const type = item.type;
			const omitKeys =
				type === "message" || type === "function_call" || type === "custom_tool_call"
					? REPLAY_SANITIZED_ITEM_EXCLUDE_MAP
					: ITEM_LIFECYCLE_EXCLUDE_MAP;
			if (deepEqualsWithout(item, current.input[index], omitKeys)) {
				index++;
			} else {
				return null;
			}
		}
	}
	return current.input.slice(index) as TItem[];
}
