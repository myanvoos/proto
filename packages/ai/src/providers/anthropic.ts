import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs";
import { scheduler } from "node:timers/promises";
import * as tls from "node:tls";
import { isAnthropicSigningProxyUrl, isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import { hostMatchesUrl, isVertexRawPredictUrl } from "@oh-my-pi/pi-catalog/hosts";
import { mapEffortToAnthropicAdaptiveEffort } from "@oh-my-pi/pi-catalog/model-thinking";
import { calculateCost, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { isAnthropicOAuthToken } from "@oh-my-pi/pi-catalog/utils";
import { parseGitHubCopilotApiKey } from "@oh-my-pi/pi-catalog/wire/github-copilot";
import {
	$env,
	classifyJsonPrefix,
	getInstallId,
	isEnoent,
	logger,
	parseJsonWithRepair,
	parseStreamingJsonThrottled,
	readSseEvents,
} from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { renderDemotedThinking } from "../dialect/demotion";
import * as AIError from "../error";
import { getEnvApiKey, OUTPUT_FALLBACK_BUFFER } from "../stream";
import type {
	AnthropicCompactionPayload,
	AnthropicFallbackContent,
	AnthropicMessagePayload,
	AnthropicServerToolContent,
	Api,
	AssistantMessage,
	AudioContent,
	CacheRetention,
	Context,
	FetchImpl,
	ImageContent,
	Message,
	Model,
	ProviderInputTransformation,
	ProviderPayload,
	ProviderSessionState,
	RawSseEvent,
	RedactedThinkingContent,
	ServiceTier,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
	VideoContent,
} from "../types";
import {
	getHeaderCaseInsensitive,
	isRecord,
	normalizeSystemPrompts,
	normalizeToolCallId,
	resolveCacheRetention,
} from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import {
	type ConversationalUserCarrier,
	clearStreamingPartialJson,
	copyPerCallContextMessage,
	isConversationalUser,
	isPerCallContextMessage,
	isSyntheticUser,
	kConversationalUser,
	kStreamingBlockIndex,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import { withReplaySafeStreamRetry } from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { isFoundryEnabled } from "../utils/foundry";
import { finalizeErrorMessage, type RawHttpRequestDump } from "../utils/http-inspector";
import { getStreamFirstEventTimeoutMs, getStreamIdleTimeoutMs, iterateWithIdleTimeout } from "../utils/idle-iterator";
import { notifyProviderResponse } from "../utils/provider-response";
import { getHeadersFromError, getRetryAfterMsFromHeaders } from "../utils/retry-after";
import { COMBINATOR_KEYS, NO_STRICT, toolWireSchema } from "../utils/schema";
import { spillToDescription } from "../utils/schema/spill";
import { notifyRawSseEvent } from "../utils/sse-debug";
import { isForcedToolChoice } from "../utils/tool-choice";
import {
	AnthropicConnectionTimeoutError,
	type AnthropicFetchOptions,
	AnthropicMessagesClient,
	type AnthropicMessagesClientLike,
	calculateAnthropicRetryDelayMs,
} from "./anthropic-client";
import { servedModelFromAnthropicSignature } from "./anthropic-signature";
import {
	type ToolInputSchema as AnthropicToolInputSchema,
	type Tool as AnthropicWireTool,
	type Usage as AnthropicWireUsage,
	COMPACTION_BETA,
	type CompactionBlockParam,
	type CompactionEdit,
	type ContentBlockParam,
	type FallbackParam,
	isAnthropicServerToolHistoryBlock,
	type MessageCreateParams,
	type MessageCreateParamsStreaming,
	type MessageParam,
	parseAnthropicInputTransformations,
	type RawMessageStreamEvent,
	type TextBlockParam,
	THINKING_BINDING_CONTROLS_BETA,
} from "./anthropic-wire";
import {
	adoptRequiredClaudeCodeVersion,
	CLAUDE_CODE_MAX_OUTPUT_TOKENS,
	claudeCodeSdkVersion,
	claudeCodeSystemInstruction,
	claudeToolPrefix,
	getClaudeCodeVersion,
	getCoworkUserAgent,
} from "./claude-code-fingerprint";
import {
	buildCopilotDynamicHeaders,
	getCachedCopilotIntegrationId,
	getCopilotIntegrationCacheKey,
	hasCopilotVisionInput,
	resolveCopilotRequestIdentity,
	resolveGitHubCopilotBaseUrl,
	wrapFetchForCopilotFallback,
} from "./github-copilot-headers";
import { applyInferenceHeaders } from "./inference-headers";
import { getOpenAIPromptCacheKey } from "./openai-shared";
import { redactSensitiveCredentials, transformMessages } from "./transform-messages";
import { mediaOmissionNote, NON_VISION_IMAGE_PLACEHOLDER } from "./vision-guard";

export type AnthropicHeaderOptions = {
	apiKey: string;
	baseUrl?: string;
	isOAuth?: boolean;
	extraBetas?: string[];
	stream?: boolean;
	modelHeaders?: Record<string, string>;
	isCloudflareAiGateway?: boolean;
	claudeCodeSessionId?: string;
	coworkBetas?: readonly string[];

	allowAnthropicHeaderOverrides?: boolean;
};

export function normalizeAnthropicBaseUrl(baseUrl?: string): string | undefined {
	const trimmed = baseUrl?.trim();
	if (!trimmed) {
		return undefined;
	}
	const withoutTrailingSlashes = trimmed.replace(/\/+$/, "");
	return withoutTrailingSlashes.endsWith("/v1") ? withoutTrailingSlashes.slice(0, -3) : withoutTrailingSlashes;
}

export function buildBetaHeader(baseBetas: readonly string[], extraBetas: readonly string[]): string {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const beta of [...baseBetas, ...extraBetas]) {
		const trimmed = beta.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}
	return result.join(",");
}

function mergeAnthropicBetaHeader(callerHeaders: Record<string, string>, beta: string): Record<string, string> {
	for (const key in callerHeaders) {
		if (key.toLowerCase() === "anthropic-beta") {
			return { [key]: buildBetaHeader(normalizeExtraBetas(callerHeaders[key]), [beta]) };
		}
	}
	return { "anthropic-beta": beta };
}
const oauthAuthBeta = "oauth-2025-04-20";
const midConversationSystemBeta = "mid-conversation-system-2026-04-07";
const midConversationSystemClearAtBeta = "mid-conversation-system-clear-at-2026-08-21";
const midConversationToolChangesBeta = "mid-conversation-tool-changes-2026-07-01";
const midConversationOutputConfigBeta = "mid-conversation-output-config-2026-07-01";
const contextManagementBeta = "context-management-2025-06-27";
const structuredOutputsBeta = "structured-outputs-2025-12-15";
const thinkingTokenCountBeta = "thinking-token-count-2026-05-13";
const fallbackCreditBeta = "fallback-credit-2026-06-01";
const coworkUtilityBetaDefaults = [
	oauthAuthBeta,
	"interleaved-thinking-2025-05-14",
	thinkingTokenCountBeta,
	contextManagementBeta,
	"prompt-caching-scope-2026-01-05",
	structuredOutputsBeta,
] as const;
const coworkAgentBetaDefaults = [
	"claude-code-20250219",
	oauthAuthBeta,
	"interleaved-thinking-2025-05-14",
	thinkingTokenCountBeta,
	contextManagementBeta,
	"prompt-caching-scope-2026-01-05",
	midConversationSystemBeta,
	"advanced-tool-use-2025-11-20",
] as const;
const extendedCacheTtlBeta = "extended-cache-ttl-2025-04-11";
const fineGrainedToolStreamingBeta = "fine-grained-tool-streaming-2025-05-14";
const interleavedThinkingBeta = "interleaved-thinking-2025-05-14";
const fastModeBeta = "fast-mode-2026-02-01";
const taskBudgetBeta = "task-budgets-2026-03-13";
const effortBeta = "effort-2025-11-24";
const serverSideFallbackBeta = "server-side-fallback-2026-06-01";

function resolveAnthropicControlBetas(
	model: Model<"anthropic-messages">,
	prefixMismatchBehavior: "drop_block" | "error" | undefined,
): string[] {
	const betas: string[] = [];
	if (prefixMismatchBehavior) betas.push(THINKING_BINDING_CONTROLS_BETA);
	if (model.compat.supportsTurnScopedSystem) betas.push(midConversationSystemClearAtBeta);
	if (model.compat.supportsMidConversationToolChanges) betas.push(midConversationToolChangesBeta);
	if (model.compat.supportsPerMessageEffort) betas.push(midConversationOutputConfigBeta);
	return betas;
}

function buildCoworkBetas(
	agentRequest: boolean,
	thinkingRequest: boolean,
	disableStrictTools = false,
	supportsContextManagement = true,
): readonly string[] {
	if (!agentRequest && !disableStrictTools && supportsContextManagement) return coworkUtilityBetaDefaults;
	const betas: string[] = [];
	for (const beta of agentRequest ? coworkAgentBetaDefaults : coworkUtilityBetaDefaults) {
		if (disableStrictTools && beta === structuredOutputsBeta) continue;
		if (!supportsContextManagement && beta === contextManagementBeta) continue;
		betas.push(beta);
	}
	if (!agentRequest) return betas;
	if (thinkingRequest) betas.push(effortBeta);
	betas.push(fallbackCreditBeta);
	return betas;
}

function isClaudeCodeClientUserAgent(userAgent: string | undefined): userAgent is string {
	if (!userAgent) return false;
	return userAgent.toLowerCase().startsWith("claude-cli");
}

const sharedHeaders = {
	"Accept-Encoding": "gzip, deflate, br, zstd",
	Connection: "keep-alive",
	"Content-Type": "application/json",
	"anthropic-version": "2023-06-01",
	"anthropic-dangerous-direct-browser-access": "true",
	"x-app": "cli",
};

export function buildAnthropicHeaders(options: AnthropicHeaderOptions): Record<string, string> {
	const oauthToken = options.isOAuth ?? isAnthropicOAuthToken(options.apiKey);
	const extraBetas = options.extraBetas ?? [];
	const stream = options.stream ?? false;

	const incomingUserAgent = getHeaderCaseInsensitive(options.modelHeaders, "User-Agent");
	const incomingAuthorization = getHeaderCaseInsensitive(options.modelHeaders, "Authorization");
	const incomingApiKey = getHeaderCaseInsensitive(options.modelHeaders, "X-Api-Key");

	const betaHeader = buildBetaHeader(
		options.coworkBetas ?? (oauthToken ? buildCoworkBetas(true, true) : []),
		extraBetas,
	);
	const acceptHeader = oauthToken ? "application/json" : stream ? "text/event-stream" : "application/json";
	const isCloudflare = options.isCloudflareAiGateway ?? false;
	const honorAuthorization = !oauthToken && !isCloudflare;
	const allowAnthropicHeaderOverrides =
		oauthToken &&
		options.allowAnthropicHeaderOverrides === true &&
		!isCloudflare &&
		!isOfficialAnthropicApiUrl(options.baseUrl);
	const honorApiKey = !isCloudflare;
	const modelHeaders: Record<string, string> = {};
	const anthropicHeaderOverrides: Record<string, string> = {};
	const filteredEnforcedKeys: string[] = [];
	const headerSource = options.modelHeaders;
	if (headerSource) {
		for (const key in headerSource) {
			const value = headerSource[key];
			const lowerKey = key.toLowerCase();
			if (enforcedHeaderKeys.has(lowerKey)) {
				if (allowAnthropicHeaderOverrides && overridableAnthropicHeaderKeys.has(lowerKey)) {
					anthropicHeaderOverrides[key] = value;
					continue;
				}

				if (lowerKey === "user-agent") continue;
				if (lowerKey === "authorization" && honorAuthorization) continue;
				if (lowerKey === "x-api-key" && honorApiKey) continue;
				filteredEnforcedKeys.push(key);
				continue;
			}
			modelHeaders[key] = value;
		}
	}
	if (filteredEnforcedKeys.length > 0) {
		logger.debug("anthropic: ignoring caller-supplied enforced headers", {
			headers: filteredEnforcedKeys,
		});
	}

	if (isCloudflare) {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			...sharedHeaders,
			...(incomingUserAgent ? { "User-Agent": incomingUserAgent } : {}),
			...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
			"cf-aig-authorization": `Bearer ${options.apiKey}`,
		};
	}

	if (oauthToken) {
		const userAgent = isClaudeCodeClientUserAgent(incomingUserAgent) ? incomingUserAgent : getCoworkUserAgent();
		const headers = {
			...modelHeaders,
			Accept: acceptHeader,
			"Content-Type": "application/json",
			"User-Agent": userAgent,
			...(options.claudeCodeSessionId ? { "X-Claude-Code-Session-Id": options.claudeCodeSessionId } : {}),
			...coworkHeaders,
			...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
			"anthropic-dangerous-direct-browser-access": "true",
			"anthropic-version": "2023-06-01",
			Authorization: `Bearer ${options.apiKey}`,
			"x-app": "cli",
			"x-client-request-id": nodeCrypto.randomUUID(),
			Connection: "keep-alive",
			"Accept-Encoding": "gzip, deflate, br, zstd",
			...(incomingApiKey ? { "X-Api-Key": incomingApiKey } : {}),
		};
		return allowAnthropicHeaderOverrides ? mergeHeaders(headers, anthropicHeaderOverrides) : headers;
	} else if (!isOfficialAnthropicApiUrl(options.baseUrl)) {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			Authorization: incomingAuthorization ?? `Bearer ${options.apiKey}`,
			...sharedHeaders,
			...(incomingUserAgent ? { "User-Agent": incomingUserAgent } : {}),
			...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
			...(incomingApiKey ? { "X-Api-Key": incomingApiKey } : {}),
		};
	} else {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			...sharedHeaders,
			...(incomingUserAgent ? { "User-Agent": incomingUserAgent } : {}),
			...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
			...(incomingAuthorization ? { Authorization: incomingAuthorization } : {}),
			"X-Api-Key": incomingApiKey ?? options.apiKey,
		};
	}
}

type AnthropicCacheControl = NonNullable<TextBlockParam["cache_control"]>;
type AnthropicImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function normalizeAnthropicImageMediaType(mimeType: string): AnthropicImageMediaType | undefined {
	const normalized = mimeType.trim().toLowerCase();
	if (normalized === "image/jpg") return "image/jpeg";
	if (
		normalized === "image/jpeg" ||
		normalized === "image/png" ||
		normalized === "image/gif" ||
		normalized === "image/webp"
	) {
		return normalized;
	}
	return undefined;
}

function cloneAnthropicCacheControl(cacheControl: AnthropicCacheControl): AnthropicCacheControl {
	return { ...cacheControl };
}

type AnthropicOutputConfig = NonNullable<MessageCreateParamsStreaming["output_config"]>;

const ANTHROPIC_STOP_SEQUENCES_MAX = 4;
let warnedStopSequencesTrim = false;

const ANTHROPIC_PROVIDER_SESSION_STATE_KEY = "anthropic-messages";

type AnthropicControlTransition = {
	messageCount: number;
	anchor: string;
	content: ContentBlockParam[];
	effort?: AnthropicOutputEffort;
};

type AnthropicControlState = {
	declaredTools: AnthropicWireTool[] | undefined;
	activeToolNames: Set<string>;
	stableSystemBlocks: AnthropicSystemBlock[] | undefined;
	systemFingerprint: string | undefined;
	controlTransitions: AnthropicControlTransition[];
	effortBaselined: boolean;
	baseEffortWire: AnthropicOutputEffort | undefined;
	currentEffort: AnthropicOutputEffort | undefined;
};

type AnthropicProviderSessionState = ProviderSessionState & {
	strictToolsDisabled: boolean;
	fastModeDisabled: boolean;

	replayUnsignedThinkingDisabled: boolean;
	thinkingReplayDisabled: boolean;
	prefixDroppedThinkingBlocks: Set<string>;
	controlStates: Map<string, AnthropicControlState>;
};

function createAnthropicControlState(): AnthropicControlState {
	return {
		declaredTools: undefined,
		activeToolNames: new Set(),
		stableSystemBlocks: undefined,
		systemFingerprint: undefined,
		controlTransitions: [],
		effortBaselined: false,
		baseEffortWire: undefined,
		currentEffort: undefined,
	};
}

function createAnthropicProviderSessionState(): AnthropicProviderSessionState {
	const state: AnthropicProviderSessionState = {
		strictToolsDisabled: false,
		fastModeDisabled: false,
		replayUnsignedThinkingDisabled: false,
		thinkingReplayDisabled: false,
		prefixDroppedThinkingBlocks: new Set(),
		controlStates: new Map(),
		close: () => {
			state.strictToolsDisabled = false;
			state.fastModeDisabled = false;
			state.replayUnsignedThinkingDisabled = false;
			state.thinkingReplayDisabled = false;
			state.prefixDroppedThinkingBlocks.clear();
			state.controlStates.clear();
		},
	};
	return state;
}

function anthropicProviderSessionStateKey(baseUrl: string, modelId: string): string {
	return `${ANTHROPIC_PROVIDER_SESSION_STATE_KEY}:${baseUrl}\u0000${modelId}`;
}

function getAnthropicProviderSessionState(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
	baseUrl: string,
	modelId: string,
): AnthropicProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = anthropicProviderSessionStateKey(baseUrl, modelId);
	const existing = providerSessionState.get(key) as AnthropicProviderSessionState | undefined;
	if (existing) {
		existing.prefixDroppedThinkingBlocks ??= new Set();
		existing.controlStates ??= new Map();
		return existing;
	}
	const created = createAnthropicProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

export function clearAnthropicFastModeFallback(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): void {
	if (!providerSessionState) return;

	const prefix = `${ANTHROPIC_PROVIDER_SESSION_STATE_KEY}:`;
	for (const [key, value] of providerSessionState) {
		if (key !== ANTHROPIC_PROVIDER_SESSION_STATE_KEY && !key.startsWith(prefix)) continue;
		(value as AnthropicProviderSessionState).fastModeDisabled = false;
	}
}

export function isAnthropicFastModeFallbackDisabled(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
	model: Model<Api>,
): boolean {
	if (!providerSessionState || model.provider !== "anthropic" || model.api !== "anthropic-messages") return false;
	const baseUrl = resolveAnthropicBaseUrl(model as Model<"anthropic-messages">) ?? "https://api.anthropic.com";
	const key = anthropicProviderSessionStateKey(baseUrl, model.id);
	return (providerSessionState.get(key) as AnthropicProviderSessionState | undefined)?.fastModeDisabled ?? false;
}

function hasStrictAnthropicTools(params: MessageCreateParamsStreaming): boolean {
	return params.tools?.some(tool => tool.strict === true) ?? false;
}

function dropAnthropicFastMode(params: MessageCreateParamsStreaming): void {
	delete params.speed;
}

function dropAnthropicStrictTools(params: MessageCreateParamsStreaming): void {
	if (!params.tools) return;
	for (const tool of params.tools) {
		delete tool.strict;
	}
}

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention: CacheRetention | undefined,
	isOAuthToken = false,
): { retention: CacheRetention; cacheControl?: AnthropicCacheControl } {
	const defaultRetention = isOAuthToken && model.compat.supportsLongCacheRetention ? "long" : "short";
	const retention = resolveCacheRetention(cacheRetention, defaultRetention);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && model.compat.supportsLongCacheRetention ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

export * from "./claude-code-fingerprint";

export function mapStainlessArch(arch: string): "x64" | "arm64" | "x86" | `other::${string}` {
	switch (arch.toLowerCase()) {
		case "amd64":
		case "x64":
			return "x64";
		case "arm64":
		case "aarch64":
			return "arm64";
		case "386":
		case "x86":
		case "ia32":
			return "x86";
		default:
			return `other::${arch.toLowerCase()}`;
	}
}

export const coworkHeaders = {
	"X-Stainless-Arch": mapStainlessArch(process.arch),
	"X-Stainless-Lang": "js",
	"X-Stainless-OS": "Linux",
	"X-Stainless-Package-Version": claudeCodeSdkVersion,
	"X-Stainless-Retry-Count": "0",
	"X-Stainless-Runtime": "node",
	"X-Stainless-Runtime-Version": "v26.3.0",
	"X-Stainless-Timeout": "600",
};

const enforcedHeaderKeys = new Set(
	[
		...Object.keys(coworkHeaders),
		"Accept",
		"Accept-Encoding",
		"Connection",
		"Content-Type",
		"anthropic-version",
		"anthropic-dangerous-direct-browser-access",
		"anthropic-beta",
		"User-Agent",
		"x-app",
		"Authorization",
		"X-Api-Key",
		"X-Claude-Code-Session-Id",
		"x-client-request-id",
		"cf-aig-authorization",
	].map(key => key.toLowerCase()),
);

const overridableAnthropicHeaderKeys = new Set(
	[...Object.keys(coworkHeaders), "anthropic-beta", "User-Agent", "x-app"].map(key => key.toLowerCase()),
);

const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

function createClaudeBillingHeader(firstUserMessageText: string): string {
	const k = [4, 7, 20].map(i => firstUserMessageText[i] ?? "0").join("");
	const version = getClaudeCodeVersion();
	const versionSuffix = Bun.SHA256.hash(`59cf53e54c78${k}${version}`, "hex").slice(0, 3);

	return `${CLAUDE_BILLING_HEADER_PREFIX} cc_version=${version}.${versionSuffix}; cc_entrypoint=claude-desktop; ${CCH_PLACEHOLDER_STR};`;
}

const CCH_SEED = 0x4d659218e32a3268n;
const CCH_PLACEHOLDER_STR = "cch=00000";
const cchEncoder = new TextEncoder();
const CCH_PLACEHOLDER = cchEncoder.encode(CCH_PLACEHOLDER_STR);

const BILLING_SYSTEM_MARKER = cchEncoder.encode(`"system":[{"type":"text","text":"${CLAUDE_BILLING_HEADER_PREFIX}`);
const CCH_BILLING_SEARCH_WINDOW = 150;

function patchCch(body: Uint8Array): "patched" | "no-billing-header" | "unanchored" {
	const view = Buffer.from(body.buffer, body.byteOffset, body.byteLength);

	const markerIdx = view.indexOf(BILLING_SYSTEM_MARKER);
	if (markerIdx === -1) return "no-billing-header";

	const searchFrom = markerIdx + BILLING_SYSTEM_MARKER.length;
	const idx = view.indexOf(CCH_PLACEHOLDER, searchFrom);
	if (idx === -1 || idx - searchFrom > CCH_BILLING_SEARCH_WINDOW) return "unanchored";

	const h = Bun.hash.xxHash64(body, CCH_SEED);
	const cch = (h & 0xfffffn).toString(16).padStart(5, "0");

	for (let i = 0; i < 5; i++) body[idx + 4 + i] = cch.charCodeAt(i);
	return "patched";
}

export function wrapFetchForCch(base: FetchImpl): FetchImpl {
	return (input, init) => {
		if (init?.body && typeof init.body === "string" && init.body.includes(CCH_PLACEHOLDER_STR)) {
			const encoded = cchEncoder.encode(init.body);
			if (patchCch(encoded) === "unanchored") {
				logger.warn("anthropic: cch billing placeholder present but not patched; sending unattested request");
			}
			return base(input, { ...init, body: encoded });
		}
		return base(input, init);
	};
}

const CLAUDE_CLOAKING_USER_ID_REGEX =
	/^user_[0-9a-fA-F]{64}_account_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isClaudeCloakingUserId(userId: string): boolean {
	return CLAUDE_CLOAKING_USER_ID_REGEX.test(userId);
}

function isClaudeJsonUserId(userId: string): boolean {
	if (userId.length === 0 || userId[0] !== "{") return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(userId);
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
	const obj = parsed as Record<string, unknown>;
	return typeof obj.session_id === "string" && obj.session_id.length > 0;
}

function extractClaudeMetadataSessionId(userId: unknown): string | undefined {
	if (typeof userId !== "string") return undefined;
	if (isClaudeCloakingUserId(userId)) {
		return userId.slice(userId.lastIndexOf("_session_") + "_session_".length);
	}
	if (userId.length === 0 || userId[0] !== "{") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(userId);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const sessionId = (parsed as Record<string, unknown>).session_id;
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

export function generateClaudeCloakingUserId(): string {
	const userHash = nodeCrypto.randomBytes(32).toString("hex");
	const accountId = nodeCrypto.randomUUID().toLowerCase();
	const sessionId = nodeCrypto.randomUUID().toLowerCase();
	return `user_${userHash}_account_${accountId}_session_${sessionId}`;
}

const CLAUDE_DEVICE_ID_INSTALL_HASH_DOMAIN = "proto-claude-device-id-v1:";
const CLAUDE_DEVICE_ID_ACCOUNT_HASH_DOMAIN = "proto-claude-device-id-v2";

export function deriveClaudeDeviceId(installId: string, accountId?: string): string {
	const hash = new Bun.CryptoHasher("sha256");
	if (accountId && accountId.length > 0) {
		return hash
			.update(CLAUDE_DEVICE_ID_ACCOUNT_HASH_DOMAIN)
			.update("\0")
			.update(installId)
			.update("\0")
			.update(accountId)
			.digest("hex");
	}
	return hash.update(CLAUDE_DEVICE_ID_INSTALL_HASH_DOMAIN).update(installId).digest("hex");
}

function readMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = metadata?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readAnthropicMetadataAccountId(metadata: Record<string, unknown> | undefined): string | undefined {
	return (
		readMetadataString(metadata, "account_uuid") ??
		readMetadataString(metadata, "accountId") ??
		readMetadataString(metadata, "account_id")
	);
}

function deriveClaudeDeviceIdFromInstallId(accountId?: string): string {
	return deriveClaudeDeviceId(getInstallId(), accountId);
}

function generateClaudeJsonUserId(sessionId?: string, accountId?: string): string {
	const userId: Record<string, string> = {
		device_id: deriveClaudeDeviceIdFromInstallId(accountId),
		session_id: sessionId ?? nodeCrypto.randomUUID().toLowerCase(),
	};
	if (accountId && accountId.length > 0) userId.account_uuid = accountId;
	return JSON.stringify(userId);
}

export function resolveAnthropicMetadataUserId(
	userId: unknown,
	isOAuthToken: boolean,
	sessionId?: string,
	accountId?: string,
): string | undefined {
	if (typeof userId === "string") {
		if (!isOAuthToken || isClaudeCloakingUserId(userId) || isClaudeJsonUserId(userId)) {
			return userId;
		}
	}

	if (!isOAuthToken) return undefined;
	return generateClaudeJsonUserId(sessionId, accountId);
}
const ANTHROPIC_BUILTIN_TOOL_NAMES = new Set(["web_search", "code_execution", "text_editor", "computer"]);
const UMANS_WEBSEARCH_PROVIDER_HEADER = "X-Umans-Websearch-Provider";
const UMANS_WEBSEARCH_TOOL_NAME = "web_search";
export const applyClaudeToolPrefix = (name: string): string => {
	if (!claudeToolPrefix) return name;
	if (ANTHROPIC_BUILTIN_TOOL_NAMES.has(name.toLowerCase())) return name;

	return `${claudeToolPrefix}${name}`;
};

export const stripClaudeToolPrefix = (name: string): string => {
	if (!claudeToolPrefix) return name;
	if (!name.toLowerCase().startsWith(claudeToolPrefix.toLowerCase())) return name;
	return name.slice(claudeToolPrefix.length);
};

function normalizeUmansWebSearchProvider(value: string | undefined): "native" | "exa" | undefined {
	const normalized = value?.trim().toLowerCase();
	return normalized === "native" || normalized === "exa" ? normalized : undefined;
}

function getUmansWebSearchProvider(headers: Record<string, string> | undefined): "native" | "exa" | undefined {
	const explicit = getHeaderCaseInsensitive(headers, UMANS_WEBSEARCH_PROVIDER_HEADER);
	if (explicit !== undefined) return normalizeUmansWebSearchProvider(explicit);
	return normalizeUmansWebSearchProvider($env.UMANS_WEBSEARCH_PROVIDER);
}

function isUmansAnthropicModel(model: Model<"anthropic-messages">): boolean {
	return model.provider === "umans" || model.baseUrl.toLowerCase().includes("api.code.umans.ai");
}

function getUmansWebSearchHeader(
	model: Model<"anthropic-messages">,
	headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!isUmansAnthropicModel(model)) return undefined;
	const provider = getUmansWebSearchProvider(headers);
	return provider ? { [UMANS_WEBSEARCH_PROVIDER_HEADER]: provider } : undefined;
}

function shouldUseUmansGatewayWebSearch(name: string, enabled: boolean): boolean {
	return enabled && name.toLowerCase() === UMANS_WEBSEARCH_TOOL_NAME;
}

function encodeAnthropicToolName(
	name: string,
	isOAuthToken: boolean,
	escapeBuiltinToolNames: boolean,
	useUmansGatewayWebSearch = false,
): string {
	if (shouldUseUmansGatewayWebSearch(name, useUmansGatewayWebSearch)) return name;
	if (escapeBuiltinToolNames) return `${claudeToolPrefix}${name}`;
	return isOAuthToken ? applyClaudeToolPrefix(name) : name;
}

function decodeAnthropicToolName(name: string, isOAuthToken: boolean, escapeBuiltinToolNames: boolean): string {
	if (isOAuthToken || escapeBuiltinToolNames) return stripClaudeToolPrefix(name);
	return name;
}

const ANTHROPIC_MANY_IMAGE_THRESHOLD = 20;
const ANTHROPIC_MANY_IMAGE_MAX_DIMENSION = 2000;

function countAnthropicImageBlocks(messages: Message[]): number {
	let count = 0;
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "developer" && message.role !== "toolResult") continue;
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "image") count++;
		}
	}
	return count;
}

const ANTHROPIC_IMAGE_RESIZE_CONCURRENCY = 4;

const anthropicManyImageResizeCache = new WeakMap<ImageContent, ImageContent>();

type ResizeLimiter = <R>(fn: () => Promise<R>) => Promise<R>;

function createResizeLimiter(limit: number): ResizeLimiter {
	let active = 0;
	const queue: (() => void)[] = [];
	return async fn => {
		if (active >= limit) {
			const { promise, resolve } = Promise.withResolvers<void>();
			queue.push(resolve);
			await promise;
		} else {
			active++;
		}
		try {
			return await fn();
		} finally {
			const next = queue.shift();
			if (next) next();
			else active--;
		}
	};
}

async function resizeAnthropicManyImageBlock(block: ImageContent): Promise<ImageContent> {
	try {
		const inputBuffer = Buffer.from(block.data, "base64");
		const { width, height } = await new Bun.Image(inputBuffer).metadata();
		if (!width || !height) return block;
		if (width <= ANTHROPIC_MANY_IMAGE_MAX_DIMENSION && height <= ANTHROPIC_MANY_IMAGE_MAX_DIMENSION) return block;

		const scale = Math.min(ANTHROPIC_MANY_IMAGE_MAX_DIMENSION / width, ANTHROPIC_MANY_IMAGE_MAX_DIMENSION / height);
		const targetWidth = Math.max(1, Math.min(ANTHROPIC_MANY_IMAGE_MAX_DIMENSION, Math.round(width * scale)));
		const targetHeight = Math.max(1, Math.min(ANTHROPIC_MANY_IMAGE_MAX_DIMENSION, Math.round(height * scale)));

		const [png, jpeg] = await Promise.all([
			new Bun.Image(inputBuffer).resize(targetWidth, targetHeight).png().bytes(),
			new Bun.Image(inputBuffer).resize(targetWidth, targetHeight).jpeg({ quality: 85 }).bytes(),
		]);
		const best =
			png.length <= jpeg.length ? { buffer: png, mimeType: "image/png" } : { buffer: jpeg, mimeType: "image/jpeg" };

		return {
			type: "image",
			data: Buffer.from(best.buffer).toString("base64"),
			mimeType: best.mimeType,
		};
	} catch (error) {
		logger.warn("anthropic: failed to resize oversized image for many-image request", {
			mimeType: block.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return block;
	}
}

async function resizeAnthropicManyImageContent<T extends AudioContent | ImageContent | TextContent | VideoContent>(
	content: T[],
	state: { resized: number },
	limit: ResizeLimiter,
): Promise<T[]> {
	let changed = false;
	const next = await Promise.all(
		content.map(async (block): Promise<T> => {
			if (
				block.type !== "image" ||
				block.url ||
				(block.providerFile?.provider === "anthropic" && block.providerFile.id)
			)
				return block;
			const imageBlock: ImageContent = block;
			let resized = anthropicManyImageResizeCache.get(imageBlock);
			if (resized === undefined) {
				resized = await limit(() => resizeAnthropicManyImageBlock(imageBlock));
				anthropicManyImageResizeCache.set(imageBlock, resized);
			}
			if (resized !== imageBlock) {
				changed = true;
				state.resized++;
			}
			return resized as T;
		}),
	);
	return changed ? next : content;
}

async function resizeAnthropicManyImageMessage(
	message: Message,
	state: { resized: number },
	limit: ResizeLimiter,
): Promise<Message> {
	if (message.role === "user" || message.role === "developer") {
		if (!Array.isArray(message.content)) return message;
		const content = await resizeAnthropicManyImageContent(message.content, state, limit);
		return content === message.content ? message : { ...message, content };
	}
	if (message.role === "toolResult") {
		const content = await resizeAnthropicManyImageContent(message.content, state, limit);
		return content === message.content ? message : { ...message, content };
	}
	return message;
}

async function prepareAnthropicManyImageContext(context: Context, supportsImages: boolean): Promise<Context> {
	if (!supportsImages) return context;
	const imageCount = countAnthropicImageBlocks(context.messages);
	if (imageCount <= ANTHROPIC_MANY_IMAGE_THRESHOLD) return context;

	let changed = false;
	const state = { resized: 0 };
	const limit = createResizeLimiter(ANTHROPIC_IMAGE_RESIZE_CONCURRENCY);
	const messages = await Promise.all(
		context.messages.map(async message => {
			const next = await resizeAnthropicManyImageMessage(message, state, limit);
			if (next !== message) changed = true;
			return next;
		}),
	);
	if (!changed) return context;
	logger.debug("anthropic: resized oversized images for many-image request", {
		imageCount,
		resized: state.resized,
		maxDimension: ANTHROPIC_MANY_IMAGE_MAX_DIMENSION,
	});
	return { ...context, messages };
}

type AnthropicImageSource =
	| { type: "base64"; media_type: AnthropicImageMediaType; data: string }
	| { type: "url"; url: string }
	| { type: "file"; file_id: string };

type AnthropicToolResultContent =
	| string
	| Array<{ type: "text"; text: string } | { type: "image"; source: AnthropicImageSource }>;

function convertContentBlocks(
	content: (AudioContent | ImageContent | TextContent | VideoContent)[],
	supportsImages = true,
): AnthropicToolResultContent {
	const blocks: Array<{ type: "text"; text: string } | { type: "image"; source: AnthropicImageSource }> = [];
	let sawText = false;
	let sawImage = false;

	for (const block of content) {
		if (block.type === "text") {
			const text = block.text.toWellFormed();
			if (text.trim().length === 0) continue;
			sawText = true;
			blocks.push({ type: "text", text });
			continue;
		}

		if (block.type === "audio" || block.type === "video") {
			blocks.push({ type: "text", text: mediaOmissionNote(block.type) });
			continue;
		}

		if (!supportsImages) {
			blocks.push({ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER });
			continue;
		}

		let source: AnthropicImageSource;
		if (block.providerFile?.provider === "anthropic" && block.providerFile.id) {
			source = { type: "file", file_id: block.providerFile.id };
		} else if (block.url) {
			source = { type: "url", url: block.url };
		} else {
			const mediaType = normalizeAnthropicImageMediaType(block.mimeType);
			if (!mediaType) {
				blocks.push({ type: "text", text: `[unsupported image: ${block.mimeType}]` });
				continue;
			}
			source = { type: "base64", media_type: mediaType, data: block.data };
		}

		sawImage = true;
		blocks.push({ type: "image", source });
	}

	if (!supportsImages) {
		return blocks
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n")
			.toWellFormed();
	}

	if (sawImage && !sawText) {
		blocks.unshift({
			type: "text",
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicOutputEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type AnthropicEffort = AnthropicOutputEffort | "adaptive";
export type AnthropicThinkingDisplay = "summarized" | "omitted";

export interface AnthropicOptions extends StreamOptions {
	thinkingEnabled?: boolean;

	thinkingBudgetTokens?: number;

	requestModelId?: string;

	effort?: AnthropicEffort;

	reasoning?: SimpleStreamOptions["reasoning"];

	thinkingDisplay?: AnthropicThinkingDisplay;
	interleavedThinking?: boolean;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	betas?: string[] | string;

	serviceTier?: ServiceTier;

	isOAuth?: boolean;

	client?: AnthropicMessagesClientLike;

	fallbacks?: FallbackParam[];
}

export type AnthropicClientOptionsArgs = {
	model: Model<"anthropic-messages">;
	apiKey: string;
	extraBetas?: string[];
	stream?: boolean;
	interleavedThinking?: boolean;
	headers?: Record<string, string>;
	dynamicHeaders?: Record<string, string>;
	isOAuth?: boolean;
	hasTools?: boolean;
	thinkingEnabled?: boolean;
	thinkingDisplay?: AnthropicThinkingDisplay;
	disableStrictTools?: boolean;
	fetch?: FetchImpl;
	maxRetryDelayMs?: number;
	sessionId?: string;
	/** Working-identity cache key for this Copilot credential+host. */
	copilotCacheKey?: string;
	/** Cached identity the Copilot headers were built from (`null` = empty at build); `undefined` rereads at dispatch. */
	copilotCacheSnapshot?: string | null;
};

export type AnthropicClientOptionsResult = {
	isOAuthToken: boolean;
	apiKey: string | null;
	authToken?: string | null;
	baseURL?: string;
	maxRetries: number;
	maxRetryDelayMs?: number;
	defaultHeaders: Record<string, string>;
	fetch?: FetchImpl;
	fetchOptions?: AnthropicFetchOptions;
};

const COWORK_TLS_CIPHERS = tls.DEFAULT_CIPHERS;

type FoundryTlsOptions = {
	ca?: string | string[];
	cert?: string;
	key?: string;
};

const MAX_FOUNDRY_TLS_CACHE_ENTRIES = 64;
const foundryTlsOptionsCache = new LRUCache<string, FoundryTlsOptions | null>({
	max: MAX_FOUNDRY_TLS_CACHE_ENTRIES,
});

function foundryTlsCacheKeyComponent(value: string | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();

	if (trimmed && !trimmed.includes("-----BEGIN") && looksLikeFilePath(trimmed)) {
		try {
			return `${trimmed}@${fs.statSync(trimmed).mtimeMs}`;
		} catch {
			return trimmed;
		}
	}
	return value;
}

function foundryTlsOptionsCacheKey(): string {
	return JSON.stringify([
		foundryTlsCacheKeyComponent($env.NODE_EXTRA_CA_CERTS),
		foundryTlsCacheKeyComponent($env.CLAUDE_CODE_CLIENT_CERT),
		foundryTlsCacheKeyComponent($env.CLAUDE_CODE_CLIENT_KEY),
	]);
}

function resolveAnthropicBaseUrl(model: Model<"anthropic-messages">, apiKey?: string): string | undefined {
	if (model.provider === "github-copilot") {
		return normalizeAnthropicBaseUrl(resolveGitHubCopilotBaseUrl(model.baseUrl, apiKey) ?? model.baseUrl);
	}
	if (model.provider === "anthropic" && isFoundryEnabled()) {
		const foundryBaseUrl = normalizeAnthropicBaseUrl($env.FOUNDRY_BASE_URL);
		if (foundryBaseUrl) {
			return foundryBaseUrl;
		}
	}
	if (model.provider === "anthropic") {
		const configured = normalizeAnthropicBaseUrl(model.baseUrl);

		if (configured && !isOfficialAnthropicApiUrl(configured)) return configured;

		return normalizeAnthropicBaseUrl($env.ANTHROPIC_BASE_URL) ?? configured ?? "https://api.anthropic.com";
	}
	return normalizeAnthropicBaseUrl(model.baseUrl);
}

function resolveEagerToolInputStreamingSupport(
	model: Model<"anthropic-messages">,
	effectiveBaseUrl: string | undefined,
): boolean {
	if (!model.compat.supportsEagerToolInputStreaming) return false;

	if (isOfficialAnthropicApiUrl(effectiveBaseUrl)) return true;

	return !model.compat.officialEndpoint;
}

function parseAnthropicCustomHeaders(rawHeaders: string | undefined): Record<string, string> | undefined {
	const source = rawHeaders?.trim();
	if (!source) return undefined;

	const parsed: Record<string, string> = {};
	for (const token of source.split(/\r?\n|,/)) {
		const entry = token.trim();
		if (!entry) continue;
		const separatorIndex = entry.indexOf(":");
		if (separatorIndex <= 0) continue;
		const key = entry.slice(0, separatorIndex).trim();
		const value = entry.slice(separatorIndex + 1).trim();
		if (!key || !value) continue;
		parsed[key] = value;
	}

	return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function resolveAnthropicCustomHeadersForBaseUrl(
	baseUrl: string | undefined,
): Record<string, string> | undefined {
	if (!isFoundryEnabled() && isOfficialAnthropicApiUrl(baseUrl)) return undefined;
	return parseAnthropicCustomHeaders($env.ANTHROPIC_CUSTOM_HEADERS);
}

function resolveAnthropicCustomHeaders(
	model: Model<"anthropic-messages">,
	baseUrl: string | undefined,
): Record<string, string> | undefined {
	if (model.provider !== "anthropic") return undefined;
	return resolveAnthropicCustomHeadersForBaseUrl(baseUrl);
}

function looksLikeFilePath(value: string): boolean {
	return value.includes("/") || value.includes("\\") || /\.(pem|crt|cer|key)$/i.test(value);
}

function resolvePemValue(value: string | undefined, name: string): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;

	const inline = trimmed.replace(/\\n/g, "\n");
	if (inline.includes("-----BEGIN")) {
		return inline;
	}

	if (looksLikeFilePath(trimmed)) {
		try {
			return fs.readFileSync(trimmed, "utf8");
		} catch (error) {
			if (isEnoent(error)) {
				throw new AIError.ValidationError(`${name} path does not exist: ${trimmed}`);
			}
			throw error;
		}
	}

	return inline;
}

function resolveFoundryTlsOptions(model: Model<"anthropic-messages">): FoundryTlsOptions | undefined {
	if (model.provider !== "anthropic") return undefined;
	if (!isFoundryEnabled()) return undefined;

	const cacheKey = foundryTlsOptionsCacheKey();
	const cached = foundryTlsOptionsCache.get(cacheKey);
	if (cached !== undefined) return cached ?? undefined;

	const ca = resolvePemValue($env.NODE_EXTRA_CA_CERTS, "NODE_EXTRA_CA_CERTS");
	const cert = resolvePemValue($env.CLAUDE_CODE_CLIENT_CERT, "CLAUDE_CODE_CLIENT_CERT");
	const key = resolvePemValue($env.CLAUDE_CODE_CLIENT_KEY, "CLAUDE_CODE_CLIENT_KEY");

	if ((cert && !key) || (!cert && key)) {
		throw new AIError.ConfigurationError(
			"Both CLAUDE_CODE_CLIENT_CERT and CLAUDE_CODE_CLIENT_KEY must be set for mTLS.",
		);
	}

	const options: FoundryTlsOptions = {};
	if (ca) options.ca = [...tls.rootCertificates, ca];
	if (cert) options.cert = cert;
	if (key) options.key = key;
	const resolved = Object.keys(options).length > 0 ? options : undefined;
	foundryTlsOptionsCache.set(cacheKey, resolved ?? null);
	return resolved;
}

function buildCoworkTlsFetchOptions(
	model: Model<"anthropic-messages">,
	baseUrl: string | undefined,
): AnthropicFetchOptions | undefined {
	if (model.provider !== "anthropic") return undefined;
	if (!baseUrl) return undefined;

	let serverName: string;
	try {
		serverName = new URL(baseUrl).hostname;
	} catch {
		return undefined;
	}

	if (!serverName) return undefined;

	const foundryTlsOptions = resolveFoundryTlsOptions(model);

	return {
		tls: {
			rejectUnauthorized: true,
			serverName,
			...(COWORK_TLS_CIPHERS ? { ciphers: COWORK_TLS_CIPHERS } : {}),
			...foundryTlsOptions,
		},
	};
}
function mergeHeaders(...headerSources: (Record<string, string> | undefined)[]): Record<string, string> {
	const merged: Record<string, string> = {};
	const keyByLower = new Map<string, string>();
	for (const headers of headerSources) {
		if (!headers) continue;
		for (const [key, value] of Object.entries(headers)) {
			const lower = key.toLowerCase();
			const existing = keyByLower.get(lower);
			if (existing !== undefined && existing !== key) delete merged[existing];
			keyByLower.set(lower, key);
			merged[key] = value;
		}
	}
	return merged;
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

type RawMessagePingEvent = { type: "ping" };
type AnthropicStreamEvent = RawMessageStreamEvent | RawMessagePingEvent;
const ANTHROPIC_PING_EVENT: RawMessagePingEvent = { type: "ping" };

function createAnthropicSseStreamError(data: string): Error {
	try {
		const parsed = JSON.parse(data) as { error?: { type?: unknown; message?: unknown } };
		const errorType = typeof parsed?.error?.type === "string" ? parsed.error.type : undefined;
		const message = typeof parsed?.error?.message === "string" ? parsed.error.message : undefined;
		if (message) {
			return new AIError.ProviderResponseError(
				errorType ? `Anthropic stream error (${errorType}): ${message}` : `Anthropic stream error: ${message}`,
				{ provider: "anthropic", kind: "output" },
			);
		}
	} catch {}
	return new AIError.ProviderResponseError(data, { provider: "anthropic", kind: "output" });
}

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
	onSseEvent?: AnthropicOptions["onSseEvent"],
): AsyncGenerator<AnthropicStreamEvent> {
	if (!response.body) {
		throw new AIError.AnthropicStreamEnvelopeError("Attempted to iterate over an Anthropic response with no body");
	}

	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const sse of readSseEvents(response.body, signal)) {
		notifyRawSseEvent(onSseEvent, sse);
		if (sse.event === "error") {
			throw createAnthropicSseStreamError(sse.data);
		}

		if (sse.event === "ping") {
			yield ANTHROPIC_PING_EVENT;
			continue;
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(sse.data);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new AIError.AnthropicStreamEnvelopeError(
				`could not parse recognized SSE event ${sse.event}: ${message}`,
			);
		}
		if (!isRecord(parsed) || typeof parsed.type !== "string") {
			throw new AIError.AnthropicStreamEnvelopeError(
				`recognized SSE event ${sse.event} did not contain a string event type`,
			);
		}
		if (parsed.type !== sse.event) {
			throw new AIError.AnthropicStreamEnvelopeError(
				`event type ${parsed.type} does not match SSE event ${sse.event}`,
			);
		}
		const event = parsed as RawMessageStreamEvent;
		if (event.type === "message_start") {
			sawMessageStart = true;
		} else if (event.type === "message_stop") {
			sawMessageEnd = true;
		}
		yield event;
	}

	if (sawMessageStart && !sawMessageEnd && !signal?.aborted) {
		reportAnthropicEnvelopeAnomaly("stream ended before message_stop");
	}
}

type AnthropicRawResponseRequest = {
	asResponse(): Promise<Response>;
};

function hasAnthropicRawResponseRequest(request: unknown): request is AnthropicRawResponseRequest {
	return isRecord(request) && typeof request.asResponse === "function";
}

type AnthropicStreamWithResponseRequest = {
	withResponse(): Promise<{
		data: AsyncIterable<RawMessageStreamEvent>;
		response: Response;
		request_id: string | null;
	}>;
};

function hasAnthropicStreamWithResponseRequest(request: unknown): request is AnthropicStreamWithResponseRequest {
	return isRecord(request) && typeof request.withResponse === "function";
}

async function getAnthropicStreamResponse(
	request: unknown,
	signal?: AbortSignal,
	onSseEvent?: AnthropicOptions["onSseEvent"],
): Promise<{
	events: AsyncIterable<AnthropicStreamEvent>;
	response: Response;
	requestId: string | null;
	recordsRawSseEvents: boolean;
}> {
	if (hasAnthropicRawResponseRequest(request)) {
		const response = await request.asResponse();
		return {
			events: iterateAnthropicEvents(response, signal, onSseEvent),
			response,
			requestId: response.headers.get("request-id"),
			recordsRawSseEvents: true,
		};
	}
	if (hasAnthropicStreamWithResponseRequest(request)) {
		const { data, response, request_id } = await request.withResponse();
		return { events: data, response, requestId: request_id, recordsRawSseEvents: false };
	}
	throw new AIError.AnthropicStreamEnvelopeError("Anthropic SDK request did not expose a stream response");
}

async function* observeDecodedAnthropicSdkEvents(
	events: AsyncIterable<AnthropicStreamEvent>,
	observer: (event: RawSseEvent) => void,
): AsyncGenerator<AnthropicStreamEvent> {
	for await (const event of events) {
		const data = JSON.stringify(event);

		notifyRawSseEvent(observer, { event: event.type, data, raw: [`event: ${event.type}`, `data: ${data}`] });
		yield event;
	}
}

const PROVIDER_MAX_RETRIES = 10;

const PING_PROGRESS_MAX_IDLE_MULTIPLIER = 3;

function reportAnthropicEnvelopeAnomaly(detail: string): void {
	logger.warn(`anthropic: ignoring malformed stream envelope: ${detail}`);
}

function shouldIgnoreAnthropicPreambleEvent(eventType: unknown): boolean {
	if (typeof eventType !== "string") return false;
	if (eventType === "ping") return true;
	return !ANTHROPIC_MESSAGE_EVENTS.has(eventType);
}

const THINKING_ENVELOPE_OPEN = "<thinking>";
const THINKING_ENVELOPE_CLOSE = "</thinking>";

function unwrapAnthropicThinkingEnvelope(text: string): string | undefined {
	let current = text.trim();
	let stripped = false;
	while (current.startsWith(THINKING_ENVELOPE_OPEN) && current.endsWith(THINKING_ENVELOPE_CLOSE)) {
		current = current.slice(THINKING_ENVELOPE_OPEN.length, current.length - THINKING_ENVELOPE_CLOSE.length).trim();
		stripped = true;
	}
	return stripped ? current : undefined;
}

function createEmptyUsage(premiumRequests?: number): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		...(premiumRequests === undefined ? {} : { premiumRequests }),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export type AnthropicUsageLike = {
	cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
	server_tool_use?: { web_search_requests?: number | null; web_fetch_requests?: number | null } | null;
};

export function applyAnthropicUsageExtras(usage: Usage, source: AnthropicUsageLike): void {
	const cacheCreation = source.cache_creation;
	if (cacheCreation != null) {
		const fiveMinute = cacheCreation.ephemeral_5m_input_tokens ?? 0;
		const oneHour = cacheCreation.ephemeral_1h_input_tokens ?? 0;
		if (fiveMinute > 0 || oneHour > 0) {
			usage.cttl = {
				...(fiveMinute > 0 ? { ephemeral5m: fiveMinute } : {}),
				...(oneHour > 0 ? { ephemeral1h: oneHour } : {}),
			};
		} else {
			delete usage.cttl;
		}
	}
	const serverToolUse = source.server_tool_use;
	if (serverToolUse != null) {
		const webSearch = serverToolUse.web_search_requests ?? 0;
		const webFetch = serverToolUse.web_fetch_requests ?? 0;
		if (webSearch > 0 || webFetch > 0) {
			usage.server = {
				...(webSearch > 0 ? { webSearch } : {}),
				...(webFetch > 0 ? { webFetch } : {}),
			};
		} else {
			delete usage.server;
		}
	}
}

function parseAnthropicWireUsage(value: unknown): AnthropicWireUsage | undefined {
	if (!isRecord(value)) return undefined;
	const cacheCreation = isRecord(value.cache_creation)
		? {
				...(typeof value.cache_creation.ephemeral_5m_input_tokens === "number"
					? { ephemeral_5m_input_tokens: value.cache_creation.ephemeral_5m_input_tokens }
					: {}),
				...(typeof value.cache_creation.ephemeral_1h_input_tokens === "number"
					? { ephemeral_1h_input_tokens: value.cache_creation.ephemeral_1h_input_tokens }
					: {}),
			}
		: undefined;
	return {
		...(typeof value.input_tokens === "number" ? { input_tokens: value.input_tokens } : {}),
		...(typeof value.output_tokens === "number" ? { output_tokens: value.output_tokens } : {}),
		...(typeof value.cache_read_input_tokens === "number"
			? { cache_read_input_tokens: value.cache_read_input_tokens }
			: {}),
		...(typeof value.cache_creation_input_tokens === "number"
			? { cache_creation_input_tokens: value.cache_creation_input_tokens }
			: {}),
		...(cacheCreation === undefined ? {} : { cache_creation: cacheCreation }),
	};
}

function parseAnthropicFallbackWireBlock(value: unknown): AnthropicFallbackContent | undefined {
	if (!isRecord(value) || value.type !== "fallback") return undefined;
	const from = isRecord(value.from) && typeof value.from.model === "string" ? value.from.model : undefined;
	const to = isRecord(value.to) && typeof value.to.model === "string" ? value.to.model : undefined;
	if (!from?.trim() || !to?.trim()) return undefined;
	return { type: "fallback", from: { model: from }, to: { model: to } };
}

const ANTHROPIC_COMPACTION_MIN_TRIGGER_TOKENS = 50_000;

export function resolvesToOfficialAnthropicEndpoint(model: Model<"anthropic-messages">): boolean {
	return isOfficialAnthropicApiUrl(resolveAnthropicBaseUrl(model));
}

export function supportsAnthropicCompaction(model: Model<"anthropic-messages">, effectiveBaseUrl?: string): boolean {
	if (!isCompactionCapableModel(model)) return false;
	if (model.remoteCompaction?.enabled === true) return true;
	if (
		model.transport === "pi-native" &&
		model.compat.firstPartyProvider === true &&
		(effectiveBaseUrl === undefined || effectiveBaseUrl === normalizeAnthropicBaseUrl(model.baseUrl))
	) {
		return true;
	}
	return (
		model.compat.firstPartyProvider === true &&
		(effectiveBaseUrl === undefined
			? resolvesToOfficialAnthropicEndpoint(model)
			: isOfficialAnthropicApiUrl(effectiveBaseUrl))
	);
}

export function supportsAnthropicCompactionOnClient(
	model: Model<"anthropic-messages">,
	client: AnthropicMessagesClientLike,
): boolean {
	const baseURL = injectedClientBaseUrl(client);
	if (baseURL !== undefined) return supportsAnthropicCompaction(model, baseURL);
	return isCompactionCapableModel(model) && model.remoteCompaction?.enabled === true;
}

function injectedClientBaseUrl(client: AnthropicMessagesClientLike): string | undefined {
	const baseURL = (client as { baseURL?: unknown }).baseURL;
	return typeof baseURL === "string" && baseURL.length > 0 ? baseURL : undefined;
}

function isCompactionCapableModel(model: Model<"anthropic-messages">): boolean {
	return (
		model.compat.supportsServerCompaction === true &&
		model.compat.supportsContextManagement !== false &&
		model.remoteCompaction?.enabled !== false
	);
}

function isReplayableAnthropicCompaction(
	payload: ProviderPayload | undefined,
	model: Model<"anthropic-messages">,
): payload is AnthropicCompactionPayload {
	return payload?.type === "anthropicCompaction" && payload.provider === model.provider && payload.content.length > 0;
}

function compactionBlockParam(payload: AnthropicCompactionPayload): CompactionBlockParam {
	const { content, encryptedContent } = payload;
	return { type: "compaction", content, ...(encryptedContent ? { encrypted_content: encryptedContent } : {}) };
}

function contextReplaysAnthropicCompaction(messages: readonly Message[], model: Model<"anthropic-messages">): boolean {
	return messages.some(
		message =>
			(message.role === "user" || message.role === "developer" || message.role === "assistant") &&
			isReplayableAnthropicCompaction(message.providerPayload, model),
	);
}

function buildAnthropicCompactionEdit(options: AnthropicOptions | undefined): CompactionEdit | undefined {
	const request = options?.anthropicCompaction;
	if (!request) return undefined;
	const edit: CompactionEdit = { type: "compact_20260112" };
	if (request.triggerInputTokens !== undefined && Number.isFinite(request.triggerInputTokens)) {
		edit.trigger = {
			type: "input_tokens",
			value: Math.max(ANTHROPIC_COMPACTION_MIN_TRIGGER_TOKENS, Math.floor(request.triggerInputTokens)),
		};
	}
	if (request.pauseAfterCompaction !== undefined) edit.pause_after_compaction = request.pauseAfterCompaction;
	if (request.instructions) edit.instructions = request.instructions;
	return edit;
}

function buildAnthropicCompactionReplayEdit(model: Model<"anthropic-messages">): CompactionEdit {
	return {
		type: "compact_20260112",
		trigger: {
			type: "input_tokens",
			value: Math.max(ANTHROPIC_COMPACTION_MIN_TRIGGER_TOKENS, model.contextWindow ?? 0),
		},
	};
}

function carriesCompactionEdit(params: MessageCreateParams): boolean {
	return params.context_management?.edits.some(edit => edit.type === "compact_20260112") ?? false;
}

function applyCompactionIterationUsage(usage: Usage, source: AnthropicWireUsage): boolean {
	const iterations = source.iterations;
	if (!iterations?.some(iteration => iteration?.type === "compaction")) return false;
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	for (const iteration of iterations) {
		if (!iteration) continue;
		input += iteration.input_tokens ?? 0;
		output += iteration.output_tokens ?? 0;
		cacheRead += iteration.cache_read_input_tokens ?? 0;
		cacheWrite += iteration.cache_creation_input_tokens ?? 0;
	}
	usage.input = input;
	usage.output = output;
	usage.cacheRead = cacheRead;
	usage.cacheWrite = cacheWrite;
	for (let index = iterations.length - 1; index >= 0; index -= 1) {
		const resumed = iterations[index];
		if (resumed?.type !== "message" && resumed?.type !== "fallback_message") continue;
		usage.contextTokens =
			(resumed.input_tokens ?? 0) +
			(resumed.cache_read_input_tokens ?? 0) +
			(resumed.cache_creation_input_tokens ?? 0);
		break;
	}
	return true;
}

function fallbackServedModelFromUsage(source: AnthropicWireUsage): string | undefined {
	const iterations = source.iterations ?? [];
	for (let index = iterations.length - 1; index >= 0; index -= 1) {
		const iteration = iterations[index];
		if (iteration?.type === "fallback_message" && iteration.model?.trim()) return iteration.model;
	}
	return undefined;
}

function resolveIterationModel(
	requestModel: Model<"anthropic-messages">,
	iterationModelId: string | null | undefined,
): Model<Api> {
	const id = iterationModelId?.trim();
	if (!id || id === requestModel.id) return requestModel;

	if (requestModel.provider === "anthropic") {
		const bundled = getBundledModel("anthropic", id);
		if (bundled?.api === "anthropic-messages") return bundled;
	}
	return requestModel;
}

function calculateIterationTurnCost(
	requestModel: Model<"anthropic-messages">,
	usage: Usage,
	source: AnthropicWireUsage,
	timestamp: number,
): boolean {
	const iterations = source.iterations ?? [];
	if (iterations.length === 0) return false;
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const hasFallbackMessage = iterations.some(iter => iter.type === "fallback_message");
	let applied = false;
	for (const iteration of iterations) {
		const inputTokens = iteration.input_tokens ?? 0;
		const outputTokens = iteration.output_tokens ?? 0;
		const cacheReadTokens = iteration.cache_read_input_tokens ?? 0;
		const cacheWriteTokens = iteration.cache_creation_input_tokens ?? 0;
		const isFallback = iteration.type === "fallback_message";
		if (hasFallbackMessage && !isFallback && outputTokens === 0 && cacheWriteTokens === 0) continue;
		const iterationUsage = createEmptyUsage();
		if (isFallback) {
			iterationUsage.input = 0;
			iterationUsage.cacheRead = cacheReadTokens + inputTokens;
		} else {
			iterationUsage.input = inputTokens;
			iterationUsage.cacheRead = cacheReadTokens;
		}
		iterationUsage.output = outputTokens;
		iterationUsage.cacheWrite = cacheWriteTokens;
		iterationUsage.totalTokens =
			iterationUsage.input + iterationUsage.output + iterationUsage.cacheRead + iterationUsage.cacheWrite;
		calculateCost(resolveIterationModel(requestModel, iteration.model), iterationUsage, timestamp);
		cost.input += iterationUsage.cost.input;
		cost.output += iterationUsage.cost.output;
		cost.cacheRead += iterationUsage.cost.cacheRead;
		cost.cacheWrite += iterationUsage.cost.cacheWrite;
		cost.total += iterationUsage.cost.total;
		applied = true;
	}
	if (!applied) return false;
	usage.cost = cost;
	return true;
}

const INVALID_THINKING_SIGNATURE_PATTERN = /invalid\s+`?signature`?\s+in\s+`?thinking`?(?:\s+block)?/i;
const MISSING_THINKING_SIGNATURE_PATTERN = /thinking\.signature\b[^"\n]{0,32}\brequired\b/i;
const THINKING_PREFIX_BINDING_PATTERN =
	/(?:bound to a different conversation|block_binding\.prefix_mismatch_behavior|prefix_mismatch_behavior)/i;

export function isThinkingPrefixBindingError(message: string): boolean {
	return INVALID_THINKING_SIGNATURE_PATTERN.test(message) && THINKING_PREFIX_BINDING_PATTERN.test(message);
}

export function isInvalidThinkingSignatureError(message: string): boolean {
	return INVALID_THINKING_SIGNATURE_PATTERN.test(message) || MISSING_THINKING_SIGNATURE_PATTERN.test(message);
}

const INPUT_TRANSFORMATION_PATH_PATTERN = /^messages\.(\d+)\.content\.(\d+)$/;
const PREFIX_BINDING_ERROR_PATH_PATTERN = /messages\.(\d+)\.content\.(\d+)/;

function thinkingReplayKey(block: ContentBlockParam): string | undefined {
	if (block.type === "thinking") return block.signature ? `thinking:${block.signature}` : undefined;
	if (block.type === "redacted_thinking") return block.data ? `redacted:${block.data}` : undefined;
	return undefined;
}

function rememberPrefixDroppedThinking(
	params: MessageCreateParamsStreaming,
	transformations: readonly ProviderInputTransformation[],
	state: AnthropicProviderSessionState | undefined,
): void {
	if (!state) return;
	let firstMessageIndex: number | undefined;
	let firstBlockIndex: number | undefined;
	for (const transformation of transformations) {
		if (transformation.reason !== "prefix_binding_mismatch" || typeof transformation.path !== "string") continue;
		const match = INPUT_TRANSFORMATION_PATH_PATTERN.exec(transformation.path);
		if (!match) continue;
		const messageIndex = Number(match[1]);
		const blockIndex = Number(match[2]);
		if (
			firstMessageIndex === undefined ||
			messageIndex < firstMessageIndex ||
			(messageIndex === firstMessageIndex && blockIndex < (firstBlockIndex ?? Number.POSITIVE_INFINITY))
		) {
			firstMessageIndex = messageIndex;
			firstBlockIndex = blockIndex;
		}
	}
	if (firstMessageIndex === undefined || firstBlockIndex === undefined) return;
	for (let messageIndex = firstMessageIndex; messageIndex < params.messages.length; messageIndex++) {
		const message = params.messages[messageIndex];
		if (!message || !Array.isArray(message.content)) continue;
		const blockStart = messageIndex === firstMessageIndex ? firstBlockIndex : 0;
		for (let blockIndex = blockStart; blockIndex < message.content.length; blockIndex++) {
			const key = thinkingReplayKey(message.content[blockIndex]!);
			if (key) state.prefixDroppedThinkingBlocks.add(key);
		}
	}
}

function rememberPrefixBindingFailure(
	params: MessageCreateParamsStreaming,
	message: string,
	state: AnthropicProviderSessionState | undefined,
): boolean {
	if (!state) return false;
	const match = PREFIX_BINDING_ERROR_PATH_PATTERN.exec(message);
	let path = match ? `messages.${match[1]}.content.${match[2]}` : undefined;
	if (!path) {
		for (let messageIndex = 0; messageIndex < params.messages.length && !path; messageIndex++) {
			const candidate = params.messages[messageIndex];
			if (!candidate || !Array.isArray(candidate.content)) continue;
			const blockIndex = candidate.content.findIndex(block => thinkingReplayKey(block) !== undefined);
			if (blockIndex >= 0) path = `messages.${messageIndex}.content.${blockIndex}`;
		}
	}
	if (!path) return false;
	rememberPrefixDroppedThinking(
		params,
		[{ type: "thinking_dropped", reason: "prefix_binding_mismatch", path }],
		state,
	);
	return true;
}

function applyReportedInputTransformations(
	output: AssistantMessage,
	params: MessageCreateParamsStreaming,
	state: AnthropicProviderSessionState | undefined,
	value: unknown,
	seen: Set<string>,
	replace = false,
): void {
	if (value === undefined || value === null) return;
	if (replace) {
		seen.clear();
		output.inputTransformations = [];
	}
	const fresh: ProviderInputTransformation[] = [];
	for (const transformation of parseAnthropicInputTransformations(value)) {
		const key = JSON.stringify(transformation);
		if (seen.has(key)) continue;
		seen.add(key);
		fresh.push(transformation);
	}
	if (fresh.length === 0) return;
	output.inputTransformations = [...(output.inputTransformations ?? []), ...fresh];
	rememberPrefixDroppedThinking(params, fresh, state);
	for (const transformation of fresh) {
		if (transformation.reason !== "prefix_binding_mismatch") continue;
		logger.warn("anthropic: dropped thinking block after conversation prefix changed", {
			model: output.model,
			path: transformation.path,
		});
	}
}

export function maybeAddReplayUnsignedThinkingHint(model: Model<"anthropic-messages">, message: string): string {
	if (!isInvalidThinkingSignatureError(message) || isThinkingPrefixBindingError(message)) return message;
	if (model.compat.officialEndpoint) return message;
	if (model.compatConfig?.replayUnsignedThinking !== undefined) return message;
	const hint = `Provider "${model.provider}" looks like an Anthropic-compatible signing proxy: it rejected a replayed unsigned thinking block. Set \`compat.replayUnsignedThinking: false\` under \`providers.${model.provider}\` in your models.yml and retry. See https://github.com/myanvoos/proto`;
	return `${hint}\n\n${message}`;
}

function createSdkStreamRequestOptions(
	signal: AbortSignal,
	streamFirstEventTimeoutMs: number | undefined,
): { signal: AbortSignal; timeout?: number; maxRetries?: number } {
	if (streamFirstEventTimeoutMs === undefined) return { signal };
	if (!Number.isFinite(streamFirstEventTimeoutMs)) return { signal };
	if (streamFirstEventTimeoutMs <= 0) return { signal };
	return { signal, timeout: Math.trunc(streamFirstEventTimeoutMs), maxRetries: 0 };
}

const streamAnthropicOnce = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: createEmptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let rawRequestDump: RawHttpRequestDump | undefined;
		let activeAbortTracker = createAbortSourceTracker(options?.signal);

		const onSseEvent = options?.onSseEvent;
		const rawSseObserver = onSseEvent ? (event: RawSseEvent) => onSseEvent(event, model) : undefined;

		try {
			const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
			const copilotApiKey = model.provider === "github-copilot" ? parseGitHubCopilotApiKey(apiKey) : undefined;
			const copilotBaseUrl = copilotApiKey
				? (resolveAnthropicBaseUrl(model, apiKey) ?? "https://api.anthropic.com")
				: undefined;
			const copilotCacheKey = copilotApiKey ? getCopilotIntegrationCacheKey(apiKey, copilotBaseUrl) : undefined;
			const copilotCached = copilotApiKey ? getCachedCopilotIntegrationId(copilotCacheKey) : undefined;
			const copilotDynamicHeaders = copilotApiKey
				? buildCopilotDynamicHeaders({
						messages: context.messages,
						hasImages: hasCopilotVisionInput(context.messages),
						premiumMultiplier: model.premiumMultiplier,
						headers: { ...(model.headers ?? {}), ...(options?.headers ?? {}) },
						initiatorOverride: options?.initiatorOverride,
						enterpriseUrl: copilotApiKey.enterpriseUrl,
						integrationId: resolveCopilotRequestIdentity(options?.headers),
						cachedIntegrationId: copilotCached,
					})
				: undefined;
			if (copilotDynamicHeaders?.premiumRequests !== undefined) {
				output.usage.premiumRequests = copilotDynamicHeaders.premiumRequests;
			}
			const baseUrl = copilotBaseUrl ?? resolveAnthropicBaseUrl(model, apiKey) ?? "https://api.anthropic.com";
			const supportsEagerToolInputStreaming = resolveEagerToolInputStreamingSupport(model, baseUrl);
			const compactionSupported = options?.client
				? supportsAnthropicCompactionOnClient(model, options.client)
				: supportsAnthropicCompaction(model, baseUrl);
			const providerSessionState = getAnthropicProviderSessionState(
				options?.providerSessionState,
				baseUrl,
				model.id,
			);
			let disableStrictTools =
				(providerSessionState?.strictToolsDisabled ?? false) || (model.compat?.disableStrictTools ?? false);
			let dropFastMode = providerSessionState?.fastModeDisabled ?? false;
			let forceDemoteUnsignedThinking = providerSessionState?.replayUnsignedThinkingDisabled ?? false;
			let droppedAllThinkingForSignature = providerSessionState?.thinkingReplayDisabled ?? false;
			let dropAllThinking = droppedAllThinkingForSignature;
			let prefixBindingRetryAttempted = false;
			let prefixMismatchBehavior =
				model.thinking?.prefixBinding && model.compat.supportsThinkingBindingControls
					? (options?.anthropicPrefixMismatchBehavior ?? "drop_block")
					: undefined;
			const controlBetas = resolveAnthropicControlBetas(model, prefixMismatchBehavior);
			const mergedCallerHeaders = mergeHeaders(model.headers, options?.headers);
			const umansGatewayWebSearchHeader = getUmansWebSearchHeader(model, mergedCallerHeaders);

			let fallbacks = options?.fallbacks;
			if (
				model.provider === "google-vertex" &&
				fallbacks?.some(entry => entry.output_config?.effort !== undefined)
			) {
				fallbacks = fallbacks.map(entry => {
					const outputConfig = entry.output_config;
					if (outputConfig?.effort === undefined) return entry;
					return {
						...entry,
						output_config:
							outputConfig.task_budget === undefined ? undefined : { task_budget: outputConfig.task_budget },
					};
				});
			}

			const zeroOutputCacheRefresh = options?.anthropicCacheRefreshRequest === true;
			let client: AnthropicMessagesClientLike;
			let isOAuthToken: boolean;
			// Retained so a Claude Code version bump can rebuild the client fingerprint headers.
			let clientArgs: AnthropicClientOptionsArgs | undefined;

			if (options?.client) {
				client = options.client;
				isOAuthToken = false;
			} else {
				const extraBetas = normalizeExtraBetas(options?.betas);
				const wantsAnthropicPriority = model.provider === "anthropic" && options?.serviceTier === "priority";

				if (wantsAnthropicPriority && !dropFastMode && !extraBetas.includes(fastModeBeta)) {
					extraBetas.push(fastModeBeta);
				}
				if (options?.taskBudget && !extraBetas.includes(taskBudgetBeta)) {
					extraBetas.push(taskBudgetBeta);
				}

				const sendsAdaptiveEffortPin =
					isAdaptiveOnlyThinking(model) &&
					(options?.thinkingEnabled === false ||
						(model.compat.supportsForcedToolChoice && isForcedToolChoice(options?.toolChoice)));
				if (
					model.reasoning &&
					model.provider !== "google-vertex" &&
					((options?.thinkingEnabled && options.effort !== "adaptive") || sendsAdaptiveEffortPin) &&
					!extraBetas.includes(effortBeta)
				) {
					extraBetas.push(effortBeta);
				}
				if (!isVertexRawPredictUrl(baseUrl)) {
					for (const beta of controlBetas) {
						if (!extraBetas.includes(beta)) extraBetas.push(beta);
					}
				}

				if (
					model.reasoning &&
					options?.thinkingEnabled &&
					model.compat.supportsContextManagement &&
					!extraBetas.includes(contextManagementBeta)
				) {
					extraBetas.push(contextManagementBeta);
				}

				if (
					compactionSupported &&
					(options?.anthropicCompaction !== undefined ||
						contextReplaysAnthropicCompaction(context.messages, model)) &&
					!isVertexRawPredictUrl(baseUrl) &&
					!extraBetas.includes(COMPACTION_BETA)
				) {
					extraBetas.push(COMPACTION_BETA);
				}
				const isOAuth = options?.isOAuth ?? isAnthropicOAuthToken(apiKey);
				if (
					!isOAuth &&
					getCacheControl(model, options?.cacheRetention, isOAuth).cacheControl?.ttl === "1h" &&
					!extraBetas.includes(extendedCacheTtlBeta)
				) {
					extraBetas.push(extendedCacheTtlBeta);
				}

				if (fallbacks?.length) {
					if (!extraBetas.includes(serverSideFallbackBeta)) {
						extraBetas.push(serverSideFallbackBeta);
					}
					for (const entry of fallbacks) {
						if (entry.speed === "fast" && !extraBetas.includes(fastModeBeta)) {
							extraBetas.push(fastModeBeta);
						}
						if (entry.output_config?.effort && !extraBetas.includes(effortBeta)) {
							extraBetas.push(effortBeta);
						}
						if (entry.output_config?.task_budget && !extraBetas.includes(taskBudgetBeta)) {
							extraBetas.push(taskBudgetBeta);
						}
					}
				}

				clientArgs = {
					model,
					apiKey,
					extraBetas,
					stream: !zeroOutputCacheRefresh,
					interleavedThinking: options?.interleavedThinking ?? true,
					headers: options?.headers,
					dynamicHeaders: copilotDynamicHeaders?.headers,
					isOAuth: options?.isOAuth,
					hasTools: !!context.tools?.length,
					thinkingEnabled: options?.thinkingEnabled,
					thinkingDisplay: options?.thinkingDisplay,
					fetch: options?.fetch,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					sessionId:
						options?.sessionId ??
						extractClaudeMetadataSessionId(options?.metadata?.user_id) ??
						options?.promptCacheKey,
					disableStrictTools,
					copilotCacheKey,
					copilotCacheSnapshot: copilotApiKey ? (copilotCached ?? null) : undefined,
				};
				const created = createClient(model, clientArgs);
				client = created.client;
				isOAuthToken = created.isOAuthToken;
			}
			const preparedContext = await prepareAnthropicManyImageContext(context, model.input.includes("image"));
			const prepareParams = async (): Promise<MessageCreateParamsStreaming> => {
				let nextParams = buildParams(model, preparedContext, isOAuthToken, options, {
					compactionSupported,
					disableStrictTools,
					useUmansGatewayWebSearch: umansGatewayWebSearchHeader !== undefined,
					forceDemoteUnsignedThinking,
					supportsEagerToolInputStreaming,
					prefixMismatchBehavior,
					dropAllThinking,
					droppedThinkingBlocks: providerSessionState?.prefixDroppedThinkingBlocks,
					providerSessionState,
					fallbacks,
					effectiveBaseUrl: baseUrl,
				});
				if (disableStrictTools) {
					dropAnthropicStrictTools(nextParams);
				}
				if (dropFastMode) {
					dropAnthropicFastMode(nextParams);
				}
				const replacementPayload = await options?.onPayload?.(nextParams, model);
				if (replacementPayload !== undefined) {
					nextParams = replacementPayload as typeof nextParams;
				}
				nextParams = toWellFormedDeep(nextParams) as typeof nextParams;
				rawRequestDump = {
					provider: model.provider,
					api: output.api,
					model: model.id,
					method: "POST",
					url: `${baseUrl}/v1/messages${isOAuthToken ? "?beta=true" : ""}`,
					body: nextParams,
				};
				return nextParams;
			};
			let params = await prepareParams();
			const seenInputTransformations = new Set<string>();
			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs(model.compat.streamIdleTimeoutMs);
			const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs);
			const requestTimeoutMs =
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;

			if (zeroOutputCacheRefresh) {
				const refreshParams: MessageCreateParams = { ...params, max_tokens: 0, stream: false };
				// Anthropic rejects a forced `tool_choice` with `max_tokens: 0`; a zero-output keep-alive
				// produces no tokens, so the replayed forced selector is meaningless here.
				const refreshChoiceType = refreshParams.tool_choice?.type;
				if (refreshChoiceType === "tool" || refreshChoiceType === "any") {
					delete refreshParams.tool_choice;
				}
				rawRequestDump = {
					provider: model.provider,
					api: output.api,
					model: model.id,
					method: "POST",
					url: `${baseUrl}/v1/messages${isOAuthToken ? "?beta=true" : ""}`,
					body: refreshParams,
				};
				const { requestSignal } = activeAbortTracker;
				const refreshBetaRouteUrl =
					options?.client !== undefined ? (injectedClientBaseUrl(options.client) ?? baseUrl) : baseUrl;
				const refreshHeaders =
					options?.client !== undefined &&
					!isVertexRawPredictUrl(refreshBetaRouteUrl) &&
					carriesCompactionEdit(refreshParams)
						? mergeAnthropicBetaHeader(mergedCallerHeaders, COMPACTION_BETA)
						: undefined;
				const requestOptions = {
					...createSdkStreamRequestOptions(requestSignal, requestTimeoutMs),
					maxRetries: 0,
					...(refreshHeaders ? { headers: refreshHeaders } : {}),
				};
				const request: unknown =
					isOAuthToken && client.beta
						? client.beta.messages.create(refreshParams, requestOptions)
						: client.messages.create(refreshParams, requestOptions);
				if (!hasAnthropicRawResponseRequest(request)) {
					throw new AIError.AnthropicStreamEnvelopeError(
						"Anthropic cache refresh request did not expose a raw response",
					);
				}
				const response = await request.asResponse();
				await notifyProviderResponse(options, response, model, response.headers.get("request-id"));
				const body: unknown = await response.json();
				if (!isRecord(body)) {
					throw new AIError.AnthropicStreamEnvelopeError("Anthropic cache refresh returned a malformed response");
				}
				const wireUsage = parseAnthropicWireUsage(body.usage);
				if (!wireUsage) {
					throw new AIError.AnthropicStreamEnvelopeError("Anthropic cache refresh response omitted usage");
				}
				if (typeof body.id === "string") output.responseId = body.id;
				applyReportedInputTransformations(
					output,
					params,
					providerSessionState,
					body.input_transformations,
					seenInputTransformations,
				);
				output.usage.input = wireUsage.input_tokens ?? 0;
				output.usage.output = wireUsage.output_tokens ?? 0;
				output.usage.cacheRead = wireUsage.cache_read_input_tokens ?? 0;
				output.usage.cacheWrite = wireUsage.cache_creation_input_tokens ?? 0;
				applyAnthropicUsageExtras(output.usage, wireUsage);
				output.usage.totalTokens =
					output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
				calculateCost(model, output.usage, output.timestamp);
				output.duration = performance.now() - startTime;
				stream.push({ type: "start", partial: output });
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
				return;
			}

			const serverSideFallback = !!fallbacks?.length;
			type Block = (
				| ThinkingContent
				| RedactedThinkingContent
				| TextContent
				| AnthropicFallbackContent
				| (AnthropicServerToolContent & { [kStreamingPartialJson]?: string })
				| (ToolCall & { [kStreamingPartialJson]: string; [kStreamingLastParseLen]?: number })
			) & { [kStreamingBlockIndex]: number };
			const blocks = output.content as Block[];
			const finalizeStreamBlock = (block: Block, contentIndex: number): boolean => {
				if (block.type === "text") {
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
					return true;
				} else if (block.type === "thinking") {
					const unwrappedThinking = unwrapAnthropicThinkingEnvelope(block.thinking);
					if (unwrappedThinking !== undefined) {
						block.thinking = unwrappedThinking;
						block.thinkingSignature = undefined;
					} else if (!output.upstreamModel && block.thinkingSignature) {
						// The signature names the model that produced the block; a gateway serving a different
						// model than requested cannot mint one that says otherwise.
						output.upstreamModel = servedModelFromAnthropicSignature(block.thinkingSignature);
					}
					stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
					return true;
				} else if (block.type === "anthropicServerTool" && block.block.type === "server_tool_use") {
					const partialJson = block[kStreamingPartialJson];
					if (partialJson) {
						try {
							const input = parseJsonWithRepair(partialJson);
							if (isRecord(input)) {
								block.block.input = input;
							} else {
								reportAnthropicEnvelopeAnomaly("server_tool_use input is not a JSON object");
							}
						} catch (parseError) {
							reportAnthropicEnvelopeAnomaly(
								`server_tool_use ${block.block.id} input is not valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
							);
						}
					}
					clearStreamingPartialJson(block);
					return true;
				} else if (block.type === "toolCall") {
					const finalJson =
						block[kStreamingPartialJson].length > 0
							? block[kStreamingPartialJson]
							: JSON.stringify(block.arguments ?? {});
					if (classifyJsonPrefix(finalJson) === "prefix") {
						reportAnthropicEnvelopeAnomaly(`tool_use ${block.id} ended before its input JSON was complete`);
						return false;
					}
					try {
						block.arguments = parseJsonWithRepair(finalJson) as ToolCall["arguments"];
					} catch (parseError) {
						reportAnthropicEnvelopeAnomaly(
							`tool_use ${block.id} arguments are not valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
						);
						const recoveredKeys = Object.keys(block.arguments ?? {});
						if (recoveredKeys.length === 0) {
							const maxLen = 512;
							const truncatedJson =
								finalJson.length <= maxLen
									? finalJson
									: `${finalJson.slice(0, maxLen)}… [truncated ${finalJson.length - maxLen} chars]`;
							block.arguments = {
								__parseError: parseError instanceof Error ? parseError.message : String(parseError),
								__rawJson: truncatedJson,
							};
						}
					}
					clearStreamingPartialJson(block);
					stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
					return true;
				}
				return true;
			};
			stream.push({ type: "start", partial: output });

			let providerRetryAttempt = 0;
			const firstEventTimeoutAbortError = new AIError.StreamTimeoutError(
				"Anthropic stream timed out while waiting for the first event",
			);
			const idleTimeoutAbortError = new AIError.StreamTimeoutError(
				"Anthropic stream stalled while waiting for the next event",
			);
			while (true) {
				activeAbortTracker = createAbortSourceTracker(options?.signal);
				const { requestSignal } = activeAbortTracker;
				let injectedClientBetaHeaders: Record<string, string> | undefined;
				const injectedBetaRouteUrl =
					options?.client !== undefined ? (injectedClientBaseUrl(options.client) ?? baseUrl) : baseUrl;
				if (options?.client !== undefined && !isVertexRawPredictUrl(injectedBetaRouteUrl)) {
					for (const beta of controlBetas) {
						injectedClientBetaHeaders = mergeAnthropicBetaHeader(
							injectedClientBetaHeaders ?? mergedCallerHeaders,
							beta,
						);
					}
					if ((params.output_config as AnthropicOutputConfig | undefined)?.effort !== undefined) {
						injectedClientBetaHeaders = mergeAnthropicBetaHeader(
							injectedClientBetaHeaders ?? mergedCallerHeaders,
							effortBeta,
						);
					}
					if (carriesCompactionEdit(params)) {
						injectedClientBetaHeaders = mergeAnthropicBetaHeader(
							injectedClientBetaHeaders ?? mergedCallerHeaders,
							COMPACTION_BETA,
						);
					}
				}
				const perRequestHeaders =
					umansGatewayWebSearchHeader || injectedClientBetaHeaders
						? { ...umansGatewayWebSearchHeader, ...injectedClientBetaHeaders }
						: undefined;
				const requestOptions = {
					...createSdkStreamRequestOptions(requestSignal, requestTimeoutMs),
					maxRetries: 0,
					...(perRequestHeaders ? { headers: perRequestHeaders } : {}),
				};
				const anthropicRequest: unknown =
					isOAuthToken && client.beta
						? client.beta.messages.create({ ...params, stream: true }, requestOptions)
						: client.messages.create({ ...params, stream: true }, requestOptions);
				let streamedReplayUnsafeContent = false;

				try {
					let requestTimeout: NodeJS.Timeout | undefined;
					if (requestTimeoutMs !== undefined) {
						requestTimeout = setTimeout(
							() => activeAbortTracker.abortLocally(firstEventTimeoutAbortError),
							requestTimeoutMs,
						);
					}
					let anthropicStream: AsyncIterable<AnthropicStreamEvent>;
					let response: Response;
					let requestId: string | null;
					let recordsRawSseEvents: boolean;
					try {
						({
							events: anthropicStream,
							response,
							requestId,
							recordsRawSseEvents,
						} = await getAnthropicStreamResponse(anthropicRequest, requestSignal, rawSseObserver));
					} catch (error) {
						if (error instanceof AnthropicConnectionTimeoutError && !activeAbortTracker.wasCallerAbort()) {
							throw firstEventTimeoutAbortError;
						}
						throw error;
					} finally {
						if (requestTimeout !== undefined) clearTimeout(requestTimeout);
					}
					await notifyProviderResponse(options, response, model, requestId);
					let sawEvent = false;
					let sawMessageStart = false;
					let sawTerminalEnvelope = false;
					let sawMessageStop = false;

					let sawSplicedEnvelope = false;
					const closedBlockIndexes = new Set<number>();
					let hasIncompleteToolCall = false;
					const openBlocks = new Map<
						number,
						{
							contentIndex: number;
							kind:
								| "text"
								| "thinking"
								| "redactedThinking"
								| "fallback"
								| "anthropicServerTool"
								| "toolCall"
								| "compaction"
								| "ignored";
						}
					>();
					let compactionContent: string | null | undefined;
					let compactionEncryptedContent: string | undefined;

					let sawNonPingEvent = false;
					let lastNonPingProgressAtMs = 0;
					const pingProgressCapMs =
						idleTimeoutMs !== undefined && idleTimeoutMs > 0
							? idleTimeoutMs * PING_PROGRESS_MAX_IDLE_MULTIPLIER
							: undefined;
					const timedAnthropicStream = iterateWithIdleTimeout(anthropicStream, {
						idleTimeoutMs,
						firstItemTimeoutMs: firstEventTimeoutMs,
						errorMessage: idleTimeoutAbortError.message,
						firstItemErrorMessage: firstEventTimeoutAbortError.message,
						onIdle: () => activeAbortTracker.abortLocally(idleTimeoutAbortError),
						onFirstItemTimeout: () => activeAbortTracker.abortLocally(firstEventTimeoutAbortError),
						abortSignal: options?.signal,
						isProgressItem: item => {
							if ((item as AnthropicStreamEvent).type === "ping") {
								if (!sawNonPingEvent) return false;
								if (pingProgressCapMs === undefined) return true;
								return Date.now() - lastNonPingProgressAtMs < pingProgressCapMs;
							}
							sawNonPingEvent = true;
							lastNonPingProgressAtMs = Date.now();
							return true;
						},
					});
					const observedAnthropicStream =
						rawSseObserver && !recordsRawSseEvents
							? observeDecodedAnthropicSdkEvents(timedAnthropicStream, rawSseObserver)
							: timedAnthropicStream;
					for await (const event of observedAnthropicStream) {
						sawEvent = true;

						if (event.type === "message_start") {
							if (sawMessageStart) {
								reportAnthropicEnvelopeAnomaly("duplicate message_start event");
								sawSplicedEnvelope = true;
								continue;
							}
							sawMessageStart = true;
							const startMessage = event.message;
							if (startMessage?.id) output.responseId = startMessage.id;
							applyReportedInputTransformations(
								output,
								params,
								providerSessionState,
								startMessage?.input_transformations,
								seenInputTransformations,
							);
							const startUsage = startMessage?.usage;
							if (startUsage) {
								applyAnthropicUsageExtras(output.usage, startUsage);
								output.usage.input = startUsage.input_tokens || 0;
								output.usage.output = startUsage.output_tokens || 0;
								output.usage.cacheRead = startUsage.cache_read_input_tokens || 0;
								output.usage.cacheWrite = startUsage.cache_creation_input_tokens || 0;
								const compacted = applyCompactionIterationUsage(output.usage, startUsage);
								output.usage.totalTokens =
									output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
								if (serverSideFallback) {
									const served = fallbackServedModelFromUsage(startUsage);
									if (served) output.model = served;
								}
								if (
									!(serverSideFallback || compacted) ||
									!calculateIterationTurnCost(model, output.usage, startUsage, output.timestamp)
								) {
									calculateCost(model, output.usage, output.timestamp);
								}
							} else {
								reportAnthropicEnvelopeAnomaly("message_start missing usage");
							}
							continue;
						}

						if (!sawMessageStart) {
							if (shouldIgnoreAnthropicPreambleEvent(event.type)) {
								continue;
							}
							throw new AIError.AnthropicStreamEnvelopeError(`received ${event.type} before message_start`);
						}

						if (event.type === "content_block_start") {
							if (sawTerminalEnvelope) {
								reportAnthropicEnvelopeAnomaly(`received ${event.type} after terminal stop signal`);
								continue;
							}
							if (openBlocks.has(event.index)) {
								reportAnthropicEnvelopeAnomaly(`duplicate content_block_start index ${event.index}`);
								continue;
							}
							if (sawSplicedEnvelope && closedBlockIndexes.has(event.index)) {
								reportAnthropicEnvelopeAnomaly(
									`replayed content_block_start index ${event.index} after duplicate message_start`,
								);
								openBlocks.set(event.index, { contentIndex: -1, kind: "ignored" });
								continue;
							}
							if (!event.content_block?.type) {
								reportAnthropicEnvelopeAnomaly("content_block_start missing content_block payload");
								continue;
							}
							if (!firstTokenTime) firstTokenTime = performance.now();
							if (event.content_block.type === "fallback") {
								const fallback = parseAnthropicFallbackWireBlock(event.content_block);
								if (!serverSideFallback || !fallback) {
									if (!fallback) {
										reportAnthropicEnvelopeAnomaly("fallback content_block missing model refs");
									}
									openBlocks.set(event.index, { contentIndex: -1, kind: "ignored" });
									continue;
								}
								const block: Block = { ...fallback, [kStreamingBlockIndex]: event.index };
								output.content.push(block);
								openBlocks.set(event.index, {
									contentIndex: output.content.length - 1,
									kind: "fallback",
								});

								output.model = fallback.to.model;
								continue;
							}
							if (event.content_block.type === "text") {
								streamedReplayUnsafeContent = true;
								const block: Block = {
									type: "text",
									text: "",
									[kStreamingBlockIndex]: event.index,
								};
								output.content.push(block);
								const contentIndex = output.content.length - 1;
								openBlocks.set(event.index, { contentIndex, kind: "text" });
								stream.push({
									type: "text_start",
									contentIndex,
									partial: output,
								});
							} else if (event.content_block.type === "thinking") {
								streamedReplayUnsafeContent = true;
								const block: Block = {
									type: "thinking",
									thinking: event.content_block.thinking ?? "",
									thinkingSignature: "",
									[kStreamingBlockIndex]: event.index,
								};
								output.content.push(block);
								const contentIndex = output.content.length - 1;
								openBlocks.set(event.index, { contentIndex, kind: "thinking" });
								stream.push({
									type: "thinking_start",
									contentIndex,
									partial: output,
								});
								if (block.thinking) {
									stream.push({
										type: "thinking_delta",
										contentIndex,
										delta: block.thinking,
										partial: output,
									});
								}
							} else if (event.content_block.type === "redacted_thinking") {
								streamedReplayUnsafeContent = true;
								const block: Block = {
									type: "redactedThinking",
									data: event.content_block.data,
									[kStreamingBlockIndex]: event.index,
								};
								output.content.push(block);
								openBlocks.set(event.index, {
									contentIndex: output.content.length - 1,
									kind: "redactedThinking",
								});
							} else if (
								isAnthropicServerToolHistoryBlock(event.content_block) &&
								(umansGatewayWebSearchHeader === undefined ||
									(event.content_block.type === "server_tool_use"
										? event.content_block.name !== "web_search"
										: event.content_block.type !== "web_search_tool_result"))
							) {
								streamedReplayUnsafeContent = true;
								const block: Block = {
									type: "anthropicServerTool",
									block: { ...event.content_block },
									[kStreamingPartialJson]: "",
									[kStreamingBlockIndex]: event.index,
								};
								output.content.push(block);
								openBlocks.set(event.index, {
									contentIndex: output.content.length - 1,
									kind: "anthropicServerTool",
								});
							} else if (event.content_block.type === "tool_use") {
								streamedReplayUnsafeContent = true;
								const block: Block = {
									type: "toolCall",
									id: event.content_block.id,
									name: decodeAnthropicToolName(
										event.content_block.name,
										isOAuthToken,
										model.compat.escapeBuiltinToolNames,
									),
									arguments: event.content_block.input ?? {},
									[kStreamingPartialJson]: "",
									[kStreamingBlockIndex]: event.index,
								};
								output.content.push(block);
								const contentIndex = output.content.length - 1;
								openBlocks.set(event.index, { contentIndex, kind: "toolCall" });
								stream.push({
									type: "toolcall_start",
									contentIndex,
									partial: output,
								});
							} else if (event.content_block.type === "compaction") {
								const started = event.content_block.content;
								compactionContent = typeof started === "string" && started.length > 0 ? started : undefined;
								compactionEncryptedContent = event.content_block.encrypted_content ?? undefined;
								openBlocks.set(event.index, { contentIndex: -1, kind: "compaction" });
							} else {
								openBlocks.set(event.index, { contentIndex: -1, kind: "ignored" });
							}
						} else if (event.type === "content_block_delta") {
							if (sawTerminalEnvelope) {
								reportAnthropicEnvelopeAnomaly(`received ${event.type} after terminal stop signal`);
								continue;
							}
							const openBlock = openBlocks.get(event.index);
							if (!openBlock) {
								reportAnthropicEnvelopeAnomaly(
									`received content_block_delta for unopened index ${event.index}`,
								);
								continue;
							}
							if (openBlock.kind === "ignored") continue;
							if (!event.delta?.type) {
								reportAnthropicEnvelopeAnomaly("content_block_delta missing delta payload");
								continue;
							}
							const block = blocks[openBlock.contentIndex];
							if (event.delta.type === "text_delta") {
								if (openBlock.kind !== "text" || block?.type !== "text") {
									reportAnthropicEnvelopeAnomaly(`received text_delta for ${openBlock.kind} block`);
									continue;
								}
								streamedReplayUnsafeContent = true;
								block.text += event.delta.text;
								stream.push({
									type: "text_delta",
									contentIndex: openBlock.contentIndex,
									delta: event.delta.text,
									partial: output,
								});
							} else if (event.delta.type === "thinking_delta") {
								if (openBlock.kind !== "thinking" || block?.type !== "thinking") {
									reportAnthropicEnvelopeAnomaly(`received thinking_delta for ${openBlock.kind} block`);
									continue;
								}
								streamedReplayUnsafeContent = true;
								block.thinking += event.delta.thinking;
								stream.push({
									type: "thinking_delta",
									contentIndex: openBlock.contentIndex,
									delta: event.delta.thinking,
									partial: output,
								});
							} else if (event.delta.type === "input_json_delta") {
								if (
									openBlock.kind === "anthropicServerTool" &&
									block?.type === "anthropicServerTool" &&
									block.block.type === "server_tool_use"
								) {
									block[kStreamingPartialJson] =
										(block[kStreamingPartialJson] ?? "") + event.delta.partial_json;
									continue;
								}
								if (openBlock.kind !== "toolCall" || block?.type !== "toolCall") {
									reportAnthropicEnvelopeAnomaly(`received input_json_delta for ${openBlock.kind} block`);
									continue;
								}
								streamedReplayUnsafeContent = true;
								block[kStreamingPartialJson] += event.delta.partial_json;
								const throttled = parseStreamingJsonThrottled(
									block[kStreamingPartialJson],
									block[kStreamingLastParseLen] ?? 0,
								);
								if (throttled) {
									block.arguments = throttled.value;
									block[kStreamingLastParseLen] = throttled.parsedLen;
								}
								stream.push({
									type: "toolcall_delta",
									contentIndex: openBlock.contentIndex,
									delta: event.delta.partial_json,
									partial: output,
								});
							} else if (event.delta.type === "signature_delta") {
								if (openBlock.kind !== "thinking" || block?.type !== "thinking") {
									reportAnthropicEnvelopeAnomaly(`received signature_delta for ${openBlock.kind} block`);
									continue;
								}
								streamedReplayUnsafeContent = true;
								block.thinkingSignature = block.thinkingSignature || "";
								block.thinkingSignature += event.delta.signature;
							} else if (event.delta.type === "compaction_delta") {
								if (openBlock.kind !== "compaction") {
									reportAnthropicEnvelopeAnomaly(`received compaction_delta for ${openBlock.kind} block`);
									continue;
								}
								compactionContent = event.delta.content ?? null;
								if (event.delta.encrypted_content) compactionEncryptedContent = event.delta.encrypted_content;
							}
						} else if (event.type === "content_block_stop") {
							if (sawTerminalEnvelope) {
								reportAnthropicEnvelopeAnomaly(`received ${event.type} after terminal stop signal`);
								continue;
							}
							const openBlock = openBlocks.get(event.index);
							if (!openBlock) {
								reportAnthropicEnvelopeAnomaly(`received content_block_stop for unopened index ${event.index}`);
								continue;
							}
							if (openBlock.kind === "ignored") {
								openBlocks.delete(event.index);
								continue;
							}
							if (openBlock.kind === "compaction") {
								openBlocks.delete(event.index);
								closedBlockIndexes.add(event.index);
								if (typeof compactionContent === "string" && compactionContent.length > 0) {
									output.providerPayload = {
										type: "anthropicCompaction",
										provider: model.provider,
										content: compactionContent,
										...(compactionEncryptedContent ? { encryptedContent: compactionEncryptedContent } : {}),
									};
								} else {
									logger.warn("anthropic: server-side compaction produced no summary", {
										model: model.id,
										reason: compactionContent === null ? "tool_call_during_summarization" : "empty",
									});
								}
								compactionContent = undefined;
								compactionEncryptedContent = undefined;
								continue;
							}
							const block = blocks[openBlock.contentIndex];
							if (!block || block.type !== openBlock.kind) {
								reportAnthropicEnvelopeAnomaly(`content_block_stop kind mismatch for index ${event.index}`);
								openBlocks.delete(event.index);
								continue;
							}
							openBlocks.delete(event.index);
							closedBlockIndexes.add(event.index);
							if (!finalizeStreamBlock(block, openBlock.contentIndex) && openBlock.kind === "toolCall") {
								hasIncompleteToolCall = true;
							}
						} else if (event.type === "message_delta") {
							if (sawTerminalEnvelope) {
								reportAnthropicEnvelopeAnomaly("received message_delta after terminal stop signal");
								continue;
							}
							const delta = event.delta;
							applyReportedInputTransformations(
								output,
								params,
								providerSessionState,
								event.input_transformations,
								seenInputTransformations,
								true,
							);
							const rawStopReason = delta?.stop_reason;
							if (rawStopReason) {
								output.stopReason = mapStopReason(rawStopReason);
								sawTerminalEnvelope = true;
								if (rawStopReason === "compaction") output.stopDetails = { type: "compaction" };
							}
							if (output.stopReason === "error") {
								const stopDetails = delta?.stop_details;
								output.stopDetails = stopDetails ?? (rawStopReason ? { type: rawStopReason } : null);
								if (stopDetails?.type === "refusal") {
									const explanation = stopDetails.explanation?.trim();
									const category = stopDetails.category;
									const label = category ? `Refusal (${category})` : "Refusal";
									output.errorMessage = explanation ? `${label}: ${explanation}` : label;
								} else if (!output.errorMessage) {
									output.errorMessage =
										rawStopReason === "refusal"
											? "Refusal (no details provided)"
											: rawStopReason === "sensitive"
												? "Content flagged by safety filters"
												: `Anthropic stream ended with stop_reason: ${rawStopReason ?? "unknown"}`;
								}
							}
							const deltaUsage = event.usage;
							if (deltaUsage) {
								if (deltaUsage.input_tokens != null) {
									output.usage.input = deltaUsage.input_tokens;
								}
								if (deltaUsage.output_tokens != null) {
									output.usage.output = deltaUsage.output_tokens;
								}
								if (deltaUsage.cache_read_input_tokens != null) {
									output.usage.cacheRead = deltaUsage.cache_read_input_tokens;
								}
								if (deltaUsage.cache_creation_input_tokens != null) {
									output.usage.cacheWrite = deltaUsage.cache_creation_input_tokens;
								}
								applyAnthropicUsageExtras(output.usage, deltaUsage);
								const compacted = applyCompactionIterationUsage(output.usage, deltaUsage);
								output.usage.totalTokens =
									output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
								if (serverSideFallback) {
									const served = fallbackServedModelFromUsage(deltaUsage);
									if (served) output.model = served;
								}
								if (
									!(serverSideFallback || compacted) ||
									!calculateIterationTurnCost(model, output.usage, deltaUsage, output.timestamp)
								) {
									calculateCost(model, output.usage, output.timestamp);
								}
							}
						} else if (event.type === "message_stop") {
							sawTerminalEnvelope = true;
							sawMessageStop = true;

							break;
						}
					}

					const firstEventTimeoutError = activeAbortTracker.getLocalAbortReason();
					if (firstEventTimeoutError) {
						throw firstEventTimeoutError;
					}
					if (activeAbortTracker.wasCallerAbort()) {
						throw new AIError.AbortError();
					}
					if (!sawEvent || !sawMessageStart) {
						throw new AIError.AnthropicStreamEnvelopeError("stream ended before message_start");
					}
					if (!sawTerminalEnvelope) {
						throw new AIError.AnthropicStreamEnvelopeError("stream ended before message_stop");
					}
					if (!sawMessageStop) {
						reportAnthropicEnvelopeAnomaly("stream ended before message_stop");
					}
					if (openBlocks.size > 0) {
						for (const [openIndex, openBlock] of openBlocks) {
							reportAnthropicEnvelopeAnomaly(
								`stream ended with an unterminated ${openBlock.kind} block at index ${openIndex}`,
							);
							if (openBlock.kind === "ignored" || openBlock.contentIndex < 0) continue;
							const danglingBlock = blocks[openBlock.contentIndex];
							if (danglingBlock && !finalizeStreamBlock(danglingBlock, openBlock.contentIndex)) {
								if (openBlock.kind === "toolCall") hasIncompleteToolCall = true;
							}
						}
						openBlocks.clear();
					}
					if (hasIncompleteToolCall) {
						output.stopReason = "error";
						output.errorMessage = "Anthropic stream ended before a tool-call input JSON value was complete";
					}

					if (output.stopReason === "aborted" || output.stopReason === "error") {
						throw new AIError.ProviderResponseError(output.errorMessage ?? "An unknown error occurred", {
							provider: model.provider,
							kind: "output",
						});
					}
					break;
				} catch (streamError) {
					const streamFailure = activeAbortTracker.getLocalAbortReason() ?? streamError;
					if (
						isOAuthToken &&
						clientArgs &&
						firstTokenTime === undefined &&
						adoptRequiredClaudeCodeVersion(streamFailure)
					) {
						logger.warn("anthropic: Claude Code version rejected as too old, retrying with required version", {
							model: model.id,
							version: getClaudeCodeVersion(),
						});
						client = createClient(model, { ...clientArgs, disableStrictTools }).client;
						params = await prepareParams();
						providerRetryAttempt = 0;
						output.content.length = 0;
						output.model = model.id;
						output.responseId = undefined;
						output.upstreamModel = undefined;
						output.errorMessage = undefined;
						output.providerPayload = undefined;
						output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
						output.stopReason = "stop";
						firstTokenTime = undefined;
						continue;
					}
					if (
						!disableStrictTools &&
						firstTokenTime === undefined &&
						hasStrictAnthropicTools(params) &&
						AIError.isGrammarError(streamFailure)
					) {
						logger.warn("anthropic: strict tools rejected, retrying without strict tools", {
							model: model.id,
							error: await finalizeErrorMessage(streamFailure, rawRequestDump),
						});
						if (providerSessionState) {
							providerSessionState.strictToolsDisabled = true;
						}
						disableStrictTools = true;
						params = await prepareParams();
						providerRetryAttempt = 0;
						output.content.length = 0;
						output.model = model.id;
						output.responseId = undefined;
						output.upstreamModel = undefined;
						output.errorMessage = undefined;
						output.providerPayload = undefined;
						output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
						output.stopReason = "stop";
						firstTokenTime = undefined;
						continue;
					}
					const streamFailureMessage =
						streamFailure instanceof Error ? streamFailure.message : String(streamFailure);
					if (
						!prefixBindingRetryAttempted &&
						options?.anthropicPrefixMismatchBehavior !== "error" &&
						firstTokenTime === undefined &&
						!streamedReplayUnsafeContent &&
						isThinkingPrefixBindingError(streamFailureMessage)
					) {
						logger.warn("anthropic: thinking prefix changed, stripping bound thinking and retrying", {
							provider: model.provider,
							model: model.id,
							baseUrl,
						});
						prefixBindingRetryAttempted = true;
						prefixMismatchBehavior = undefined;
						dropAllThinking = !rememberPrefixBindingFailure(params, streamFailureMessage, providerSessionState);
						params = await prepareParams();
						providerRetryAttempt = 0;
						output.content.length = 0;
						output.model = model.id;
						output.responseId = undefined;
						output.upstreamModel = undefined;
						output.errorMessage = undefined;
						output.inputTransformations = undefined;
						output.providerPayload = undefined;
						output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
						output.stopReason = "stop";
						firstTokenTime = undefined;
						continue;
					}
					if (
						!forceDemoteUnsignedThinking &&
						firstTokenTime === undefined &&
						!streamedReplayUnsafeContent &&
						!isThinkingPrefixBindingError(streamFailureMessage) &&
						isInvalidThinkingSignatureError(streamFailureMessage)
					) {
						logger.warn(
							"anthropic: signing proxy detected (thinking signature rejected), demoting unsigned thinking and retrying",
							{
								provider: model.provider,
								model: model.id,
								baseUrl,
								error: streamFailureMessage,
							},
						);
						if (providerSessionState) {
							providerSessionState.replayUnsignedThinkingDisabled = true;
						}
						forceDemoteUnsignedThinking = true;
						params = await prepareParams();
						providerRetryAttempt = 0;
						output.content.length = 0;
						output.model = model.id;
						output.responseId = undefined;
						output.upstreamModel = undefined;
						output.errorMessage = undefined;
						output.providerPayload = undefined;
						output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
						output.stopReason = "stop";
						firstTokenTime = undefined;
						continue;
					}
					if (
						!dropAllThinking &&
						firstTokenTime === undefined &&
						!streamedReplayUnsafeContent &&
						!isThinkingPrefixBindingError(streamFailureMessage) &&
						isInvalidThinkingSignatureError(streamFailureMessage)
					) {
						logger.warn(
							"anthropic: thinking signatures still rejected after unsigned demotion, dropping replayed thinking and retrying",
							{
								provider: model.provider,
								model: model.id,
								baseUrl,
								error: streamFailureMessage,
							},
						);
						if (providerSessionState) {
							providerSessionState.thinkingReplayDisabled = true;
						}
						droppedAllThinkingForSignature = true;
						dropAllThinking = true;
						params = await prepareParams();
						providerRetryAttempt = 0;
						output.content.length = 0;
						output.model = model.id;
						output.responseId = undefined;
						output.upstreamModel = undefined;
						output.errorMessage = undefined;
						output.inputTransformations = undefined;
						output.providerPayload = undefined;
						output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
						output.stopReason = "stop";
						firstTokenTime = undefined;
						continue;
					}
					if (
						!dropFastMode &&
						model.provider === "anthropic" &&
						options?.serviceTier === "priority" &&
						firstTokenTime === undefined &&
						AIError.isFastModeUnsupported(streamFailure)
					) {
						logger.debug("anthropic: fast mode unsupported, retrying without speed", {
							model: model.id,
							error: streamFailure instanceof Error ? streamFailure.message : String(streamFailure),
						});
						if (providerSessionState) {
							providerSessionState.fastModeDisabled = true;
						}
						dropFastMode = true;
						params = await prepareParams();
						providerRetryAttempt = 0;
						output.content.length = 0;
						output.model = model.id;
						output.responseId = undefined;
						output.upstreamModel = undefined;
						output.errorMessage = undefined;
						output.providerPayload = undefined;
						output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
						output.stopReason = "stop";
						firstTokenTime = undefined;
						continue;
					}
					const isTransientEnvelopeFailure =
						AIError.isTransientStreamParseError(streamFailure) || AIError.isStreamEnvelopeError(streamFailure);
					const isLocalIdleTimeout =
						streamFailure === idleTimeoutAbortError ||
						(streamFailure instanceof Error && streamFailure.message === idleTimeoutAbortError.message);
					const canRetryTransientEnvelopeFailure = isTransientEnvelopeFailure && !streamedReplayUnsafeContent;
					const canRetryProviderFailure =
						!isLocalIdleTimeout &&
						firstTokenTime === undefined &&
						!streamedReplayUnsafeContent &&
						AIError.isProviderRetryableError(streamFailure);
					if (
						activeAbortTracker.wasCallerAbort() ||
						providerRetryAttempt >= PROVIDER_MAX_RETRIES ||
						(!canRetryTransientEnvelopeFailure && !canRetryProviderFailure)
					) {
						throw streamFailure;
					}
					providerRetryAttempt++;
					const backoffDelayMs = calculateAnthropicRetryDelayMs(providerRetryAttempt - 1);
					const headerDelayMs = getRetryAfterMsFromHeaders(getHeadersFromError(streamFailure));

					const maxRetryDelayMs = options?.maxRetryDelayMs ?? 60_000;
					if (headerDelayMs !== undefined && maxRetryDelayMs > 0 && headerDelayMs > maxRetryDelayMs) {
						throw streamFailure;
					}
					const delayMs = headerDelayMs !== undefined ? Math.max(headerDelayMs, backoffDelayMs) : backoffDelayMs;
					if (options?.providerRetryWait) {
						await options.providerRetryWait(delayMs, options.signal);
					} else {
						await scheduler.wait(delayMs, { signal: options?.signal });
					}
					output.content.length = 0;
					output.model = model.id;
					output.responseId = undefined;
					output.upstreamModel = undefined;
					output.errorMessage = undefined;
					output.stopDetails = undefined;
					output.providerPayload = undefined;
					output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
					output.stopReason = "stop";
					firstTokenTime = undefined;
				}
			}
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			if (dropFastMode && model.provider === "anthropic" && options?.serviceTier === "priority") {
				output.disabledFeatures = [...(output.disabledFeatures ?? []), "priority"];
			}
			if (forceDemoteUnsignedThinking && model.compat.replayUnsignedThinking) {
				output.disabledFeatures = [...(output.disabledFeatures ?? []), "unsigned-thinking-replay"];
			}
			if (droppedAllThinkingForSignature) {
				output.disabledFeatures = [...(output.disabledFeatures ?? []), "thinking-replay"];
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if (block.type === "toolCall") clearStreamingPartialJson(block);
			}
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				abortTracker: activeAbortTracker,
				rawRequestDump,
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = maybeAddReplayUnsignedThinkingHint(model, result.message);
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamAnthropic: StreamFunction<"anthropic-messages"> = (model, context, options) =>
	withReplaySafeStreamRetry(model, context, options, streamAnthropicOnce, { retryEmptyCompletion: true });

export type AnthropicSystemBlock = {
	type: "text";
	text: string;
	cache_control?: AnthropicCacheControl;
};
type SystemBlockOptions = {
	includeClaudeCodeInstruction?: boolean;
	extraInstructions?: string[];

	firstUserMessageText?: string;
	cacheControl?: AnthropicCacheControl;
};

export function buildAnthropicSystemBlocks(
	systemPrompt: readonly string[] | undefined,
	options: SystemBlockOptions = {},
): AnthropicSystemBlock[] | undefined {
	const { includeClaudeCodeInstruction = false, extraInstructions = [], firstUserMessageText, cacheControl } = options;
	const sanitizedPrompts = normalizeSystemPrompts(systemPrompt);
	const trimmedInstructions = extraInstructions.map(instruction => instruction.trim()).filter(Boolean);
	const hasBillingHeader = sanitizedPrompts.some(prompt => prompt.startsWith(CLAUDE_BILLING_HEADER_PREFIX));

	if (includeClaudeCodeInstruction && !hasBillingHeader) {
		const blocks: AnthropicSystemBlock[] = [
			{ type: "text", text: createClaudeBillingHeader(firstUserMessageText ?? "") },
			{
				type: "text",
				text: claudeCodeSystemInstruction,
				cache_control: cacheControl ? cloneAnthropicCacheControl(cacheControl) : { type: "ephemeral" },
			},
		];

		for (const instruction of trimmedInstructions) {
			blocks.push({ type: "text", text: instruction });
		}
		for (const prompt of sanitizedPrompts) {
			blocks.push({ type: "text", text: prompt });
		}

		return blocks;
	}

	const blocks: AnthropicSystemBlock[] = [];
	for (const instruction of trimmedInstructions) {
		blocks.push({ type: "text", text: instruction });
	}
	for (const prompt of sanitizedPrompts) {
		blocks.push({ type: "text", text: prompt });
	}
	return blocks.length > 0 ? blocks : undefined;
}

export function normalizeExtraBetas(betas?: string[] | string): string[] {
	if (!betas) return [];
	const raw = Array.isArray(betas) ? betas : betas.split(",");
	return raw.map(beta => beta.trim()).filter(beta => beta.length > 0);
}

export function buildAnthropicClientOptions(args: AnthropicClientOptionsArgs): AnthropicClientOptionsResult {
	const {
		model,
		apiKey,
		extraBetas = [],
		stream = true,
		interleavedThinking = true,
		headers,
		dynamicHeaders,
		hasTools = false,
		thinkingEnabled = false,
		isOAuth,
		maxRetryDelayMs,
		sessionId,
		disableStrictTools: disableStrictToolsOverride,
		copilotCacheKey,
		copilotCacheSnapshot,
	} = args;
	const compat = model.compat;
	const disableStrictTools = disableStrictToolsOverride ?? compat.disableStrictTools;
	const baseUrl = resolveAnthropicBaseUrl(model, apiKey);

	const needsInterleavedBeta =
		interleavedThinking &&
		(!model.thinking?.supportsDisplay ||
			(!isOfficialAnthropicApiUrl(baseUrl) &&
				(isAnthropicSigningProxyUrl(baseUrl) || (compat.signingEndpoint && !compat.officialEndpoint)) &&
				!isVertexRawPredictUrl(baseUrl ?? "") &&
				!hostMatchesUrl(baseUrl, "githubCopilot")));
	const oauthToken = isOAuth ?? isAnthropicOAuthToken(apiKey);
	const supportsEagerToolInputStreaming = resolveEagerToolInputStreamingSupport(model, baseUrl);
	const needsFineGrainedToolStreamingBeta =
		hasTools && isOfficialAnthropicApiUrl(baseUrl) && !supportsEagerToolInputStreaming;
	const foundryCustomHeaders = resolveAnthropicCustomHeaders(model, baseUrl);
	const tlsFetchOptions = buildCoworkTlsFetchOptions(model, baseUrl);

	const fetchOptions: AnthropicFetchOptions = { ...(tlsFetchOptions ?? {}), timeout: false };
	const baseFetch = args.fetch ?? fetch;

	const cchFetch = oauthToken ? wrapFetchForCch(baseFetch) : baseFetch;
	if (model.provider === "github-copilot") {
		const copilotApiKey = parseGitHubCopilotApiKey(apiKey).accessToken;

		const betaFeatures = [...extraBetas];
		const defaultHeaders = mergeHeaders(
			{
				Accept: stream ? "text/event-stream" : "application/json",
				"Content-Type": "application/json",
				"anthropic-version": "2023-06-01",
				"Anthropic-Dangerous-Direct-Browser-Access": "true",
				Authorization: `Bearer ${copilotApiKey}`,
				...(betaFeatures.length > 0 ? { "anthropic-beta": buildBetaHeader([], betaFeatures) } : {}),
			},
			model.headers,
			dynamicHeaders,
			headers,
		);
		applyInferenceHeaders(defaultHeaders, {
			provider: model.provider,
			protocol: "anthropic",
			sessionId,
		});

		return {
			isOAuthToken: false,
			apiKey: null,
			authToken: copilotApiKey,
			baseURL: baseUrl,
			maxRetries: 5,
			maxRetryDelayMs,
			defaultHeaders,
			fetch: wrapFetchForCopilotFallback(
				cchFetch,
				true,
				resolveCopilotRequestIdentity(headers),
				copilotCacheKey ?? getCopilotIntegrationCacheKey(apiKey, baseUrl),
				copilotCacheSnapshot,
			),
			fetchOptions,
		};
	}

	const betaFeatures = [...extraBetas];
	if (needsFineGrainedToolStreamingBeta) {
		betaFeatures.push(fineGrainedToolStreamingBeta);
	}
	if (needsInterleavedBeta) {
		betaFeatures.push(interleavedThinkingBeta);
	}

	const requestModelHeaders = mergeHeaders(
		model.headers,
		foundryCustomHeaders,
		getUmansWebSearchHeader(model, mergeHeaders(model.headers, headers)),
		headers,
		dynamicHeaders,
	);
	const defaultHeaders = buildAnthropicHeaders({
		apiKey,
		baseUrl,
		isOAuth: oauthToken,
		extraBetas: betaFeatures,
		stream,
		modelHeaders: requestModelHeaders,
		isCloudflareAiGateway: model.provider === "cloudflare-ai-gateway",
		allowAnthropicHeaderOverrides: model.compat.allowAnthropicHeaderOverrides,
		claudeCodeSessionId: sessionId,
		coworkBetas: oauthToken
			? buildCoworkBetas(
					hasTools || thinkingEnabled,
					thinkingEnabled,
					disableStrictTools,
					model.compat.supportsContextManagement,
				)
			: [],
	});
	applyInferenceHeaders(defaultHeaders, {
		provider: model.provider,
		protocol: "anthropic",
		sessionId,
	});

	if (model.provider === "cloudflare-ai-gateway") {
		return {
			isOAuthToken: false,
			apiKey: null,
			authToken: null,
			baseURL: baseUrl,
			maxRetries: 5,
			maxRetryDelayMs,
			defaultHeaders,
			fetch: cchFetch,
			fetchOptions,
		};
	}

	if (model.provider === "opencode-go" || model.provider === "opencode-zen" || model.provider === "umans") {
		delete defaultHeaders.Authorization;
		return {
			isOAuthToken: false,
			apiKey,
			authToken: null,
			baseURL: baseUrl,
			maxRetries: 5,
			maxRetryDelayMs,
			defaultHeaders,
			fetch: cchFetch,
			fetchOptions,
		};
	}

	const authorizationHeader = getHeaderCaseInsensitive(defaultHeaders, "Authorization");
	const shouldSuppressClientApiKey =
		!oauthToken && !model.compat.officialEndpoint && typeof authorizationHeader === "string";

	return {
		isOAuthToken: oauthToken,
		apiKey: oauthToken || shouldSuppressClientApiKey ? null : apiKey,
		authToken: oauthToken ? apiKey : undefined,
		baseURL: baseUrl,
		maxRetries: 5,
		maxRetryDelayMs,
		defaultHeaders,
		fetch: cchFetch,
		fetchOptions,
	};
}

function createClient(
	model: Model<"anthropic-messages">,
	args: AnthropicClientOptionsArgs,
): { client: AnthropicMessagesClient; isOAuthToken: boolean } {
	const { isOAuthToken: oauthToken, ...clientOptions } = buildAnthropicClientOptions({ ...args, model });
	const client = new AnthropicMessagesClient(clientOptions);
	return { client, isOAuthToken: oauthToken };
}

function disableThinkingIfToolChoiceForced(
	params: MessageCreateParamsStreaming,
	model: Model<"anthropic-messages">,
): void {
	const toolChoice = params.tool_choice;
	if (!toolChoice) return;
	if (toolChoice.type !== "any" && toolChoice.type !== "tool") return;

	delete params.thinking;
	const compactionEdits = params.context_management?.edits.filter(edit => edit.type === "compact_20260112") ?? [];
	if (compactionEdits.length > 0) {
		params.context_management = { edits: compactionEdits };
	} else {
		delete params.context_management;
	}

	if (isAdaptiveOnlyThinking(model) && model.provider !== "google-vertex") {
		const outputConfig = (params.output_config as AnthropicOutputConfig | undefined) ?? {};
		outputConfig.effort = "low";
		params.output_config = outputConfig;
		return;
	}

	const outputConfig = params.output_config as AnthropicOutputConfig | undefined;
	if (!outputConfig) return;

	delete outputConfig.effort;
	if (Object.keys(outputConfig).length === 0) {
		delete params.output_config;
	}
}

function ensureMaxTokensForThinking(params: MessageCreateParamsStreaming, maxAllowedTokens: number): void {
	const thinking = params.thinking;
	if (thinking?.type !== "enabled") return;

	const budgetTokens = thinking.budget_tokens ?? 0;
	if (budgetTokens <= 0) return;

	const currentMaxTokens = Math.min(params.max_tokens ?? maxAllowedTokens, maxAllowedTokens);
	const raisedMaxTokens = Math.min(
		Math.max(currentMaxTokens, budgetTokens + OUTPUT_FALLBACK_BUFFER),
		maxAllowedTokens,
	);
	params.max_tokens = raisedMaxTokens;

	if (budgetTokens + OUTPUT_FALLBACK_BUFFER <= raisedMaxTokens) return;

	const clampedBudget = raisedMaxTokens - OUTPUT_FALLBACK_BUFFER;
	if (clampedBudget <= 0) {
		throw new AIError.ConfigurationError(
			`Anthropic thinking budget requires max_tokens greater than ${OUTPUT_FALLBACK_BUFFER}; got ${raisedMaxTokens}`,
		);
	}
	thinking.budget_tokens = clampedBudget;
}

function applyCacheControlToLastBlock(blocks: ContentBlockParam[], cacheControl: AnthropicCacheControl): boolean {
	for (let index = blocks.length - 1; index >= 0; index--) {
		const block = blocks[index];

		// Anthropic rejects cache_control on reasoning, fallback boundaries, and tool-control blocks.
		if (
			block.type === "thinking" ||
			block.type === "redacted_thinking" ||
			block.type === "fallback" ||
			block.type === "tool_addition" ||
			block.type === "tool_removal"
		) {
			continue;
		}
		if ("cache_control" in block && block.cache_control != null) return false;
		blocks[index] = { ...block, cache_control: cloneAnthropicCacheControl(cacheControl) };
		return true;
	}
	return false;
}

const ANTHROPIC_MAX_BREAKPOINTS = 4;
const ANTHROPIC_DECIMATION_INTERVAL = 15;

function countHeadBreakpoints(params: MessageCreateParamsStreaming): number {
	let count = 0;
	if (Array.isArray(params.system)) {
		for (const block of params.system) {
			if (typeof block !== "string" && block?.cache_control != null) count++;
		}
	}
	if (Array.isArray(params.tools)) {
		for (const tool of params.tools) {
			if (tool?.cache_control != null) count++;
		}
	}
	return count;
}

function applyCacheControlToMessage(message: MessageParam, cacheControl: AnthropicCacheControl): boolean {
	if (typeof message.content === "string") {
		message.content = [
			{ type: "text", text: message.content, cache_control: cloneAnthropicCacheControl(cacheControl) },
		];
		return true;
	} else if (Array.isArray(message.content)) {
		return applyCacheControlToLastBlock(message.content, cacheControl);
	}
	return false;
}

function applyPromptCaching(params: MessageCreateParamsStreaming, cacheControl?: AnthropicCacheControl): void {
	if (!cacheControl) return;

	const headBreakpoints = countHeadBreakpoints(params);
	const messageBudget = Math.max(0, ANTHROPIC_MAX_BREAKPOINTS - headBreakpoints);
	if (messageBudget <= 0 || params.messages.length === 0) return;
	const trailingIndex = params.messages.length - 1;
	const trailingMessage = params.messages[trailingIndex];
	const hasTrailingAssistantPad =
		trailingMessage?.role === "user" &&
		trailingMessage.content === "Continue." &&
		!isConversationalUser(trailingMessage) &&
		params.messages[trailingIndex - 1]?.role === "assistant";
	const messageEnd = hasTrailingAssistantPad ? trailingIndex - 1 : trailingIndex;

	let stableMessageEnd = messageEnd;
	for (let index = 0; index <= messageEnd; index++) {
		const message = params.messages[index];
		if (message && (message.clear_at === "next_user_message" || isPerCallContextMessage(message))) {
			stableMessageEnd = index - 1;
			break;
		}
	}

	const userIndices: number[] = [];
	for (let index = 0; index <= stableMessageEnd; index++) {
		const message = params.messages[index];
		if (message && isConversationalUser(message)) {
			userIndices.push(index);
		}
	}

	const decimationIndices = userIndices.filter((_, ordinal) => (ordinal + 1) % ANTHROPIC_DECIMATION_INTERVAL === 0);

	const trailingCandidates: number[] = [];
	for (let index = messageEnd; index >= 0 && trailingCandidates.length < 2; index--) {
		const message = params.messages[index];
		if (!message || message.clear_at === "next_user_message" || isPerCallContextMessage(message)) continue;
		if (
			message.role === "system" &&
			typeof message.content !== "string" &&
			Array.isArray(message.content) &&
			message.content.length > 0 &&
			message.content.every(block => block.type === "tool_addition" || block.type === "tool_removal")
		) {
			continue;
		}
		trailingCandidates.push(index);
	}
	const candidateIndices: number[] = [];
	if (trailingCandidates.length > 0) {
		candidateIndices.push(trailingCandidates[0]);
	}
	for (let i = decimationIndices.length - 1; i >= 0; i--) {
		if (!candidateIndices.includes(decimationIndices[i])) {
			candidateIndices.push(decimationIndices[i]);
		}
	}
	if (stableMessageEnd < messageEnd && stableMessageEnd >= 0 && !candidateIndices.includes(stableMessageEnd)) {
		candidateIndices.push(stableMessageEnd);
	}
	for (const index of trailingCandidates) {
		if (!candidateIndices.includes(index)) {
			candidateIndices.push(index);
		}
	}

	let appliedCount = 0;
	for (const index of candidateIndices) {
		if (appliedCount >= messageBudget) break;
		const message = params.messages[index];
		if (message && applyCacheControlToMessage(message, cacheControl)) {
			appliedCount++;
		}
	}
}

const VOLATILE_SYSTEM_SEGMENT_MARKERS = ["<memories>"];

function stableSystemSuffixStart(systemBlocks: readonly AnthropicSystemBlock[]): number {
	let start = systemBlocks.length;
	while (start > 0) {
		const text = systemBlocks[start - 1]?.text ?? "";
		if (!VOLATILE_SYSTEM_SEGMENT_MARKERS.some(marker => text.startsWith(marker))) break;
		start--;
	}
	return start;
}

function applyHeadCaching(
	systemBlocks: AnthropicSystemBlock[] | undefined,
	tools: AnthropicWireTool[] | undefined,
	cacheControl?: AnthropicCacheControl,
): void {
	if (!cacheControl) return;

	if (tools && tools.length > 0 && !tools.some(tool => tool.cache_control != null)) {
		for (let index = tools.length - 1; index >= 0; index--) {
			const tool = tools[index];
			if (!tool || tool.defer_loading) continue;
			tool.cache_control = cloneAnthropicCacheControl(cacheControl);
			break;
		}
	}

	if (systemBlocks && systemBlocks.length > 0) {
		const suffixStart = stableSystemSuffixStart(systemBlocks);
		if (suffixStart === systemBlocks.length) {
			if (!systemBlocks.some(block => block.cache_control != null)) {
				const lastBlock = systemBlocks[systemBlocks.length - 1];
				if (lastBlock) lastBlock.cache_control = cloneAnthropicCacheControl(cacheControl);
			}
		} else {
			const anchorIndex = suffixStart === 0 ? systemBlocks.length - 1 : suffixStart - 1;
			const anchor = systemBlocks[anchorIndex];
			if (anchor && anchor.cache_control == null) anchor.cache_control = cloneAnthropicCacheControl(cacheControl);
		}
	}
}

function usesAdaptiveThinkingTagOnly(model: Model<"anthropic-messages">): boolean {
	const thinking = model.thinking;
	if (thinking?.mode !== "anthropic-adaptive") return false;
	const effortMap = thinking.effortMap;
	if (!effortMap) return false;
	for (const effort of thinking.efforts) {
		if (effortMap[effort] !== "adaptive") return false;
	}
	return thinking.efforts.length > 0;
}

function isAdaptiveOnlyThinking(model: Model<"anthropic-messages">): boolean {
	return (
		model.thinking?.mode === "anthropic-adaptive" &&
		!model.compat.disableAdaptiveThinking &&
		!usesAdaptiveThinkingTagOnly(model)
	);
}

function resolveAnthropicAdaptiveEffort(
	model: Model<"anthropic-messages">,
	options: AnthropicOptions,
): AnthropicEffort | undefined {
	if (options.effort) return usesAdaptiveThinkingTagOnly(model) ? "adaptive" : options.effort;
	const requestedEffort = options.reasoning;
	if (!requestedEffort) return undefined;
	return mapEffortToAnthropicAdaptiveEffort(model, requestedEffort);
}

function extractClaudeCodeFirstUserMessageText(messages: readonly Message[]): string {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const { content } = message;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		for (const block of content) {
			if (block.type === "text") return block.text;
		}
		return "";
	}
	return "";
}

const MAX_ANTHROPIC_CONTROL_STATES = 16;

function resetAnthropicControlState(state: AnthropicControlState): void {
	state.declaredTools = undefined;
	state.activeToolNames.clear();
	state.stableSystemBlocks = undefined;
	state.systemFingerprint = undefined;
	state.controlTransitions = [];
	state.effortBaselined = false;
	state.baseEffortWire = undefined;
	state.currentEffort = undefined;
}

function anthropicControlMessageProjection(message: MessageParam): MessageParam {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
	return {
		...message,
		content: message.content.filter(block => block.type !== "thinking" && block.type !== "redacted_thinking"),
	};
}

function getAnthropicControlState(
	state: AnthropicProviderSessionState | undefined,
	sessionId: string | undefined,
	system: readonly AnthropicSystemBlock[] | undefined,
	messages: readonly MessageParam[],
): AnthropicControlState | undefined {
	if (!state) return undefined;
	const root = messages[0];
	const stablePrefix = system?.slice(0, stableSystemSuffixStart(system)) ?? null;
	const fingerprint = String(
		Bun.hash(
			JSON.stringify([
				sessionId ?? "",
				stablePrefix?.map(block => block.text) ?? null,
				root ? anthropicControlMessageProjection(root) : null,
			]),
		),
	);
	const existing = state.controlStates.get(fingerprint);
	if (existing) {
		state.controlStates.delete(fingerprint);
		state.controlStates.set(fingerprint, existing);
		return existing;
	}
	const created = createAnthropicControlState();
	state.controlStates.set(fingerprint, created);
	if (state.controlStates.size > MAX_ANTHROPIC_CONTROL_STATES) {
		const oldest = state.controlStates.keys().next().value;
		if (oldest !== undefined) state.controlStates.delete(oldest);
	}
	return created;
}

function anthropicControlAnchor(messages: readonly MessageParam[], messageCount: number): string {
	if (messageCount === 0) return "";
	const message = messages[messageCount - 1];
	return message ? String(Bun.hash(JSON.stringify(anthropicControlMessageProjection(message)))) : "";
}

function syncAnthropicControlState(state: AnthropicControlState, messages: readonly MessageParam[]): void {
	for (const transition of state.controlTransitions) {
		if (
			transition.messageCount > messages.length ||
			transition.anchor !== anthropicControlAnchor(messages, transition.messageCount)
		) {
			resetAnthropicControlState(state);
			return;
		}
	}
}

function planStableAnthropicSystem(
	current: AnthropicSystemBlock[] | undefined,
	state: AnthropicControlState | undefined,
	enabled: boolean,
): AnthropicSystemBlock[] | undefined {
	if (!state || !enabled) return current;
	const suffixStart = stableSystemSuffixStart(current ?? []);
	const fingerprint = JSON.stringify(current?.slice(0, suffixStart).map(block => block.text) ?? null);
	if (state.systemFingerprint !== fingerprint) {
		resetAnthropicControlState(state);
		state.systemFingerprint = fingerprint;
		state.stableSystemBlocks = current?.slice(0, suffixStart).map(block => ({ type: block.type, text: block.text }));
	}
	const stableReplay =
		state.stableSystemBlocks?.map((block, index) => {
			const cacheControl = current?.[index]?.cache_control;
			return cacheControl ? { ...block, cache_control: cloneAnthropicCacheControl(cacheControl) } : { ...block };
		}) ?? [];
	const suffix = current?.slice(suffixStart).map(block => ({ ...block })) ?? [];
	const replayed = [...stableReplay, ...suffix];
	return replayed.length > 0 ? replayed : undefined;
}

function anthropicToolDefinitionKey(tool: AnthropicWireTool): string {
	const stable = { ...tool };
	delete stable.defer_loading;
	delete stable.description;
	return JSON.stringify(stable);
}

function cloneAnthropicTools(tools: readonly AnthropicWireTool[]): AnthropicWireTool[] {
	return tools.map(tool => ({ ...tool }));
}

function recordAnthropicControlTransition(
	state: AnthropicControlState,
	messages: readonly MessageParam[],
	messageCount: number,
	content: ContentBlockParam[],
	effort?: AnthropicOutputEffort,
): void {
	const existing = state.controlTransitions.findLast(transition => transition.messageCount === messageCount);
	if (existing) {
		existing.content.push(...content);
		if (effort !== undefined) existing.effort = effort;
		return;
	}
	state.controlTransitions.push({
		messageCount,
		anchor: anthropicControlAnchor(messages, messageCount),
		content,
		effort,
	});
}

function planStableAnthropicTools(
	current: AnthropicWireTool[] | undefined,
	messages: readonly MessageParam[],
	state: AnthropicControlState | undefined,
	enabled: boolean,
): AnthropicWireTool[] | undefined {
	if (!state || !enabled || !current) return current;
	if (!state.declaredTools) {
		state.declaredTools = cloneAnthropicTools(current);
		state.activeToolNames = new Set(current.map(tool => tool.name));
		return cloneAnthropicTools(state.declaredTools);
	}

	const declaredByName = new Map(state.declaredTools.map(tool => [tool.name, tool]));
	for (const tool of current) {
		const declared = declaredByName.get(tool.name);
		if (declared && anthropicToolDefinitionKey(declared) !== anthropicToolDefinitionKey(tool)) {
			resetAnthropicControlState(state);
			state.declaredTools = cloneAnthropicTools(current);
			state.activeToolNames = new Set(current.map(candidate => candidate.name));
			return cloneAnthropicTools(state.declaredTools);
		}
	}

	const nextActive = new Set(current.map(tool => tool.name));
	const changes: ContentBlockParam[] = [];
	for (const activeName of state.activeToolNames) {
		if (nextActive.has(activeName)) continue;
		changes.push({
			type: "tool_removal",
			tool: { type: "tool_reference", name: activeName },
		});
	}
	for (const tool of current) {
		if (state.activeToolNames.has(tool.name)) continue;
		if (!declaredByName.has(tool.name)) {
			const deferred = { ...tool, defer_loading: true };
			state.declaredTools.push(deferred);
			declaredByName.set(tool.name, deferred);
		}
		changes.push({
			type: "tool_addition",
			tool: { type: "tool_reference", name: tool.name },
		});
	}
	if (changes.length > 0) recordAnthropicControlTransition(state, messages, messages.length, changes);
	state.activeToolNames = nextActive;
	return cloneAnthropicTools(state.declaredTools);
}

function planStableAnthropicEffort(
	current: AnthropicOutputEffort | undefined,
	messages: readonly MessageParam[],
	state: AnthropicControlState | undefined,
	enabled: boolean,
): AnthropicOutputEffort | undefined {
	if (!state || !enabled) return current;
	// An omitted effort is the API's per-model default, tracked as its own state; a per-message
	// control cannot express "back to the default", so dropping the effort keeps the level in force.
	if (!state.effortBaselined) {
		state.effortBaselined = true;
		state.baseEffortWire = current;
		state.currentEffort = current;
		return current;
	}
	if (current !== undefined && state.currentEffort !== current) {
		const lastUserIndex = messages.findLastIndex(message => message.role === "user");
		const messageCount = lastUserIndex >= 0 ? lastUserIndex : messages.length;
		recordAnthropicControlTransition(state, messages, messageCount, [], current);
		state.currentEffort = current;
	}
	return state.baseEffortWire;
}

function materializeAnthropicControlTransitions(
	messages: MessageParam[],
	state: AnthropicControlState | undefined,
): MessageParam[] {
	if (!state || state.controlTransitions.length === 0) return messages;
	const result = messages.slice();
	const ordered = state.controlTransitions.toSorted((a, b) => a.messageCount - b.messageCount);
	let offset = 0;
	for (const transition of ordered) {
		const index = Math.min(transition.messageCount + offset, result.length);
		const previous = result[index - 1];
		if (previous?.role === "system" && previous.clear_at === undefined) {
			const content: ContentBlockParam[] =
				typeof previous.content === "string"
					? [{ type: "text", text: previous.content }, ...transition.content]
					: [...previous.content, ...transition.content];
			result[index - 1] = {
				...previous,
				content,
				...(transition.effort === undefined ? {} : { output_config: { effort: transition.effort } }),
			};
			continue;
		}
		result.splice(index, 0, {
			role: "system",
			content: transition.content.map(block => ({ ...block })),
			...(transition.effort === undefined ? {} : { output_config: { effort: transition.effort } }),
		});
		offset++;
	}
	return result;
}

type AnthropicParamBuildOptions = {
	disableStrictTools: boolean;
	useUmansGatewayWebSearch: boolean;
	forceDemoteUnsignedThinking: boolean;
	supportsEagerToolInputStreaming: boolean;
	prefixMismatchBehavior?: "drop_block" | "error";
	dropAllThinking: boolean;
	droppedThinkingBlocks?: ReadonlySet<string>;
	providerSessionState?: AnthropicProviderSessionState;
	fallbacks?: AnthropicOptions["fallbacks"];
	compactionSupported?: boolean;
	effectiveBaseUrl?: string;
};

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	options: AnthropicOptions | undefined,
	buildOptions: AnthropicParamBuildOptions,
): MessageCreateParamsStreaming {
	const {
		disableStrictTools,
		useUmansGatewayWebSearch,
		forceDemoteUnsignedThinking,
		supportsEagerToolInputStreaming,
		prefixMismatchBehavior,
		dropAllThinking,
		droppedThinkingBlocks,
		providerSessionState,
		fallbacks = options?.fallbacks,
		compactionSupported = supportsAnthropicCompaction(model),
		effectiveBaseUrl,
	} = buildOptions;

	const effectiveModel =
		forceDemoteUnsignedThinking && model.compat.replayUnsignedThinking
			? { ...model, compat: { ...model.compat, replayUnsignedThinking: false } }
			: model;
	const { cacheControl } = getCacheControl(model, options?.cacheRetention, isOAuthToken);

	const shouldInjectClaudeCodeInstruction = isOAuthToken && !model.id.startsWith("claude-3-5-haiku");
	const firstUserMessageText = shouldInjectClaudeCodeInstruction
		? extractClaudeCodeFirstUserMessageText(context.messages)
		: "";
	let systemBlocks = buildAnthropicSystemBlocks(context.systemPrompt, {
		includeClaudeCodeInstruction: shouldInjectClaudeCodeInstruction,
		firstUserMessageText,
		cacheControl,
	});

	let tools: AnthropicWireTool[] | undefined;
	if (context.tools) {
		tools = convertTools(
			context.tools,
			isOAuthToken,
			disableStrictTools || model.provider === "github-copilot",
			supportsEagerToolInputStreaming,
			model.compat.escapeBuiltinToolNames,
			useUmansGatewayWebSearch,
		);
	} else if (isOAuthToken) {
		tools = [];
	}

	const metadataAccountId = readAnthropicMetadataAccountId(options?.metadata);
	const metadataUserId = resolveAnthropicMetadataUserId(
		readMetadataString(options?.metadata, "user_id") ??
			(model.provider === "kimi-code" ? getOpenAIPromptCacheKey(options) : undefined),
		isOAuthToken,
		options?.sessionId,
		metadataAccountId,
	);
	const metadata = metadataUserId ? { user_id: metadataUserId } : undefined;

	let thinking: MessageCreateParamsStreaming["thinking"] | undefined;
	let outputConfigEffort: AnthropicOutputEffort | undefined;
	if (model.reasoning) {
		if (options?.thinkingEnabled || model.compat.requiresThinkingEnabled) {
			const thinkingOptions = options ?? {};
			const mode = model.thinking?.mode;
			const effort = resolveAnthropicAdaptiveEffort(model, thinkingOptions);
			const compat = model.compat;
			if (mode === "anthropic-adaptive" && !compat.disableAdaptiveThinking) {
				const adaptive: { type: "adaptive"; display?: AnthropicThinkingDisplay } = { type: "adaptive" };

				if (model.thinking?.supportsDisplay) {
					adaptive.display = thinkingOptions.thinkingDisplay ?? "summarized";
				}
				thinking = adaptive;
				if (effort && effort !== "adaptive") outputConfigEffort = effort;
			} else {
				thinking = {
					type: "enabled",
					budget_tokens: thinkingOptions.thinkingBudgetTokens || 1024,
					display: thinkingOptions.thinkingDisplay ?? "summarized",
				};
				if (mode === "anthropic-budget-effort" && effort && effort !== "adaptive") outputConfigEffort = effort;
			}
		} else if (options?.thinkingEnabled === false) {
			if (isAdaptiveOnlyThinking(model)) {
				outputConfigEffort = "low";
			} else {
				thinking = { type: "disabled" };
			}
		}
	}

	if (prefixMismatchBehavior) {
		if (!thinking && model.thinking?.mode === "anthropic-adaptive") {
			thinking = { type: "adaptive" };
		}
		if (thinking?.type === "adaptive" || thinking?.type === "enabled") {
			thinking.block_binding = { prefix_mismatch_behavior: prefixMismatchBehavior };
		}
	}

	const shouldKeepThinkingContext =
		!options?.client &&
		model.compat.supportsContextManagement &&
		(thinking?.type === "adaptive" || thinking?.type === "enabled");
	const compactionEdit = compactionSupported
		? (buildAnthropicCompactionEdit(options) ??
			(contextReplaysAnthropicCompaction(context.messages, model)
				? buildAnthropicCompactionReplayEdit(model)
				: undefined))
		: undefined;
	const contextManagementEdits: NonNullable<MessageCreateParams["context_management"]>["edits"] = [];
	if (shouldKeepThinkingContext) contextManagementEdits.push({ type: "clear_thinking_20251015", keep: "all" });
	if (compactionEdit) contextManagementEdits.push(compactionEdit);
	const contextManagement = contextManagementEdits.length > 0 ? { edits: contextManagementEdits } : undefined;

	let wireMessages = convertAnthropicMessages(context.messages, effectiveModel, isOAuthToken, {
		serverSideFallbackEnabled: !!fallbacks?.length,
		replayCompaction: compactionSupported,
		dropAllThinking,
		droppedThinkingBlocks,
	});
	const controlState = getAnthropicControlState(providerSessionState, options?.sessionId, systemBlocks, wireMessages);
	if (controlState) syncAnthropicControlState(controlState, wireMessages);
	systemBlocks = planStableAnthropicSystem(systemBlocks, controlState, model.compat.supportsMidConversationSystem);
	tools = planStableAnthropicTools(tools, wireMessages, controlState, model.compat.supportsMidConversationToolChanges);
	applyHeadCaching(systemBlocks, tools, cacheControl);
	const topLevelEffort = planStableAnthropicEffort(
		outputConfigEffort,
		wireMessages,
		controlState,
		model.compat.supportsPerMessageEffort,
	);
	wireMessages = materializeAnthropicControlTransitions(wireMessages, controlState);

	const outputConfigEntries: AnthropicOutputConfig = {};
	if (topLevelEffort && model.provider !== "google-vertex") outputConfigEntries.effort = topLevelEffort;
	if (options?.taskBudget) outputConfigEntries.task_budget = options.taskBudget;
	const outputConfig = Object.keys(outputConfigEntries).length ? outputConfigEntries : undefined;

	const modelMaxTokens = model.maxTokens ?? CLAUDE_CODE_MAX_OUTPUT_TOKENS;
	const maxOutputTokens = isOAuthToken ? Math.min(CLAUDE_CODE_MAX_OUTPUT_TOKENS, modelMaxTokens) : modelMaxTokens;

	const vertexRequestUrl =
		(options?.client !== undefined ? injectedClientBaseUrl(options.client) : undefined) ??
		effectiveBaseUrl ??
		model.baseUrl;
	const vertexControlBetas = isVertexRawPredictUrl(vertexRequestUrl)
		? resolveAnthropicControlBetas(model, prefixMismatchBehavior)
		: [];
	if (
		isVertexRawPredictUrl(vertexRequestUrl) &&
		compactionEdit !== undefined &&
		!vertexControlBetas.includes(COMPACTION_BETA)
	) {
		vertexControlBetas.push(COMPACTION_BETA);
	}

	const params: MessageCreateParamsStreaming = {
		model: options?.requestModelId ?? model.requestModelId ?? model.id,
		messages: wireMessages,
		...(systemBlocks && { system: systemBlocks }),
		...(tools !== undefined && { tools }),
		...(metadata && { metadata }),
		max_tokens: Math.min(maxOutputTokens, options?.maxTokens ?? modelMaxTokens),
		...(thinking && { thinking }),
		...(contextManagement && { context_management: contextManagement }),
		...(outputConfig && { output_config: outputConfig }),
		...(fallbacks?.length ? { fallbacks } : {}),
		...(vertexControlBetas.length > 0 ? { anthropic_beta: vertexControlBetas } : {}),
		stream: true,
	};

	const thinkingType = params.thinking?.type;
	const allowSamplingParams =
		model.compat.supportsSamplingParams && (thinkingType === undefined || thinkingType === "disabled");
	if (allowSamplingParams && options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}
	if (allowSamplingParams && options?.topP !== undefined) {
		params.top_p = options.topP;
	}
	if (allowSamplingParams && options?.topK !== undefined) {
		params.top_k = options.topK;
	}
	if (options?.stopSequences?.length) {
		const seqs = options.stopSequences;
		if (seqs.length > ANTHROPIC_STOP_SEQUENCES_MAX && !warnedStopSequencesTrim) {
			warnedStopSequencesTrim = true;
			logger.warn("anthropic: stop_sequences exceeds 4; extra entries dropped", {
				received: seqs.length,
				kept: ANTHROPIC_STOP_SEQUENCES_MAX,
			});
		}
		params.stop_sequences =
			seqs.length > ANTHROPIC_STOP_SEQUENCES_MAX ? seqs.slice(0, ANTHROPIC_STOP_SEQUENCES_MAX) : seqs;
	}

	if (model.provider === "anthropic" && options?.serviceTier === "priority") {
		params.speed = "fast";
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else if (options.toolChoice.name) {
			params.tool_choice = {
				...options.toolChoice,
				name: encodeAnthropicToolName(
					options.toolChoice.name,
					isOAuthToken,
					model.compat.escapeBuiltinToolNames,
					useUmansGatewayWebSearch,
				),
			};
		}

		const choiceType = params.tool_choice?.type;
		if ((choiceType === "any" || choiceType === "tool") && !model.compat.supportsForcedToolChoice) {
			params.tool_choice = { type: "auto" };
		}
	}

	disableThinkingIfToolChoiceForced(params, model);
	ensureMaxTokensForThinking(params, maxOutputTokens);
	applyPromptCaching(params, cacheControl);

	return params;
}

const EMPTY_ERROR_TOOL_RESULT_TEXT = "Tool failed with no output.";

function isEmptyToolResultWireContent(content: AnthropicToolResultContent): boolean {
	if (typeof content === "string") {
		return content.trim().length === 0;
	}
	return content.length === 0;
}

function ensureErrorToolResultWireContent(
	content: AnthropicToolResultContent,
	isError: boolean | undefined,
): AnthropicToolResultContent {
	if (!isError || !isEmptyToolResultWireContent(content)) {
		return content;
	}
	return typeof content === "string"
		? EMPTY_ERROR_TOOL_RESULT_TEXT
		: [{ type: "text", text: EMPTY_ERROR_TOOL_RESULT_TEXT }];
}

function buildToolResultBlock(
	model: Model<"anthropic-messages">,
	msg: ToolResultMessage,
	hoistedImages: ContentBlockParam[],
): ContentBlockParam {
	let content = convertContentBlocks(msg.content, model.input.includes("image"));

	if (msg.isError && typeof content !== "string" && content.some(block => block.type === "image")) {
		for (const block of content) {
			if (block.type === "image") hoistedImages.push(block);
		}
		content = content.filter(block => block.type === "text");
	}

	if (Array.isArray(content) && content.length === 0) {
		content = "";
	}
	content = ensureErrorToolResultWireContent(content, msg.isError);
	const block: ContentBlockParam = {
		type: "tool_result",
		tool_use_id: msg.toolCallId,
		content,
		is_error: msg.isError,
	};
	if (model.compat.requiresToolResultId) {
		(block as unknown as Record<string, unknown>).id = msg.toolCallId;
	}
	return block;
}

export type AnthropicMessageParam = MessageParam;

function toWellFormedDeep(value: unknown): unknown {
	if (typeof value === "string") {
		const wellFormed = value.toWellFormed();
		return wellFormed === value ? value : wellFormed;
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map(entry => {
			const sanitized = toWellFormedDeep(entry);
			if (sanitized !== entry) changed = true;
			return sanitized;
		});
		return changed ? next : value;
	}
	if (isRecord(value)) {
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			const sanitized = toWellFormedDeep(entry);
			if (sanitized !== entry) changed = true;
			next[key] = sanitized;
		}
		return changed ? next : value;
	}
	return value;
}

export function convertAnthropicMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	isOAuthToken: boolean,
	opts?: {
		serverSideFallbackEnabled?: boolean;
		replayCompaction?: boolean;
		dropAllThinking?: boolean;
		droppedThinkingBlocks?: ReadonlySet<string>;
	},
): AnthropicMessageParam[] {
	const developerParams: Array<{ index: number; payload?: AnthropicMessagePayload }> = [];
	const params: AnthropicMessageParam[] = [];
	const pendingCompactionFiles: string[] = [];
	const flushCompactionFiles = (): void => {
		while (pendingCompactionFiles.length > 0) {
			const filesText = pendingCompactionFiles.shift();
			if (filesText === undefined || filesText.trim().length === 0) continue;
			params.push({ role: "user", content: redactSensitiveCredentials(filesText) });
		}
	};

	const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (
			opts?.replayCompaction &&
			(msg.role === "user" || msg.role === "developer") &&
			isReplayableAnthropicCompaction(msg.providerPayload, model)
		) {
			const compactionParam: AnthropicMessageParam = {
				role: "assistant",
				content: [compactionBlockParam(msg.providerPayload)],
			};
			copyPerCallContextMessage(compactionParam, msg);
			params.push(compactionParam);
			if (msg.providerPayload.filesText !== undefined) {
				pendingCompactionFiles.push(msg.providerPayload.filesText);
			}
			continue;
		}
		if (msg.role === "user" || msg.role === "developer") {
			flushCompactionFiles();
			const payload =
				msg.role === "developer" && msg.providerPayload?.type === "anthropicMessage"
					? msg.providerPayload
					: undefined;
			const hasProviderControls =
				payload?.clearAt !== undefined ||
				payload?.effort !== undefined ||
				(payload?.toolChanges !== undefined && payload.toolChanges.length > 0);

			let content: string | ContentBlockParam[];
			if (typeof msg.content === "string") {
				if (msg.content.trim().length === 0) {
					if (!hasProviderControls) continue;
					content = [];
				} else {
					content = msg.content.toWellFormed();
				}
			} else {
				const contentBlocks = convertContentBlocks(msg.content, model.input.includes("image"));
				if (typeof contentBlocks === "string") {
					if (contentBlocks.trim().length === 0) {
						if (!hasProviderControls) continue;
						content = [];
					} else {
						content = contentBlocks;
					}
				} else {
					if (contentBlocks.length === 0 && !hasProviderControls) continue;
					content = contentBlocks;
				}
			}
			if (payload?.toolChanges && model.compat.supportsMidConversationToolChanges) {
				const blocks: ContentBlockParam[] =
					typeof content === "string" ? [{ type: "text", text: content }] : content;
				for (const change of payload.toolChanges) {
					blocks.push({
						type: change.type,
						tool: {
							type: "tool_reference",
							name: encodeAnthropicToolName(change.name, isOAuthToken, model.compat.escapeBuiltinToolNames),
						},
					});
				}
				content = blocks;
			}
			if (msg.role === "developer") developerParams.push({ index: params.length, payload });
			const param: AnthropicMessageParam & ConversationalUserCarrier = { role: "user", content };
			if (msg.role === "user" && msg.synthetic !== true && msg.attribution !== "agent" && !isSyntheticUser(msg)) {
				param[kConversationalUser] = true;
			}
			copyPerCallContextMessage(param, msg);
			params.push(param);
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];
			const hasSignedThinking = msg.content.some(
				block =>
					block.type === "thinking" && !!block.thinkingSignature && block.thinkingSignature.trim().length > 0,
			);

			if (opts?.replayCompaction && isReplayableAnthropicCompaction(msg.providerPayload, model)) {
				blocks.push(compactionBlockParam(msg.providerPayload));
			}

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: block.text.toWellFormed(),
					});
				} else if (block.type === "thinking") {
					if (
						opts?.dropAllThinking ||
						(block.thinkingSignature && opts?.droppedThinkingBlocks?.has(`thinking:${block.thinkingSignature}`))
					) {
						continue;
					}
					if (hasSignedThinking) {
						if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
							if (block.thinking.trim().length === 0) continue;
							blocks.push({
								type: "text",
								text: renderDemotedThinking(model.id, block.thinking),
							});
							continue;
						}
						blocks.push({
							type: "thinking",
							thinking: block.thinking,
							signature: block.thinkingSignature,
						});
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
						if (model.compat.replayUnsignedThinking) {
							blocks.push({
								type: "thinking",
								thinking: block.thinking.toWellFormed(),
								signature: "",
							});
						} else {
							blocks.push({
								type: "text",
								text: renderDemotedThinking(model.id, block.thinking),
							});
						}
					} else {
						blocks.push({
							type: "thinking",
							thinking: block.thinking.toWellFormed(),
							signature: block.thinkingSignature,
						});
					}
				} else if (block.type === "redactedThinking") {
					if (opts?.dropAllThinking || opts?.droppedThinkingBlocks?.has(`redacted:${block.data}`)) continue;
					if (block.data.trim().length === 0) continue;
					blocks.push({
						type: "redacted_thinking",
						data: block.data,
					});
				} else if (block.type === "anthropicServerTool") {
					blocks.push(block.block);
				} else if (block.type === "fallback") {
					if (!opts?.serverSideFallbackEnabled || !model.compat.officialEndpoint) continue;
					blocks.push({
						type: "fallback",
						from: block.from,
						to: block.to,
					});
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: encodeAnthropicToolName(block.name, isOAuthToken, model.compat.escapeBuiltinToolNames),

						input: toWellFormedDeep(block.arguments ?? {}),
					});
				}
			}

			let sawToolUse = false;
			let needsPartition = false;
			for (const block of blocks) {
				if (block.type === "tool_use") {
					sawToolUse = true;
				} else if (sawToolUse && block.type !== "thinking" && block.type !== "redacted_thinking") {
					needsPartition = true;
					break;
				}
			}
			if (needsPartition) {
				const nonToolUse: ContentBlockParam[] = [];
				const toolUse: ContentBlockParam[] = [];
				for (const block of blocks) {
					if (block.type === "tool_use") toolUse.push(block);
					else nonToolUse.push(block);
				}
				blocks.length = 0;
				blocks.push(...nonToolUse, ...toolUse);
			}
			if (blocks.length === 0) continue;
			const assistantParam: AnthropicMessageParam = {
				role: "assistant",
				content: blocks,
			};
			copyPerCallContextMessage(assistantParam, msg);
			params.push(assistantParam);
			if (!blocks.some(block => block.type === "tool_use")) {
				flushCompactionFiles();
			}
		} else if (msg.role === "toolResult") {
			const toolResults: ContentBlockParam[] = [];

			const hoistedImages: ContentBlockParam[] = [];
			const toolResultParam: AnthropicMessageParam = {
				role: "user",
				content: toolResults,
			};

			toolResults.push(buildToolResultBlock(model, msg, hoistedImages));
			copyPerCallContextMessage(toolResultParam, msg);

			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage;
				toolResults.push(buildToolResultBlock(model, nextMsg, hoistedImages));
				copyPerCallContextMessage(toolResultParam, nextMsg);
				j++;
			}

			i = j - 1;

			if (hoistedImages.length > 0) {
				toolResults.push(
					{ type: "text", text: "Attached image(s) from the tool result(s) above:" },
					...hoistedImages,
				);
			}

			params.push(toolResultParam);
			flushCompactionFiles();
		}
	}

	if (developerParams.length > 0 && model.compat.supportsMidConversationSystem) {
		for (const developer of developerParams.toReversed()) {
			const idx = developer.index;
			const followsUser = idx > 0 && params[idx - 1]?.role === "user";
			const next = params[idx + 1];
			const lastOrBeforeAssistant = idx === params.length - 1 || next?.role === "assistant";

			const content = params[idx].content;
			const systemCompatible =
				typeof content === "string" ||
				content.every(
					block => block.type === "text" || block.type === "tool_addition" || block.type === "tool_removal",
				);
			const effortOnly = developer.payload?.effort !== undefined && Array.isArray(content) && content.length === 0;
			if (!((followsUser && lastOrBeforeAssistant && systemCompatible) || effortOnly)) continue;

			const turnScoped = developer.payload?.clearAt === "next_user_message" && model.compat.supportsTurnScopedSystem;
			const hasEffort = developer.payload?.effort !== undefined && model.compat.supportsPerMessageEffort;
			const hasToolChanges = (developer.payload?.toolChanges?.length ?? 0) > 0;
			if (turnScoped && (hasEffort || hasToolChanges) && Array.isArray(content)) {
				const scopedContent = content.filter(block => block.type === "text");
				const controlContent = content.filter(block => block.type !== "text");
				if (scopedContent.length > 0) {
					params[idx] = {
						...params[idx],
						role: "system",
						content: scopedContent,
						clear_at: "next_user_message",
					};
					const controlParam: AnthropicMessageParam = {
						role: "system",
						content: controlContent,
						...(hasEffort ? { output_config: { effort: developer.payload?.effort } } : {}),
					};
					copyPerCallContextMessage(controlParam, params[idx]);
					params.splice(idx + 1, 0, controlParam);
					continue;
				}
			}

			params[idx] = {
				...params[idx],
				role: "system",
				content,
				...(turnScoped && !hasEffort && !hasToolChanges ? { clear_at: "next_user_message" } : {}),
				...(hasEffort ? { output_config: { effort: developer.payload?.effort } } : {}),
			};
		}
	}
	for (let i = params.length - 2; i >= 0; i--) {
		const current = params[i];
		const next = params[i + 1];
		if (
			current.role !== "assistant" ||
			next?.role !== "assistant" ||
			typeof current.content === "string" ||
			current.content.length !== 1 ||
			current.content[0]?.type !== "compaction" ||
			typeof next.content === "string"
		) {
			continue;
		}
		params.splice(i, 2, { ...next, content: [current.content[0], ...next.content] });
	}
	for (let i = params.length - 1; i > 0; i--) {
		if (params[i].role === "assistant" && params[i - 1]?.role === "assistant") {
			params.splice(i, 0, { role: "user", content: "Continue." });
		}
	}
	flushCompactionFiles();
	if (params.length > 0 && params[params.length - 1]?.role === "assistant") {
		params.push({ role: "user", content: "Continue." });
	}

	return params;
}

const ANTHROPIC_TOOL_SCHEMA_UNIVERSAL_KEEP = new Set([
	"$ref",
	"$defs",
	"$schema",
	"definitions",
	"type",
	"anyOf",
	"allOf",
	"enum",
	"const",
	"description",
	"title",
	"default",
	"nullable",
]);

const ANTHROPIC_TOOL_SCHEMA_OBJECT_KEEP = new Set(["properties", "required", "additionalProperties"]);

const ANTHROPIC_TOOL_SCHEMA_ARRAY_KEEP = new Set(["items", "prefixItems", "minItems"]);

const ANTHROPIC_TOOL_SCHEMA_STRING_KEEP = new Set(["format"]);

const ANTHROPIC_TOOL_SCHEMA_STRING_FORMATS = new Set([
	"date-time",
	"time",
	"date",
	"duration",
	"email",
	"hostname",
	"uri",
	"ipv4",
	"ipv6",
	"uuid",
]);
const ANTHROPIC_STRICT_TOOL_ALLOWLIST = new Set(["bash", "python", "edit", "find"]);
const MAX_ANTHROPIC_STRICT_TOOLS = 20;
const MAX_ANTHROPIC_STRICT_OPTIONAL_PARAMETERS = 24;
const MAX_ANTHROPIC_STRICT_UNION_PARAMETERS = 16;

function isJsonSchemaArrayNode(schema: Record<string, unknown>): boolean {
	const t = schema.type;
	if (t === "array") return true;
	if (Array.isArray(t) && t.includes("array") && !t.includes("object")) return true;
	if (schema.items !== undefined || Array.isArray(schema.prefixItems)) return true;
	return false;
}

function isJsonSchemaObjectNode(schema: Record<string, unknown>): boolean {
	if (isJsonSchemaArrayNode(schema)) return false;
	if (schema.type === "object") return true;
	if (Array.isArray(schema.type) && schema.type.includes("object")) return true;
	if (isRecord(schema.properties)) return true;
	return false;
}

function pickAnthropicScalarType(type: unknown): string | undefined {
	if (typeof type === "string") return type;
	if (Array.isArray(type)) {
		for (const entry of type) {
			if (typeof entry === "string" && entry !== "null") return entry;
		}
	}
	return undefined;
}
function pickAnthropicEffectiveScalarType(schema: Record<string, unknown>): string | undefined {
	const explicit = pickAnthropicScalarType(schema.type);
	if (explicit) return explicit;
	if (isRecord(schema.properties)) return "object";
	if (schema.items !== undefined || Array.isArray(schema.prefixItems)) return "array";
	return undefined;
}

function anthropicPerTypeKeep(scalarType: string | undefined): Set<string> | undefined {
	switch (scalarType) {
		case "object":
			return ANTHROPIC_TOOL_SCHEMA_OBJECT_KEEP;
		case "array":
			return ANTHROPIC_TOOL_SCHEMA_ARRAY_KEEP;
		case "string":
			return ANTHROPIC_TOOL_SCHEMA_STRING_KEEP;
		default:
			return undefined;
	}
}

function normalizeAnthropicToolSchemaNode(
	schema: unknown,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>>,
	isRoot = false,
): unknown {
	if (Array.isArray(schema)) return schema.map(entry => normalizeAnthropicToolSchemaNode(entry, cache));
	if (!isRecord(schema)) return schema;

	const existing = cache.get(schema);
	if (existing !== undefined) return existing;

	const result: Record<string, unknown> = {};
	cache.set(schema, result);

	const scalarType = pickAnthropicEffectiveScalarType(schema);
	const perTypeKeep = anthropicPerTypeKeep(scalarType);
	const spill: Array<[string, unknown]> = [];

	for (const key in schema) {
		if (!Object.hasOwn(schema, key)) continue;
		const value = schema[key];
		const isRootCombinator = isRoot && COMBINATOR_KEYS.includes(key as (typeof COMBINATOR_KEYS)[number]);
		if (!isRootCombinator && (ANTHROPIC_TOOL_SCHEMA_UNIVERSAL_KEEP.has(key) || perTypeKeep?.has(key))) {
			result[key] = value;
		} else {
			spill.push([key, value]);
		}
	}

	if (scalarType === "string") {
		const format = result.format;
		if (typeof format === "string" && !ANTHROPIC_TOOL_SCHEMA_STRING_FORMATS.has(format)) {
			spill.push(["format", format]);
			delete result.format;
		}
	}
	if (scalarType === "array" && result.minItems !== undefined) {
		const minItems = result.minItems;
		if (!(typeof minItems === "number" && (minItems === 0 || minItems === 1))) {
			spill.push(["minItems", minItems]);
			delete result.minItems;
		}
	}
	if (scalarType === "object" && result.additionalProperties === undefined) {
		result.additionalProperties = false;
	}

	if (isRecord(result.properties)) {
		const normalizedProperties: Record<string, unknown> = {};
		const sourceProperties = result.properties as Record<string, unknown>;
		for (const propName in sourceProperties) {
			if (!Object.hasOwn(sourceProperties, propName)) continue;
			normalizedProperties[propName] = normalizeAnthropicToolSchemaNode(sourceProperties[propName], cache);
		}
		result.properties = normalizedProperties;
	}
	if (isRecord(result.additionalProperties)) {
		const normalized = normalizeAnthropicToolSchemaNode(result.additionalProperties, cache);
		if (isRecord(normalized) && Object.keys(normalized).length === 0) {
			result.additionalProperties = true;
		} else {
			result.additionalProperties = normalized;
		}
	}
	if (Array.isArray(result.items)) {
		result.items = result.items.map(item => normalizeAnthropicToolSchemaNode(item, cache));
	} else if (isRecord(result.items)) {
		result.items = normalizeAnthropicToolSchemaNode(result.items, cache);
	}
	if (Array.isArray(result.prefixItems)) {
		result.prefixItems = result.prefixItems.map(item => normalizeAnthropicToolSchemaNode(item, cache));
	}
	for (const key of COMBINATOR_KEYS) {
		const variants = result[key];
		if (Array.isArray(variants)) {
			result[key] = variants.map(variant => normalizeAnthropicToolSchemaNode(variant, cache));
		}
	}
	for (const defsKey of ["$defs", "definitions"] as const) {
		const definitions = result[defsKey];
		if (!isRecord(definitions)) continue;
		const normalizedDefs: Record<string, unknown> = {};
		const sourceDefs = definitions as Record<string, unknown>;
		for (const name in sourceDefs) {
			if (!Object.hasOwn(sourceDefs, name)) continue;
			normalizedDefs[name] = normalizeAnthropicToolSchemaNode(sourceDefs[name], cache);
		}
		result[defsKey] = normalizedDefs;
	}

	spillToDescription(result, spill);
	return result;
}

export function normalizeAnthropicToolSchema(schema: unknown): unknown {
	return normalizeAnthropicToolSchemaNode(schema, new WeakMap(), true);
}

type AnthropicToolSchemaPlan = {
	inputSchema: AnthropicToolInputSchema;
	strict: boolean;
};

type AnthropicStrictBudget = {
	optionalRemaining: number;
	unionRemaining: number;
	optionalCount: number;
	unionCount: number;
};

function hasAnthropicUnionType(schema: Record<string, unknown>): boolean {
	return Array.isArray(schema.type) || Array.isArray(schema.anyOf);
}

function hasNullVariant(schema: Record<string, unknown>): boolean {
	if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
	return Array.isArray(schema.anyOf) && schema.anyOf.some(variant => isRecord(variant) && variant.type === "null");
}
function hasAnthropicSchemaDefiningKeyword(schema: Record<string, unknown>): boolean {
	if (
		schema.type !== undefined ||
		schema.properties !== undefined ||
		schema.additionalProperties !== undefined ||
		schema.items !== undefined ||
		schema.prefixItems !== undefined ||
		schema.enum !== undefined ||
		schema.const !== undefined ||
		schema.$ref !== undefined
	) {
		return true;
	}
	for (const key of COMBINATOR_KEYS) {
		if (schema[key] !== undefined) return true;
	}
	return schema.$defs !== undefined || schema.definitions !== undefined;
}

function makeAnthropicNullableSchema(schema: unknown, budget: AnthropicStrictBudget): unknown | undefined {
	if (isRecord(schema)) {
		if (hasNullVariant(schema)) return schema;
		if (Array.isArray(schema.anyOf)) {
			return { ...schema, anyOf: [...schema.anyOf, { type: "null" }] };
		}
		if (Array.isArray(schema.type)) {
			return { ...schema, type: [...schema.type, "null"] };
		}
	}

	if (budget.unionRemaining <= 0) return undefined;
	budget.unionRemaining--;
	budget.unionCount++;
	return { anyOf: [schema, { type: "null" }] };
}

function normalizeAnthropicStrictSchemaNode(
	schema: unknown,
	budget: AnthropicStrictBudget,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>>,
): unknown | undefined {
	if (Array.isArray(schema)) {
		const result: unknown[] = [];
		for (const entry of schema) {
			const normalized = normalizeAnthropicStrictSchemaNode(entry, budget, cache);
			if (normalized === undefined) return undefined;
			result.push(normalized);
		}
		return result;
	}

	if (!isRecord(schema)) return schema;

	const cached = cache.get(schema);
	if (cached) return cached;

	if (!hasAnthropicSchemaDefiningKeyword(schema)) return undefined;

	if (isJsonSchemaObjectNode(schema) && schema.additionalProperties !== false) {
		return undefined;
	}

	const result: Record<string, unknown> = { ...schema };
	cache.set(schema, result);

	if (hasAnthropicUnionType(result)) {
		if (budget.unionRemaining <= 0) return undefined;
		budget.unionRemaining--;
		budget.unionCount++;
	}

	if (isRecord(result.properties)) {
		const originalRequired = new Set(
			Array.isArray(result.required)
				? result.required.filter((entry): entry is string => typeof entry === "string")
				: [],
		);
		const properties: Record<string, unknown> = {};
		const required: string[] = [];

		for (const [propertyName, propertySchema] of Object.entries(result.properties)) {
			const normalizedProperty = normalizeAnthropicStrictSchemaNode(propertySchema, budget, cache);
			if (normalizedProperty === undefined) return undefined;

			if (originalRequired.has(propertyName)) {
				properties[propertyName] = normalizedProperty;
				required.push(propertyName);
				continue;
			}

			if (budget.optionalRemaining > 0) {
				budget.optionalRemaining--;
				budget.optionalCount++;
				properties[propertyName] = normalizedProperty;
				continue;
			}

			const nullableProperty = makeAnthropicNullableSchema(normalizedProperty, budget);
			if (nullableProperty === undefined) return undefined;
			properties[propertyName] = nullableProperty;
			required.push(propertyName);
		}

		result.properties = properties;
		result.required = required;
	}

	if (Array.isArray(result.items)) {
		const items = normalizeAnthropicStrictSchemaNode(result.items, budget, cache);
		if (items === undefined) return undefined;
		result.items = items;
	} else if (isRecord(result.items)) {
		const items = normalizeAnthropicStrictSchemaNode(result.items, budget, cache);
		if (items === undefined) return undefined;
		result.items = items;
	}
	if (Array.isArray(result.prefixItems)) {
		const prefixItems = normalizeAnthropicStrictSchemaNode(result.prefixItems, budget, cache);
		if (prefixItems === undefined) return undefined;
		result.prefixItems = prefixItems;
	}

	for (const key of COMBINATOR_KEYS) {
		const variants = result[key];
		if (!Array.isArray(variants)) continue;
		const normalizedVariants = normalizeAnthropicStrictSchemaNode(variants, budget, cache);
		if (normalizedVariants === undefined) return undefined;
		result[key] = normalizedVariants;
	}

	for (const defsKey of ["$defs", "definitions"] as const) {
		const definitions = result[defsKey];
		if (!isRecord(definitions)) continue;
		const normalizedDefinitions: Record<string, unknown> = {};
		for (const [definitionName, definitionSchema] of Object.entries(definitions)) {
			const normalizedDefinition = normalizeAnthropicStrictSchemaNode(definitionSchema, budget, cache);
			if (normalizedDefinition === undefined) return undefined;
			normalizedDefinitions[definitionName] = normalizedDefinition;
		}
		result[defsKey] = normalizedDefinitions;
	}

	return result;
}

const ANTHROPIC_STRICT_INCOMPATIBLE_KEYWORDS = [
	"oneOf",
	"allOf",
	"$ref",
	"patternProperties",
	"propertyNames",
] as const;

function hasAnthropicStrictIncompatibleKeyword(schema: unknown, seen = new Set<object>()): boolean {
	if (Array.isArray(schema)) {
		if (seen.has(schema)) return false;
		seen.add(schema);
		return schema.some(entry => hasAnthropicStrictIncompatibleKeyword(entry, seen));
	}
	if (!isRecord(schema)) return false;
	if (seen.has(schema)) return false;
	seen.add(schema);
	for (const keyword of ANTHROPIC_STRICT_INCOMPATIBLE_KEYWORDS) {
		if (schema[keyword] !== undefined) return true;
	}
	return Object.values(schema).some(value => hasAnthropicStrictIncompatibleKeyword(value, seen));
}

function normalizeAnthropicStrictSchema(
	schema: Record<string, unknown>,
	optionalRemaining: number,
	unionRemaining: number,
): { schema: Record<string, unknown>; optionalCount: number; unionCount: number } | undefined {
	const budget: AnthropicStrictBudget = {
		optionalRemaining,
		unionRemaining,
		optionalCount: 0,
		unionCount: 0,
	};
	const normalized = normalizeAnthropicStrictSchemaNode(schema, budget, new WeakMap());
	if (!isRecord(normalized)) return undefined;
	return { schema: normalized, optionalCount: budget.optionalCount, unionCount: budget.unionCount };
}

function buildAnthropicBaseToolInputSchema(tool: Tool): Record<string, unknown> {
	const jsonSchema = toolWireSchema(tool);
	return normalizeAnthropicToolSchema({
		...jsonSchema,
		type: "object",
		properties: isRecord(jsonSchema.properties) ? jsonSchema.properties : {},
		required: Array.isArray(jsonSchema.required)
			? jsonSchema.required.filter((entry): entry is string => typeof entry === "string")
			: [],
	}) as Record<string, unknown>;
}

function buildAnthropicToolSchemaPlans(tools: Tool[], disableStrictTools = false): AnthropicToolSchemaPlan[] {
	const plans = tools.map(
		(tool): AnthropicToolSchemaPlan => ({
			inputSchema: buildAnthropicBaseToolInputSchema(tool) as AnthropicToolInputSchema,
			strict: false,
		}),
	);
	if (NO_STRICT || disableStrictTools) return plans;

	const candidateIndexes = tools.flatMap((tool, index) => {
		if (!ANTHROPIC_STRICT_TOOL_ALLOWLIST.has(tool.name)) return [];
		if (tool.strict === false) return [];
		if (hasAnthropicStrictIncompatibleKeyword(toolWireSchema(tool))) return [];
		return [index];
	});

	let strictToolCount = 0;
	let strictOptionalParameterCount = 0;
	let strictUnionParameterCount = 0;
	for (const index of candidateIndexes) {
		if (strictToolCount >= MAX_ANTHROPIC_STRICT_TOOLS) break;

		const strictResult = normalizeAnthropicStrictSchema(
			plans[index].inputSchema as Record<string, unknown>,
			MAX_ANTHROPIC_STRICT_OPTIONAL_PARAMETERS - strictOptionalParameterCount,
			MAX_ANTHROPIC_STRICT_UNION_PARAMETERS - strictUnionParameterCount,
		);
		if (!strictResult) continue;

		plans[index] = {
			inputSchema: strictResult.schema as AnthropicToolInputSchema,
			strict: true,
		};
		strictToolCount++;
		strictOptionalParameterCount += strictResult.optionalCount;
		strictUnionParameterCount += strictResult.unionCount;
	}

	return plans;
}

function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	disableStrictTools = false,
	supportsEagerToolInputStreaming = true,
	escapeBuiltinToolNames = false,
	useUmansGatewayWebSearch = false,
): AnthropicWireTool[] {
	if (!tools) return [];
	const schemaPlans = buildAnthropicToolSchemaPlans(tools, disableStrictTools);

	return tools.map((tool, index) => {
		const plan = schemaPlans[index];
		const baseTool = {
			name: encodeAnthropicToolName(tool.name, isOAuthToken, escapeBuiltinToolNames, useUmansGatewayWebSearch),
			description: tool.description || "",
			input_schema: plan.inputSchema,
		};
		return {
			...baseTool,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			...(plan.strict ? { strict: true } : {}),
			...(tool.deferLoading ? { defer_loading: true } : {}),
		};
	});
}

function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";

		case "model_context_window_exceeded":
			return "length";
		case "tool_use":
			return "toolUse";
		case "refusal":
			return "error";
		case "pause_turn":
			return "stop";
		case "compaction":
			return "stop";
		case "stop_sequence":
			return "stop";
		case "sensitive":
			return "error";
		default:
			reportAnthropicEnvelopeAnomaly(`unhandled stop reason: ${reason}`);
			return "stop";
	}
}
