import { hostMatchesUrl, modelMatchesHost } from "../hosts";
import {
	hasOpus47ApiRestrictions,
	isAnthropicFableOrMythosModel,
	isKimiK3ModelId,
	supportsMidConversationSystemMessages,
} from "../identity/family";
import type { ModelSpec, ResolvedAnthropicCompat } from "../types";
import { applyCompatOverrides } from "./apply";

const OFFICIAL_ANTHROPIC_URL = "https://api.anthropic.com";

export function isOfficialAnthropicApiUrl(baseUrl?: string): boolean {
	if (!baseUrl) return true;
	const lower = baseUrl.toLowerCase();
	return lower === OFFICIAL_ANTHROPIC_URL || lower.startsWith(`${OFFICIAL_ANTHROPIC_URL}/`);
}

const KIMI_K27_CODE_MODEL_PATTERN = /(?:^|\/)kimi[-._]?k2(?:[._-]?|p)7[-._]?code(?:[-._]?highspeed)?$/i;

function matchesKimiMandatoryThinkingModel(spec: ModelSpec<"anthropic-messages">): boolean {
	if (KIMI_K27_CODE_MODEL_PATTERN.test(spec.id)) return true;
	if (spec.id === "kimi-for-coding" || spec.id === "kimi-for-coding-highspeed") return true;
	return isKimiK3ModelId(spec.id) || spec.id === "k3";
}

const CLOUDFLARE_ANTHROPIC_GATEWAY_URL_MARKER = /gateway\.ai\.cloudflare\.com\/.+\/anthropic(?:\/|$)/i;
const VERTEX_ANTHROPIC_URL_MARKER = /aiplatform\.googleapis\.com\/.+\/publishers\/anthropic\//i;
const BEDROCK_ANTHROPIC_URL_MARKER = /(?:^|\/\/|\.)bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com/i;
const AZURE_ANTHROPIC_URL_MARKER = /(?:^|\/\/|\.)[a-z0-9-]+\.(?:inference|services)\.ai\.azure\.com/i;

function isCloudflareAnthropicGateway(baseUrl?: string): boolean {
	return baseUrl !== undefined && CLOUDFLARE_ANTHROPIC_GATEWAY_URL_MARKER.test(baseUrl);
}

function isVertexAnthropicRoute(baseUrl?: string): boolean {
	return baseUrl !== undefined && VERTEX_ANTHROPIC_URL_MARKER.test(baseUrl);
}

function isBedrockAnthropicRoute(baseUrl?: string): boolean {
	return baseUrl !== undefined && BEDROCK_ANTHROPIC_URL_MARKER.test(baseUrl);
}

function isAzureAnthropicRoute(baseUrl?: string): boolean {
	return baseUrl !== undefined && AZURE_ANTHROPIC_URL_MARKER.test(baseUrl);
}

export function isAnthropicSigningProxyUrl(baseUrl?: string): boolean {
	return (
		hostMatchesUrl(baseUrl, "githubCopilot") ||
		hostMatchesUrl(baseUrl, "zenmux") ||
		isCloudflareAnthropicGateway(baseUrl) ||
		isVertexAnthropicRoute(baseUrl) ||
		isBedrockAnthropicRoute(baseUrl) ||
		isAzureAnthropicRoute(baseUrl)
	);
}

export function buildAnthropicCompat(spec: ModelSpec<"anthropic-messages">): ResolvedAnthropicCompat {
	const baseUrl = spec.baseUrl;
	const official = isOfficialAnthropicApiUrl(baseUrl);

	const isZai = modelMatchesHost(spec, "zai");

	const isCopilot = modelMatchesHost(spec, "githubCopilot");

	const isZenmux = modelMatchesHost(spec, "zenmux");
	const requiresThinkingEnabled = modelMatchesHost(spec, "moonshotNative") && matchesKimiMandatoryThinkingModel(spec);
	const isAzure = isAzureAnthropicRoute(baseUrl);
	const signingEndpoint = official || isCopilot || isZenmux || isAnthropicSigningProxyUrl(baseUrl);
	const compat: ResolvedAnthropicCompat = {
		officialEndpoint: official,
		signingEndpoint,
		disableStrictTools: isAzure,
		disableAdaptiveThinking: false,
		allowAnthropicHeaderOverrides: false,
		supportsEagerToolInputStreaming: official,

		supportsLongCacheRetention: official,

		supportsMidConversationSystem: official && supportsMidConversationSystemMessages(spec.id),
		supportsForcedToolChoice: !requiresThinkingEnabled && !isAnthropicFableOrMythosModel(spec.id),

		supportsSamplingParams: !hasOpus47ApiRestrictions(spec.id),

		requiresToolResultId: isZai,
		requiresThinkingEnabled,

		replayUnsignedThinking: !signingEndpoint && (Boolean(spec.reasoning) || modelMatchesHost(spec, "deepseekFamily")),
		escapeBuiltinToolNames: modelMatchesHost(spec, "umans"),
		streamIdleTimeoutMs: spec.compat?.streamIdleTimeoutMs,
	};
	applyCompatOverrides(compat, spec.compat);
	return compat;
}
