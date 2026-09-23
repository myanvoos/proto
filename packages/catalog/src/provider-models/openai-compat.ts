import { getInstallId, USER_AGENT } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { buildCompat } from "../build";
import { toClinePassPublicModelId } from "../cline-pass-model-id";
import { xaiResponsesReasoningEffortMap } from "../compat/openai";
import {
	DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS,
	fetchOpenAICompatibleModels,
	type OpenAICompatibleModelMapperContext,
	type OpenAICompatibleModelRecord,
} from "../discovery/openai-compatible";
import { Effort, THINKING_EFFORTS } from "../effort";
import { FIREWORKS_FAST_SUFFIX, toFireworksPublicModelId } from "../fireworks-model-id";
import { getBundledModelReferenceIndex } from "../identity/bundled";
import {
	anthropicModelSupportsThinking,
	isGlm52ReasoningEffortModelId,
	isGlm53ReasoningEffortModelId,
	isGlmVisionModelId,
	isGrokReasoningEffortCapable,
	isKimiK3ModelId,
	isKimiModelId,
	isMuseSparkModelId,
	isReasoningGlmModelId,
} from "../identity/family";
import { resolveModelReference } from "../identity/reference";
import type { ModelManagerOptions, ModelsDevFallback } from "../model-manager";
import { hasModelScopedEffortLadder } from "../model-thinking";
import { type GeneratedProvider, getBundledModels } from "../models";
import { OPENAI_GPT_56_CYBER_STANDARD_COST, OPENAI_GPT_56_SOL_STANDARD_COST } from "../openai-pricing";
import type {
	Api,
	CompatOf,
	FetchImpl,
	LongContextTokenCost,
	Model,
	ModelCost,
	ModelSpec,
	OpenAICompat,
	Provider,
	ThinkingConfig,
} from "../types";
import { discoveryFetch, isAnthropicOAuthToken, isRecord, toBoolean, toNumber, toPositiveNumber } from "../utils";
import { ALIBABA_TOKEN_PLAN_BASE_URL, parseAlibabaTokenPlanCredential } from "../wire/alibaba-token-plan";
import { normalizeCharmHyperBaseUrl } from "../wire/charm-hyper";
import { CLINEPASS_API_BASE_URL, clinePassClientHeaders } from "../wire/cline-pass";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
} from "../wire/cloudflare-ai-gateway";
import { coreWeaveProjectHeaders } from "../wire/coreweave";
import {
	COPILOT_API_HEADERS,
	COPILOT_DISCOVERY_HEADERS,
	discoverGitHubCopilotApiEndpoint,
	getGitHubCopilotBaseUrl,
	isPersonalGitHubCopilotBaseUrl,
	mergeCopilotApiHeaders,
	parseGitHubCopilotApiKey,
} from "../wire/github-copilot";
import {
	normalizeSingularityApiBaseUrl,
	SINGULARITYAPI_DEV_API_BASE_URL,
	SINGULARITYAPI_TECH_API_BASE_URL,
} from "../wire/singularityapi";
import {
	createBundledReferenceMap,
	createReferenceResolver,
	isBareIdReferenceProvider,
	toModelSpec,
} from "./bundled-references";
import { getDefaultModelDiscoveryBaseUrl, resolveModelCacheProviderId } from "./cache-provider-id";
import { getClinePassModelMetadata } from "./cline-pass";
import type { ModelManagerConfig } from "./descriptor-types";
import { filterModelsDevCatalogRows } from "./models-dev-policies";

const MODELS_DEV_URL = "https://catalog.stencil.so/models.json.zstd";

const ZSTD_MAGIC = 0xfd2fb528;

async function withCatalogDiscoveryTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
		timeoutMs,
	);
	try {
		return await run(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_OAUTH_BETA =
	"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11";

export interface ModelsDevModel {
	id?: string;
	name?: string;
	tool_call?: boolean;
	reasoning?: boolean;
	limit?: {
		context?: number;
		output?: number;
	};
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
	modalities?: {
		input?: string[];
	};
	status?: string;
	provider?: { npm?: string };
	int?: number;
	tps?: number;
	reasoning_options?: Array<{ type?: string; values?: string[]; min?: number; max?: number }>;
}

function toModelName(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function toInputCapabilities(value: unknown): ("text" | "image")[] {
	if (!Array.isArray(value)) {
		return ["text"];
	}
	const supportsImage = value.some(item => item === "image");
	return supportsImage ? ["text", "image"] : ["text"];
}

interface CatalogSession {
	inflight: Promise<unknown> | null;
	payload: unknown;
	etag: string | null;
	hasPayload: boolean;
}

// Sessions are scoped to the fetch implementation that owns their network and auth context, so
// isolated registries never observe each other's payloads, ETags, or in-flight requests.
const defaultCatalogSession: CatalogSession = { inflight: null, payload: undefined, etag: null, hasPayload: false };
const catalogSessionsByFetch = new WeakMap<FetchImpl, CatalogSession>();

function getCatalogSession(fetchImpl: FetchImpl | undefined): CatalogSession {
	if (!fetchImpl) return defaultCatalogSession;
	const existing = catalogSessionsByFetch.get(fetchImpl);
	if (existing) return existing;
	const created: CatalogSession = { inflight: null, payload: undefined, etag: null, hasPayload: false };
	catalogSessionsByFetch.set(fetchImpl, created);
	return created;
}

function waitForCatalogRequest<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return request;
	if (signal.aborted) return Promise.reject(signal.reason);
	const aborted = Promise.withResolvers<never>();
	const rejectAborted = () => aborted.reject(signal.reason);
	signal.addEventListener("abort", rejectAborted, { once: true });
	return Promise.race([request, aborted.promise]).finally(() => {
		signal.removeEventListener("abort", rejectAborted);
	});
}

const CATALOG_USER_AGENT = USER_AGENT;

/**
 * Callers sharing a fetch implementation share one transport request (with its own hard deadline)
 * and revalidate with `If-None-Match`; each subscriber may stop waiting independently. A failed
 * refresh falls back to the last in-memory payload for best-effort metadata callers.
 */
export function fetchWellKnownModels(fetchImpl?: FetchImpl, signal?: AbortSignal): Promise<unknown> {
	const session = getCatalogSession(fetchImpl);
	return fetchRevalidatedWellKnownModels(fetchImpl, signal).catch(error => {
		if (session.hasPayload) return session.payload;
		throw error;
	});
}

function fetchRevalidatedWellKnownModels(fetchImpl?: FetchImpl, signal?: AbortSignal): Promise<unknown> {
	const session = getCatalogSession(fetchImpl);
	if (!session.inflight) {
		session.inflight = withCatalogDiscoveryTimeout(DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS, transportSignal =>
			fetchCatalogPayload(fetchImpl ?? discoveryFetch(), session, transportSignal),
		).finally(() => {
			session.inflight = null;
		});
	}
	return waitForCatalogRequest(session.inflight, signal);
}

// Model-manager fallbacks must observe a failed revalidation as a failed fetch rather than
// a silent success replaying the previous payload.
function fetchRevalidatedWellKnownModelsWithTimeout(
	fetchImpl?: FetchImpl,
	timeoutMs = DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS,
): Promise<unknown> {
	return withCatalogDiscoveryTimeout(timeoutMs, signal => fetchRevalidatedWellKnownModels(fetchImpl, signal));
}

async function fetchCatalogPayload(
	fetchImpl: FetchImpl,
	session: CatalogSession,
	signal?: AbortSignal,
): Promise<unknown> {
	const headers: Record<string, string> = {
		Accept: "application/zstd, application/json",
		"User-Agent": CATALOG_USER_AGENT,
	};
	if (session.hasPayload && session.etag) {
		headers["If-None-Match"] = session.etag;
	}
	const response = await fetchImpl(MODELS_DEV_URL, { method: "GET", headers, signal });
	if (response.status === 304 && session.hasPayload) {
		return session.payload;
	}
	if (!response.ok) {
		throw new Error(`models catalog fetch failed: ${response.status}`);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	const isZstd = bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === ZSTD_MAGIC;
	const text = new TextDecoder().decode(isZstd ? await Bun.zstdDecompress(bytes) : bytes);
	const payload: unknown = JSON.parse(text);
	session.payload = payload;
	session.etag = response.headers.get("etag");
	session.hasPayload = true;
	return payload;
}

function mapAnthropicModelsDev(payload: unknown, baseUrl: string): ModelSpec<"anthropic-messages">[] {
	if (!isRecord(payload)) {
		return [];
	}
	const anthropicPayload = payload.anthropic;
	if (!isRecord(anthropicPayload)) {
		return [];
	}
	const modelsValue = anthropicPayload.models;
	if (!isRecord(modelsValue)) {
		return [];
	}

	const models: ModelSpec<"anthropic-messages">[] = [];
	for (const [modelId, rawModel] of Object.entries(modelsValue)) {
		if (!isRecord(rawModel)) {
			continue;
		}
		const model = rawModel as ModelsDevModel;
		if (model.tool_call !== true) {
			continue;
		}
		models.push({
			id: modelId,
			name: toModelName(model.name, modelId),
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl,
			reasoning: model.reasoning === true,
			input: toInputCapabilities(model.modalities?.input),
			cost: {
				input: toNumber(model.cost?.input) ?? 0,
				output: toNumber(model.cost?.output) ?? 0,
				cacheRead: toNumber(model.cost?.cache_read) ?? 0,
				cacheWrite: toNumber(model.cost?.cache_write) ?? 0,
			},
			contextWindow: toPositiveNumber(model.limit?.context, null),
			maxTokens: toPositiveNumber(model.limit?.output, null),
		});
	}

	models.sort((left, right) => left.id.localeCompare(right.id));
	return models;
}

function buildAnthropicDiscoveryHeaders(apiKey: string): Record<string, string> {
	const oauthToken = isAnthropicOAuthToken(apiKey);
	const headers: Record<string, string> = {
		"anthropic-version": "2023-06-01",
		"anthropic-dangerous-direct-browser-access": "true",
		"anthropic-beta": ANTHROPIC_OAUTH_BETA,
	};
	if (oauthToken) {
		headers.Authorization = `Bearer ${apiKey}`;
	} else {
		headers["x-api-key"] = apiKey;
	}
	return headers;
}

function buildAnthropicReferenceMap(
	modelsDevModels: readonly ModelSpec<"anthropic-messages">[],
): Map<string, ModelSpec<"anthropic-messages">> {
	const merged = new Map<string, ModelSpec<"anthropic-messages">>();
	for (const model of modelsDevModels) {
		merged.set(model.id, model);
	}

	const bundledModels = getBundledModels("anthropic").filter(
		(model): model is Model<"anthropic-messages"> => model.api === "anthropic-messages",
	);
	for (const model of bundledModels) {
		merged.set(model.id, toModelSpec(model));
	}
	return merged;
}

export const ANTHROPIC_CURATED_FALLBACK_MODELS: readonly ModelSpec<"anthropic-messages">[] = [
	{
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		thinking: {
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			supportsDisplay: true,
		},
		tokenizer: "claude-v5",
	},
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-fable-5",
		name: "Claude Fable 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-mythos-5",
		name: "Claude Mythos 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
];

function mapWithBundledReference<TApi extends Api>(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<TApi>,
	reference: ModelSpec<TApi> | undefined,
): ModelSpec<TApi> {
	const name = toModelName(entry.name, reference?.name ?? defaults.name);
	if (!reference) {
		return {
			...defaults,
			name,
		};
	}
	return {
		...reference,
		id: defaults.id,
		name,
		api: defaults.api,
		provider: defaults.provider,
		baseUrl: defaults.baseUrl,
		contextWindow: toPositiveNumber(entry.context_length, reference.contextWindow),
		maxTokens: toPositiveNumber(entry.max_completion_tokens, reference.maxTokens),
	};
}

function normalizeAnthropicBaseUrl(baseUrl: string | undefined, fallback: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return fallback;
	}
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toAnthropicDiscoveryBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

function normalizeOllamaBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return "http://127.0.0.1:11434/v1";
	}
	const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function toOllamaNativeBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
}

async function fetchOllamaNativeModels(
	baseUrl: string,
	resolveMetadata: (modelId: string) => Promise<OllamaResolvedMetadata>,
	fetchImpl: FetchImpl = discoveryFetch(),
): Promise<ModelSpec<"openai-responses">[] | null> {
	const nativeBaseUrl = toOllamaNativeBaseUrl(baseUrl);
	let response: Response;
	try {
		response = await fetchImpl(`${nativeBaseUrl}/api/tags`, {
			method: "GET",
			headers: { Accept: "application/json" },
		});
	} catch {
		return null;
	}
	if (!response.ok) {
		return null;
	}
	const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
	const entries = payload.models ?? [];
	const resolved = await Promise.all(
		entries.map(async (entry): Promise<ModelSpec<"openai-responses"> | null> => {
			const id = entry.model ?? entry.name;
			if (!id) return null;
			const metadata = await resolveMetadata(id);
			return {
				id,
				name: entry.name ?? id,
				api: "openai-responses",
				provider: "ollama",
				baseUrl,
				reasoning: metadata.reasoning ?? true,
				thinking: metadata.thinking,
				input: metadata.input ?? ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: metadata.contextWindow,
				maxTokens: metadata.maxTokens,
			};
		}),
	);
	const models: ModelSpec<"openai-responses">[] = resolved.filter(
		(m): m is ModelSpec<"openai-responses"> => m !== null,
	);
	return models.sort((left, right) => left.id.localeCompare(right.id));
}

const OLLAMA_FALLBACK_CONTEXT_WINDOW = 128_000;

const OLLAMA_DEFAULT_MAX_TOKENS = 8192;

interface OllamaResolvedMetadata {
	contextWindow: number;
	maxTokens: number;
	capabilities?: string[];
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image")[];
}

interface OllamaShowMetadata {
	contextWindow?: number;
	maxTokens?: number;
	capabilities?: string[];
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image")[];
}

function getOllamaContextWindow(modelInfo: Record<string, unknown> | undefined): number | undefined {
	if (!modelInfo) {
		return undefined;
	}
	for (const [key, value] of Object.entries(modelInfo)) {
		if (typeof value !== "number" || value <= 0) {
			continue;
		}
		if (key.endsWith(".context_length") || key.endsWith(".num_ctx") || key.endsWith(".context_window")) {
			return value;
		}
	}
}

function getOllamaCapabilities(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.filter((item): item is string => typeof item === "string");
}

function getOllamaThinkingConfig(capabilities: string[] | undefined): ThinkingConfig | undefined {
	if (!capabilities?.includes("thinking")) {
		return undefined;
	}
	return { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] };
}

async function fetchOllamaShowMetadata(
	nativeBaseUrl: string,
	modelId: string,
	fetchImpl: FetchImpl = discoveryFetch(),
): Promise<OllamaShowMetadata | undefined> {
	try {
		const response = await fetchImpl(`${nativeBaseUrl}/api/show`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ model: modelId }),
		});
		if (!response.ok) {
			return undefined;
		}
		const payload = (await response.json()) as { capabilities?: unknown; model_info?: Record<string, unknown> };
		const capabilities = getOllamaCapabilities(payload.capabilities);
		const contextWindow = getOllamaContextWindow(payload.model_info);
		return {
			contextWindow,
			maxTokens: contextWindow ? OLLAMA_DEFAULT_MAX_TOKENS : undefined,
			capabilities,
			reasoning: capabilities ? capabilities.includes("thinking") : undefined,
			thinking: getOllamaThinkingConfig(capabilities),
			input: capabilities
				? capabilities.includes("vision")
					? (["text", "image"] as Array<"text" | "image">)
					: (["text"] as Array<"text">)
				: undefined,
		};
	} catch {}
	return undefined;
}

function createOllamaMetadataResolver(
	nativeBaseUrl: string,
	fetchImpl?: FetchImpl,
): (modelId: string) => Promise<OllamaResolvedMetadata> {
	const cache = new Map<string, Promise<OllamaResolvedMetadata>>();
	return modelId => {
		const cached = cache.get(modelId);
		if (cached) return cached;
		const pending = (async () => {
			const metadata = await fetchOllamaShowMetadata(nativeBaseUrl, modelId, fetchImpl);
			if (!metadata) {
				cache.delete(modelId);
				return { contextWindow: OLLAMA_FALLBACK_CONTEXT_WINDOW, maxTokens: OLLAMA_DEFAULT_MAX_TOKENS };
			}
			return {
				...metadata,
				contextWindow: metadata.contextWindow ?? OLLAMA_FALLBACK_CONTEXT_WINDOW,
				maxTokens: metadata.maxTokens ?? OLLAMA_DEFAULT_MAX_TOKENS,
			};
		})();
		cache.set(modelId, pending);
		void pending.catch(() => cache.delete(modelId));
		return pending;
	};
}

const OPENAI_NON_RESPONSES_PREFIXES = [
	"text-embedding",
	"whisper-",
	"tts-",
	"omni-moderation",
	"omni-transcribe",
	"omni-speech",
	"gpt-image-",
	"gpt-realtime",
] as const;

function isLikelyOpenAIResponsesModelId(
	id: string,
	references?: ReadonlyMap<string, ModelSpec<"openai-responses">>,
): boolean {
	const trimmed = id.trim();
	if (!trimmed) {
		return false;
	}
	if (references?.has(trimmed)) {
		return true;
	}
	const normalized = trimmed.toLowerCase();
	if (OPENAI_NON_RESPONSES_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
		return false;
	}
	if (normalized.includes("embedding")) {
		return false;
	}
	return (
		normalized.startsWith("gpt-") ||
		normalized.startsWith("o1") ||
		normalized.startsWith("o3") ||
		normalized.startsWith("o4") ||
		normalized.startsWith("chatgpt")
	);
}

const NANO_GPT_NON_TEXT_MODEL_TOKENS = [
	"embedding",
	"image",
	"vision",
	"audio",
	"speech",
	"transcribe",
	"moderation",
	"realtime",
	"whisper",
	"tts",
] as const;

const NANO_GPT_THINKING_SUFFIX_RE = /:thinking(:[^:]+)?$/;

function isLikelyNanoGptTextModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	if (NANO_GPT_THINKING_SUFFIX_RE.test(normalized)) {
		return false;
	}
	return !NANO_GPT_NON_TEXT_MODEL_TOKENS.some(token => normalized.includes(token));
}

type SimpleProviderDiscoveryHeaders = Record<string, string> | (() => Record<string, string> | undefined);
type SimpleProviderConfig = {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	headers?: SimpleProviderDiscoveryHeaders;
};

function resolveSimpleProviderHeaders(
	headers: SimpleProviderDiscoveryHeaders | undefined,
): Record<string, string> | undefined {
	return typeof headers === "function" ? headers() : headers;
}

type OpenAICompatibleModelManagerBuilderOptions<TApi extends Api> = {
	api: TApi;
	providerId: GeneratedProvider;
	defaultBaseUrl: string;
	config?: SimpleProviderConfig;
	headers?: SimpleProviderDiscoveryHeaders;
	dynamicModelsAuthoritative?: true;
	requireApiKey?: true;
	dropCachedModelIdsOnStaticMismatch?: readonly string[];
	cacheProviderId?: string;
	filterModel?: (
		entry: OpenAICompatibleModelRecord,
		model: ModelSpec<TApi>,
		references: Map<string, ModelSpec<TApi>>,
	) => boolean;
	mapModel: (
		entry: OpenAICompatibleModelRecord,
		defaults: ModelSpec<TApi>,
		reference: ModelSpec<TApi> | undefined,
	) => ModelSpec<TApi> | null;
};

/**
 * The wire effort tiers the catalog publishes for a model, in canonical order.
 * Undefined when the row has no effort-addressed thinking, or names no known tier.
 */
function publishedEffortLadder(model: ModelsDevModel): Effort[] | undefined {
	const values = model.reasoning_options?.find(option => option?.type === "effort")?.values;
	if (!Array.isArray(values)) return undefined;
	const ladder = THINKING_EFFORTS.filter(effort => values.includes(effort));
	return ladder.length > 0 ? ladder : undefined;
}

/**
 * Published ladders, addressable both by the host that published them and by bare id.
 *
 * `byHost` (keyed `provider\0id`) is authoritative: a ladder is only valid for the deployment
 * that published it. `byId` answers when the host is unknown, and only while every host
 * publishing that id agrees on its dial; an id whose hosts disagree, or that any host publishes
 * with no dial at all, is dropped so the ladder stays unknown instead of borrowing a foreign one.
 * `withoutLadder` marks a host that publishes the id without a dial: the serving host's silence
 * vetoes the bare-id fallback for that id.
 */
interface PublishedEffortLadders {
	byHost: ReadonlyMap<string, readonly Effort[]>;
	byId: ReadonlyMap<string, readonly Effort[]>;
	withoutLadder: ReadonlySet<string>;
}

const EMPTY_PUBLISHED_EFFORT_LADDERS: PublishedEffortLadders = {
	byHost: new Map(),
	byId: new Map(),
	withoutLadder: new Set(),
};

function indexPublishedEffortLadders(payload: unknown): PublishedEffortLadders {
	const byHost = new Map<string, readonly Effort[]>();
	const byId = new Map<string, readonly Effort[]>();
	const withoutLadder = new Set<string>();
	const index: PublishedEffortLadders = { byHost, byId, withoutLadder };
	const unshareable = new Set<string>();
	if (!isRecord(payload)) return index;
	for (const [providerKey, provider] of Object.entries(payload)) {
		if (!isRecord(provider) || !isRecord(provider.models)) continue;
		for (const [modelId, rawModel] of Object.entries(provider.models)) {
			if (!isRecord(rawModel)) continue;
			const key = `${providerKey}\u0000${modelId}`;
			const ladder = publishedEffortLadder(rawModel as ModelsDevModel);
			if (!ladder) {
				withoutLadder.add(key);
				// Some deployment of this id rejects an effort dial; without knowing which host
				// serves a bare id, none may claim one.
				byId.delete(modelId);
				unshareable.add(modelId);
				continue;
			}
			byHost.set(key, ladder);
			if (unshareable.has(modelId)) continue;
			const shared = byId.get(modelId);
			if (shared === undefined) {
				byId.set(modelId, ladder);
			} else if (shared.length !== ladder.length || shared.some((effort, index) => effort !== ladder[index])) {
				byId.delete(modelId);
				unshareable.add(modelId);
			}
		}
	}
	return index;
}

/**
 * The index is tagged onto the catalog payload it was built from, so each catalog version is
 * indexed once; {@link fetchWellKnownModels} already scopes, coalesces, revalidates, and keeps the
 * last good payload, so the tag inherits that lifetime.
 */
const kPublishedEffortLadders = Symbol("catalog.publishedEffortLadders");

interface IndexedCatalogPayload {
	[kPublishedEffortLadders]?: PublishedEffortLadders;
}

async function loadPublishedEffortLadders(fetchImpl?: FetchImpl): Promise<PublishedEffortLadders> {
	const payload = await fetchWellKnownModels(fetchImpl);
	if (!isRecord(payload)) return EMPTY_PUBLISHED_EFFORT_LADDERS;
	const tagged = payload as IndexedCatalogPayload;
	tagged[kPublishedEffortLadders] ??= indexPublishedEffortLadders(payload);
	return tagged[kPublishedEffortLadders];
}

/** Catalog provider keys this endpoint publishes under (`moonshot` → `moonshotai`), plus its own id. */
function catalogProviderKeys(providerId: string): readonly string[] {
	const keys = new Set<string>();
	for (const descriptor of MODELS_DEV_DESCRIPTORS_BY_PROVIDER[providerId] ?? []) keys.add(descriptor.modelsDevKey);
	keys.add(providerId);
	return [...keys];
}

/**
 * The ladder published for a discovered id, preferring the host that serves it. Gateway prefixes
 * are peeled (`deepseek/deepseek-v4` → `deepseek-v4`) and each peeled segment joins the host
 * candidates ahead of the endpoint's own keys: on an aggregator the prefix names the real upstream.
 * All host-scoped candidates are checked before accepting a shared bare-id ladder.
 */
function lookupPublishedEffortLadder(
	ladders: PublishedEffortLadders,
	providerKeys: readonly string[],
	modelId: string,
): readonly Effort[] | undefined {
	const hosts = [...providerKeys];
	let shared: readonly Effort[] | undefined;
	for (let candidate = modelId; ; ) {
		let dialless = false;
		for (const host of hosts) {
			const key = `${host}\u0000${candidate}`;
			const scoped = ladders.byHost.get(key);
			if (scoped) return scoped;
			dialless ||= ladders.withoutLadder.has(key);
		}
		if (dialless) return undefined;
		shared ??= ladders.byId.get(candidate);
		const slash = candidate.indexOf("/");
		if (slash < 0) return shared;
		hosts.unshift(candidate.slice(0, slash));
		candidate = candidate.slice(slash + 1);
	}
}

/**
 * Fill the effort ladder of discovered reasoning models whose tiers would otherwise be guessed.
 * A provider-reported thinking surface and any model-scoped ladder stay as they are; only the
 * guess is corrected, and no catalog request is made when every discovered model is covered.
 */
async function applyPublishedEffortLadders<TApi extends Api>(
	models: readonly ModelSpec<TApi>[] | null,
	providerId: string,
	fetchImpl?: FetchImpl,
): Promise<readonly ModelSpec<TApi>[] | null> {
	if (models === null) return null;
	const guessed = new Set(
		models
			.filter(
				model =>
					model.reasoning === true &&
					model.thinking === undefined &&
					!hasModelScopedEffortLadder(model, buildCompat(model as ModelSpec<Api>) as CompatOf<TApi>),
			)
			.map(model => model.id),
	);
	if (guessed.size === 0) return models;
	// An unreachable catalog with no prior payload is not a discovery failure: the endpoint's own
	// listing stands and the guess stays in place.
	const ladders = await loadPublishedEffortLadders(fetchImpl).catch(() => EMPTY_PUBLISHED_EFFORT_LADDERS);
	if (ladders.byHost.size === 0) return models;
	const providerKeys = catalogProviderKeys(providerId);
	return models.map(model => {
		if (!guessed.has(model.id)) return model;
		const efforts = lookupPublishedEffortLadder(ladders, providerKeys, model.id);
		return efforts ? { ...model, thinking: { mode: "effort" as const, efforts: [...efforts] } } : model;
	});
}

function createOpenAICompatibleModelManagerOptions<TApi extends Api>(
	options: OpenAICompatibleModelManagerBuilderOptions<TApi>,
): ModelManagerOptions<TApi> {
	const apiKey = options.config?.apiKey;
	const baseUrl = options.config?.baseUrl ?? options.defaultBaseUrl;
	const references = createBundledReferenceMap<TApi>(options.providerId);
	const filterModel = options.filterModel;
	return {
		providerId: options.providerId,
		...(options.cacheProviderId && { cacheProviderId: options.cacheProviderId }),
		...(options.dynamicModelsAuthoritative && { dynamicModelsAuthoritative: true }),
		...(options.dropCachedModelIdsOnStaticMismatch && {
			dropCachedModelIdsOnStaticMismatch: options.dropCachedModelIdsOnStaticMismatch,
		}),
		...((!options.requireApiKey || apiKey) && {
			fetchDynamicModels: async () =>
				applyPublishedEffortLadders(
					await fetchOpenAICompatibleModels({
						api: options.api,
						provider: options.providerId,
						baseUrl,
						apiKey,
						...(options.headers && { headers: resolveSimpleProviderHeaders(options.headers) }),
						...(filterModel && {
							filterModel: (entry, model) => filterModel(entry, model, references),
						}),
						mapModel: (entry, defaults) => options.mapModel(entry, defaults, references.get(defaults.id)),
						fetch: options.config?.fetch,
					}),
					options.providerId,
					options.config?.fetch,
				),
		}),
	};
}

export function createSimpleOpenAICompletionsOptions(
	providerId: Parameters<typeof getBundledModels>[0],
	defaultBaseUrl: string,
	config?: SimpleProviderConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId,
		defaultBaseUrl,
		config,
		headers: config?.headers,
		requireApiKey: true,
		mapModel: mapWithBundledReference,
	});
}

function createSimpleAnthropicProviderOptions(
	providerId: Parameters<typeof getBundledModels>[0],
	defaultBaseUrlFallback: string,
	config?: SimpleProviderConfig,
): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeAnthropicBaseUrl(config?.baseUrl, defaultBaseUrlFallback);
	const discoveryBaseUrl = toAnthropicDiscoveryBaseUrl(baseUrl);
	const references = createBundledReferenceMap<"anthropic-messages">(providerId);
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "anthropic-messages",
					provider: providerId,
					baseUrl: discoveryBaseUrl,
					headers: buildAnthropicDiscoveryHeaders(apiKey),
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						const model = mapWithBundledReference(entry, defaults, reference);
						return {
							...model,
							name: toModelName(entry.display_name, model.name),
							baseUrl,
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

const UMANS_BASE_URL = "https://api.code.umans.ai";
const UMANS_MODELS_INFO_PATH = "/models/info";
const UMANS_REASONING_EFFORT_BY_LEVEL: Record<string, Effort> = {
	minimal: Effort.Minimal,
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};
const UMANS_DEFAULT_REASONING_EFFORTS = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] as const;
const UMANS_VIA_HANDOFF_MODEL_IDS = ["umans-glm-5.1", "umans-glm-5.2"] as const;

export interface UmansModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

interface UmansModelInfo {
	name?: unknown;
	display_name?: unknown;
	capabilities?: unknown;
}

function normalizeUmansBaseUrl(baseUrl: string | undefined): string {
	const normalized = normalizeAnthropicBaseUrl(baseUrl, UMANS_BASE_URL);
	return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

function umansSupportsVision(value: unknown): boolean {
	return value === true;
}

function umansReasoningSupported(value: unknown): boolean {
	return isRecord(value) ? value.supported === true : value === true;
}

function mapUmansReasoningEfforts(value: unknown): readonly Effort[] {
	if (!isRecord(value) || !Array.isArray(value.levels)) {
		return UMANS_DEFAULT_REASONING_EFFORTS;
	}
	const efforts: Effort[] = [];
	for (const level of value.levels) {
		if (typeof level !== "string") continue;
		const effort = UMANS_REASONING_EFFORT_BY_LEVEL[level];
		if (effort !== undefined && !efforts.includes(effort)) {
			efforts.push(effort);
		}
	}
	return efforts.length > 0 ? efforts : UMANS_DEFAULT_REASONING_EFFORTS;
}

function umansHasMaxReasoningLevel(value: unknown): boolean {
	return isRecord(value) && Array.isArray(value.levels) && value.levels.includes("max");
}

function mapUmansThinkingConfig(value: unknown): ThinkingConfig | undefined {
	if (!umansReasoningSupported(value)) return undefined;
	const efforts = mapUmansReasoningEfforts(value);
	const thinking: ThinkingConfig = {
		mode: umansHasMaxReasoningLevel(value) ? "anthropic-budget-effort" : "budget",
		efforts,
	};
	if (isRecord(value)) {
		if (value.can_disable === false) {
			thinking.requiresEffort = true;
		}
		if (typeof value.default_level === "string") {
			const defaultLevel = UMANS_REASONING_EFFORT_BY_LEVEL[value.default_level];
			if (defaultLevel !== undefined && efforts.includes(defaultLevel)) {
				thinking.defaultLevel = defaultLevel;
			}
		}
	}
	return thinking;
}

function mapUmansModelInfo(
	modelId: string,
	raw: UmansModelInfo,
	baseUrl: string,
	reference: ModelSpec<"anthropic-messages"> | undefined,
): ModelSpec<"anthropic-messages"> | null {
	if (!modelId) return null;
	const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {};
	const supportsTools = capabilities.supports_tools;
	const thinking = mapUmansThinkingConfig(capabilities.reasoning);
	return {
		...reference,
		id: modelId,
		name: toModelName(raw.display_name, toModelName(raw.name, modelId)),
		api: "anthropic-messages",
		provider: "umans",
		baseUrl,
		compat: { ...reference?.compat, escapeBuiltinToolNames: true },
		reasoning: thinking !== undefined,
		...(thinking ? { thinking } : {}),
		input: umansSupportsVision(capabilities.supports_vision) ? ["text", "image"] : ["text"],
		...(supportsTools === false ? { supportsTools: false } : {}),
		cost: reference?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: toPositiveNumber(capabilities.context_window, reference?.contextWindow ?? null),
		maxTokens: toPositiveNumber(
			capabilities.recommended_max_tokens,
			toPositiveNumber(capabilities.max_completion_tokens, reference?.maxTokens ?? null),
		),
	};
}

async function fetchUmansModelsInfo(options: {
	baseUrl: string;
	apiKey?: string;
	fetch?: FetchImpl;
	references: Map<string, ModelSpec<"anthropic-messages">>;
}): Promise<ModelSpec<"anthropic-messages">[] | null> {
	const discoveryBaseUrl = toAnthropicDiscoveryBaseUrl(options.baseUrl);
	const requestHeaders: Record<string, string> = { Accept: "application/json" };
	if (options.apiKey) {
		requestHeaders["x-api-key"] = options.apiKey;
	}
	const fetchImpl = discoveryFetch(options.fetch);
	let payload: unknown;
	try {
		const response = await fetchImpl(`${discoveryBaseUrl}${UMANS_MODELS_INFO_PATH}`, {
			method: "GET",
			headers: requestHeaders,
		});
		if (!response.ok) {
			return null;
		}
		payload = await response.json();
	} catch (error) {
		throw new Error("Failed to fetch Umans models info", { cause: error });
	}
	if (!isRecord(payload)) {
		return null;
	}
	const models: ModelSpec<"anthropic-messages">[] = [];
	for (const [modelId, value] of Object.entries(payload)) {
		if (!isRecord(value)) continue;
		const mapped = mapUmansModelInfo(modelId, value, options.baseUrl, options.references.get(modelId));
		if (mapped) {
			models.push(mapped);
		}
	}
	return models.sort((left, right) => left.id.localeCompare(right.id));
}

export function umansModelManagerOptions(config?: UmansModelManagerConfig): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeUmansBaseUrl(config?.baseUrl);
	const references = createBundledReferenceMap<"anthropic-messages">("umans");
	return {
		providerId: "umans",
		dynamicModelsAuthoritative: true,
		dropCachedModelIdsOnStaticMismatch: UMANS_VIA_HANDOFF_MODEL_IDS,
		fetchDynamicModels: () => fetchUmansModelsInfo({ baseUrl, apiKey, fetch: config?.fetch, references }),
	};
}

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

export const OPENAI_GPT_56_LONG_CONTEXT_COSTS = {
	luna: {
		inputThreshold: 272_000,
		input: 0.4,
		output: 1.8,
		cacheRead: 0.04,
		cacheWrite: 0.5,
	},
	sol: {
		inputThreshold: 272_000,
		input: 10,
		output: 45,
		cacheRead: 1,
		cacheWrite: 12.5,
	},
	terra: {
		inputThreshold: 272_000,
		input: 4,
		output: 18,
		cacheRead: 0.4,
		cacheWrite: 5,
	},
} as const satisfies Readonly<Record<"luna" | "sol" | "terra", LongContextTokenCost>>;

export interface OpenAIModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function openaiModelManagerOptions(config?: OpenAIModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-responses",
		providerId: "openai",
		defaultBaseUrl: OPENAI_API_BASE_URL,
		config,
		requireApiKey: true,
		filterModel: (_entry, model, references) => isLikelyOpenAIResponsesModelId(model.id, references),
		mapModel: mapWithBundledReference,
	});
}

export const OPENAI_DAYBREAK_CURATED_FALLBACK_MODELS: readonly ModelSpec<"openai-responses">[] = [
	{
		id: "daybreak-blue-latest",
		name: "Daybreak Blue",
		api: "openai-responses",
		provider: "openai",
		baseUrl: OPENAI_API_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: {
			...OPENAI_GPT_56_SOL_STANDARD_COST,
			longContext: OPENAI_GPT_56_LONG_CONTEXT_COSTS.sol,
		},
		contextWindow: 1_050_000,
		maxTokens: 128_000,
	},
	{
		id: "daybreak-red-latest",
		name: "Daybreak Red",
		api: "openai-responses",
		provider: "openai",
		baseUrl: OPENAI_API_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: OPENAI_GPT_56_CYBER_STANDARD_COST,
		contextWindow: 400_000,
		maxTokens: 128_000,
	},
	{
		id: "gpt-5.6-cyber",
		name: "GPT-5.6 Cyber",
		api: "openai-responses",
		provider: "openai",
		baseUrl: OPENAI_API_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: OPENAI_GPT_56_CYBER_STANDARD_COST,
		contextWindow: 400_000,
		maxTokens: 128_000,
	},
];

const OPENAI_PRO_REASONING_BASE_IDS: Record<string, true> = {
	"gpt-5.6-luna": true,
	"gpt-5.6-sol": true,
	"gpt-5.6-terra": true,
};

const OPENAI_PRO_REASONING_SWEEP_PROVIDERS: Record<string, true> = { openai: true, "openai-codex": true };

function isGeneratedOpenAIProReasoningAlias(model: ModelSpec<Api>): boolean {
	return (
		OPENAI_PRO_REASONING_SWEEP_PROVIDERS[model.provider] === true &&
		model.reasoningMode !== undefined &&
		model.id.endsWith("-pro") &&
		OPENAI_PRO_REASONING_BASE_IDS[model.id.slice(0, -"-pro".length)] === true
	);
}

export function projectOpenAIProReasoningAliases(models: readonly ModelSpec<Api>[]): ModelSpec<Api>[] {
	const kept = models.filter(model => !isGeneratedOpenAIProReasoningAlias(model));
	const ids = new Set(kept.map(model => `${model.provider}/${model.id}`));
	const out = [...kept];
	for (const model of kept) {
		if (model.provider !== "openai") continue;
		if (!OPENAI_PRO_REASONING_BASE_IDS[model.id]) continue;
		const aliasId = `${model.id}-pro`;
		const aliasKey = `${model.provider}/${aliasId}`;
		if (ids.has(aliasKey)) continue;
		ids.add(aliasKey);
		out.push({
			...model,
			id: aliasId,
			name: `${model.name} Pro`,
			requestModelId: model.id,
			reasoningMode: "pro",
		});
	}
	return out;
}

const GMI_CLOUD_BASE_URL = "https://api.gmi-serving.com/v1";

export const GMI_CLOUD_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	{
		id: "deepseek-ai/DeepSeek-V4-Flash",
		name: "DeepSeek V4 Flash",
		api: "openai-completions",
		provider: "gmi-cloud",
		baseUrl: GMI_CLOUD_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0.14, output: 0.28, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 384000,
		thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
	},
];

export interface GmiCloudModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function mapGmiCloudModel(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
	reference: ModelSpec<"openai-completions"> | undefined,
): ModelSpec<"openai-completions"> {
	if (reference) {
		return mapWithBundledReference(entry, defaults, reference);
	}
	const canonical = resolveModelReference(defaults.id, getBundledModelReferenceIndex()) as
		| ModelSpec<"openai-completions">
		| undefined;
	if (!canonical) {
		return { ...defaults, name: toModelName(entry.name, defaults.name) };
	}
	const contextWindow = canonical.contextWindow ?? defaults.contextWindow;
	const maxTokens =
		canonical.maxTokens != null && contextWindow != null
			? Math.min(canonical.maxTokens, contextWindow)
			: (canonical.maxTokens ?? defaults.maxTokens);
	return {
		...defaults,
		name: toModelName(entry.name, canonical.name ?? defaults.name),
		reasoning: canonical.reasoning,
		input: canonical.input,
		...(canonical.thinking && { thinking: canonical.thinking }),
		contextWindow,
		maxTokens,
	};
}

export function gmiCloudModelManagerOptions(
	config?: GmiCloudModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "gmi-cloud",
		defaultBaseUrl: GMI_CLOUD_BASE_URL,
		cacheProviderId: resolveModelCacheProviderId("gmi-cloud"),
		config,
		requireApiKey: true,
		mapModel: mapGmiCloudModel,
	});
}

export interface GroqModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function groqModelManagerOptions(config?: GroqModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("groq", "https://api.groq.com/openai/v1", config);
}

const CEREBRAS_IMAGE_INPUT_MODEL_IDS = new Set(["gemma-4-31b"]);

function applyCerebrasDiscoveryOverrides(model: ModelSpec<"openai-completions">): ModelSpec<"openai-completions"> {
	if (!CEREBRAS_IMAGE_INPUT_MODEL_IDS.has(model.id)) {
		return model;
	}
	return {
		...model,
		input: ["text", "image"],
	};
}

export interface CerebrasModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function cerebrasModelManagerOptions(
	config?: CerebrasModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "cerebras",
		defaultBaseUrl: "https://api.cerebras.ai/v1",
		config,
		requireApiKey: true,
		mapModel: (entry, defaults, reference) =>
			applyCerebrasDiscoveryOverrides(mapWithBundledReference(entry, defaults, reference)),
	});
}

export interface HuggingfaceModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function huggingfaceModelManagerOptions(
	config?: HuggingfaceModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("huggingface", "https://router.huggingface.co/v1", config);
}

export interface NvidiaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function nvidiaModelManagerOptions(
	config?: NvidiaModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("nvidia", "https://integrate.api.nvidia.com/v1", config);
}

export interface NovitaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function novitaArrayIncludes(value: unknown, expected: string): boolean {
	return Array.isArray(value) && value.some(item => item === expected);
}

function isPublicNovitaModelId(id: string): boolean {
	return !id.toLowerCase().startsWith("ai_infer_test");
}

function toNovitaCostPerMillion(value: unknown): number {
	return toPositiveNumber(value, 0) / 10_000;
}

function getNovitaCacheReadPricePerMillion(entry: OpenAICompatibleModelRecord): number {
	const pricing = entry.pricing;
	if (!isRecord(pricing)) {
		return 0;
	}
	const cacheRead = pricing.input_cache_read;
	if (!isRecord(cacheRead)) {
		return 0;
	}
	return toNovitaCostPerMillion(cacheRead.price_per_m);
}

function mapNovitaModel(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
	reference: ModelSpec<"openai-completions"> | undefined,
): ModelSpec<"openai-completions"> {
	const model = mapWithBundledReference(
		{
			...entry,
			name: entry.display_name ?? entry.title ?? entry.name,
		},
		defaults,
		reference,
	);
	return {
		...model,
		reasoning: novitaArrayIncludes(entry.features, "reasoning"),
		supportsTools: novitaArrayIncludes(entry.features, "function-calling"),
		input: toInputCapabilities(entry.input_modalities),
		cost: {
			input: toNovitaCostPerMillion(entry.input_token_price_per_m),
			output: toNovitaCostPerMillion(entry.output_token_price_per_m),
			cacheRead: getNovitaCacheReadPricePerMillion(entry),
			cacheWrite: 0,
		},
		contextWindow: toPositiveNumber(entry.context_size, model.contextWindow),
		maxTokens: toPositiveNumber(entry.max_output_tokens, model.maxTokens),
	};
}

export function novitaModelManagerOptions(
	config?: NovitaModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "novita",
		defaultBaseUrl: "https://api.novita.ai/openai/v1",
		config,
		dynamicModelsAuthoritative: true,
		filterModel: (entry, model) => {
			const active = typeof entry.status !== "number" || entry.status === 1;
			return (
				active &&
				isPublicNovitaModelId(model.id) &&
				novitaArrayIncludes(entry.endpoints, "chat/completions") &&
				toPositiveNumber(entry.max_output_tokens, 0) > 0
			);
		},
		mapModel: mapNovitaModel,
	});
}

export const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";
// `filter=with_meta` attaches per-model metadata (limits, pricing, tags); `sort_by=omp` requests
// DeepInfra's priority order once the server honors it (response order is preserved below).
const DEEPINFRA_MODELS_QUERY = "?filter=with_meta&sort_by=omp";
const DEEPINFRA_EFFORTS = [Effort.Low, Effort.Medium, Effort.High] as const;

export interface DeepinfraModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

interface DeepinfraModelEntry {
	id?: unknown;
	metadata?: unknown;
}

function deepinfraTags(metadata: Record<string, unknown>): readonly string[] {
	const tags = metadata.tags;
	return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

/**
 * Maps one DeepInfra catalog entry to a chat model; non-`chat` entries (tts, stt, embed, image/video
 * generation) are dropped. Prices are USD per 1M tokens (our unit). A bundled reference lends
 * compat metadata, but live metadata always wins for limits, pricing, and modalities.
 */
function mapDeepinfraModel(
	entry: DeepinfraModelEntry,
	baseUrl: string,
	reference: ModelSpec<"openai-completions"> | undefined,
): ModelSpec<"openai-completions"> | null {
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!id) return null;
	const metadata = isRecord(entry.metadata) ? entry.metadata : {};
	const tags = deepinfraTags(metadata);
	if (!tags.includes("chat")) return null;
	const pricing = isRecord(metadata.pricing) ? metadata.pricing : {};
	// `metadata.discount` is a promotional fraction in [0, 1): DeepInfra bills `pricing * (1 - discount)`
	// while `pricing.*` stays at list price. Values outside (0, 1) are ignored.
	const discount = toNumber(metadata.discount);
	const discountMultiplier = discount !== undefined && discount > 0 && discount < 1 ? 1 - discount : 1;
	// DeepInfra accepts `reasoning_effort` platform-wide (422 only for out-of-enum values), so a stale
	// reference ladder surviving a dropped tag is ignored by the host rather than rejected.
	const thinking: ThinkingConfig | undefined = tags.includes("reasoning_effort")
		? { mode: "effort", efforts: [...DEEPINFRA_EFFORTS] }
		: undefined;
	const contextWindow = toPositiveNumber(metadata.context_length, reference?.contextWindow ?? null);
	// `metadata.max_tokens` mirrors `context_length` today (a total ceiling, not an output cap); trust it
	// only when strictly below the window. A reference cap above the served window is clamped into it.
	const liveMaxTokens = toPositiveNumber(metadata.max_tokens, 0);
	const hasLiveOutputCap = contextWindow !== null && liveMaxTokens > 0 && liveMaxTokens < contextWindow;
	const referenceMaxTokens = reference?.maxTokens ?? null;
	const maxTokens = hasLiveOutputCap
		? liveMaxTokens
		: referenceMaxTokens !== null && contextWindow !== null
			? Math.min(referenceMaxTokens, contextWindow)
			: referenceMaxTokens;
	return {
		...reference,
		id,
		name: reference?.name ?? id,
		api: "openai-completions",
		provider: "deepinfra",
		baseUrl,
		reasoning: tags.includes("reasoning") || tags.includes("reasoning_effort"),
		...(thinking ? { thinking } : {}),
		input: tags.includes("vision") || tags.includes("vlm") ? ["text", "image"] : ["text"],
		cost: {
			input: toPositiveNumber(pricing.input_tokens, 0) * discountMultiplier,
			output: toPositiveNumber(pricing.output_tokens, 0) * discountMultiplier,
			cacheRead: toPositiveNumber(pricing.cache_read_tokens, 0) * discountMultiplier,
			cacheWrite: 0,
		},
		contextWindow,
		maxTokens,
	};
}

// Bespoke fetch: the shared OpenAI-compatible helper cannot carry the query params and re-sorts by id,
// which would destroy DeepInfra's priority order. Dedupe keeps the first (highest-priority) occurrence.
async function fetchDeepinfraModels(options: {
	baseUrl: string;
	apiKey?: string;
	fetch?: FetchImpl;
	references: Map<string, ModelSpec<"openai-completions">>;
}): Promise<ModelSpec<"openai-completions">[] | null> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
	const fetchImpl = discoveryFetch(options.fetch);
	let payload: unknown;
	try {
		const response = await withCatalogDiscoveryTimeout(DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS, signal =>
			fetchImpl(`${options.baseUrl}/models${DEEPINFRA_MODELS_QUERY}`, { method: "GET", headers, signal }),
		);
		if (!response.ok) return null;
		payload = await response.json();
	} catch {
		return null;
	}
	if (!isRecord(payload) || !Array.isArray(payload.data)) return null;
	const models: ModelSpec<"openai-completions">[] = [];
	const seen = new Set<string>();
	for (const entry of payload.data) {
		if (!isRecord(entry)) continue;
		const reference = typeof entry.id === "string" ? options.references.get(entry.id) : undefined;
		const mapped = mapDeepinfraModel(entry as DeepinfraModelEntry, options.baseUrl, reference);
		if (mapped && !seen.has(mapped.id)) {
			seen.add(mapped.id);
			models.push(mapped);
		}
	}
	return models;
}

/** The catalog endpoint is public: discovery and keyless generation work without a key; runtime use needs one. */
export function deepinfraModelManagerOptions(
	config?: DeepinfraModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = (config?.baseUrl ?? DEEPINFRA_BASE_URL).replace(/\/$/, "");
	const references = createBundledReferenceMap<"openai-completions">("deepinfra");
	return {
		providerId: "deepinfra",
		dynamicModelsAuthoritative: true,
		fetchDynamicModels: () => fetchDeepinfraModels({ baseUrl, apiKey, fetch: config?.fetch, references }),
	};
}

const YOLO_AUTO_BASE_URL = "https://yolo-auto.com/v1";
const YOLO_AUTO_FLAT_RATE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

// `qwen3.8-flash` is the documented default on every plan at a 256K window; the paid `yolo` route is backed
// by the same Flash deployment, so the opaque alias carries the Qwen tokenizer explicitly.
function createYoloAutoQwenFlashModel(id: string, name: string): ModelSpec<"openai-completions"> {
	return {
		id,
		name,
		api: "openai-completions",
		provider: "yolo-auto",
		baseUrl: YOLO_AUTO_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { ...YOLO_AUTO_FLAT_RATE_COST },
		contextWindow: 262_144,
		maxTokens: 131_072,
		tokenizer: "qwen3",
		thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		compat: {
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsReasoningEffort: true,
			thinkingFormat: "qwen-chat-template",
			qwenTemplateReasoningEffort: true,
		},
	};
}

/**
 * Documented Yolo-Auto catalog (yolo-auto.com/models): `/v1/models` lists bare ids with no limit fields, so
 * these seeds are the provider-local references that discovery maps onto. Without them the bare
 * `qwen3.8-flash` slug resolves through the global index, whose largest bundled window (1M) misreports the
 * deployment cap.
 */
export const YOLO_AUTO_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	{
		id: "deepseek-flash-v4",
		name: "DeepSeek Flash V4",
		api: "openai-completions",
		provider: "yolo-auto",
		baseUrl: YOLO_AUTO_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { ...YOLO_AUTO_FLAT_RATE_COST },
		contextWindow: 131_072,
		maxTokens: 131_072,
		thinking: {
			mode: "effort",
			efforts: [...THINKING_EFFORTS],
			effortMap: {
				[Effort.Minimal]: "low",
				[Effort.Low]: "low",
				[Effort.Medium]: "high",
				[Effort.High]: "high",
				[Effort.XHigh]: "max",
				[Effort.Max]: "max",
			},
		},
		compat: {
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsReasoningEffort: true,
			thinkingFormat: "chat-template",
		},
	},
	createYoloAutoQwenFlashModel("qwen3.8-flash", "Qwen3.8 Flash"),
	createYoloAutoQwenFlashModel("yolo", "Yolo"),
];

export interface YoloAutoModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

// Flat-rate billing and the no-store/no-developer-role wire surface are provider-wide: they must win whether
// the reference came from the curated seed, the yolo bundle, the global index, or nowhere.
function mapYoloAutoModel(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
	reference: ModelSpec<"openai-completions"> | undefined,
): ModelSpec<"openai-completions"> {
	const model = mapWithBundledReference(entry, defaults, reference);
	return {
		...model,
		cost: { ...YOLO_AUTO_FLAT_RATE_COST },
		compat: { ...model.compat, supportsStore: false, supportsDeveloperRole: false },
	};
}

/** Live `/v1/models` is authoritative once a key exists; ids added later inherit global reference metadata. */
export function yoloAutoModelManagerOptions(
	config?: YoloAutoModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const resolveReference = createReferenceResolver<"openai-completions">(() => {
		// Curated seeds win over the previous generated bundle so corrections to them are honored; bundle rows
		// keep ids that earlier credentialed generations discovered.
		const references = createBundledReferenceMap<"openai-completions">("yolo-auto");
		for (const model of YOLO_AUTO_STATIC_MODELS) references.set(model.id, model);
		return references;
	});
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "yolo-auto",
		defaultBaseUrl: YOLO_AUTO_BASE_URL,
		config,
		requireApiKey: true,
		dynamicModelsAuthoritative: true,
		mapModel: (entry, defaults, reference) =>
			mapYoloAutoModel(entry, defaults, resolveReference(defaults.id) ?? reference),
	});
}

const STEPFUN_BASE_URL = "https://api.stepfun.ai/v1";
// Verified against the live endpoint: every chat model accepts low/medium/high and `/v1/models` advertises the same.
const STEPFUN_EFFORTS = [Effort.Low, Effort.Medium, Effort.High] as const;
// The Chat Completions API documents `max_tokens` only, never the `max_completion_tokens` spelling.
const STEPFUN_WIRE_COMPAT = { maxTokensField: "max_tokens" } as const;
// `/v1/models` interleaves audio (TTS/ASR) and image SKUs with the chat models.
const STEPFUN_NON_CHAT_PREFIXES = ["stepaudio-", "step-image-", "step-tts-", "step-2x-large"] as const;

function createStepfunStaticModel(
	id: string,
	name: string,
	input: ModelSpec<"openai-completions">["input"],
	cost: { input: number; output: number; cacheRead: number },
	contextWindow: number,
): ModelSpec<"openai-completions"> {
	return {
		id,
		name,
		api: "openai-completions",
		provider: "stepfun",
		baseUrl: STEPFUN_BASE_URL,
		reasoning: true,
		input,
		// A cache miss already covers writing the prefix, so there is no separate cache-write tariff.
		cost: { ...cost, cacheWrite: 0 },
		contextWindow,
		// The API accepts `max_tokens` far above any real cap, so the published card (= window) is the ceiling.
		maxTokens: contextWindow,
		thinking: { mode: "effort", efforts: [...STEPFUN_EFFORTS] },
		compat: { ...STEPFUN_WIRE_COMPAT },
	};
}

/**
 * StepFun's chat roster from its published model cards and list prices
 * (platform.stepfun.ai/docs/en/guides/pricing/details), bundled so the provider is selectable without a
 * generation-time key. Video input has no catalog representation, so multimodal rows declare text + image.
 */
export const STEPFUN_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	createStepfunStaticModel(
		"step-5-preview",
		"Step 5 Preview",
		["text", "image"],
		{ input: 1, output: 2.7, cacheRead: 0.05 },
		1_000_000,
	),
	createStepfunStaticModel(
		"step-3.7-flash",
		"Step 3.7 Flash",
		["text", "image"],
		{ input: 0.2, output: 1.15, cacheRead: 0.04 },
		256_000,
	),
	createStepfunStaticModel(
		"step-3.5-flash",
		"Step 3.5 Flash",
		["text"],
		{ input: 0.1, output: 0.3, cacheRead: 0.02 },
		256_000,
	),
	createStepfunStaticModel(
		"step-3.5-flash-2603",
		"Step 3.5 Flash 2603",
		["text"],
		{ input: 0.1, output: 0.3, cacheRead: 0.02 },
		256_000,
	),
];

const STEPFUN_STATIC_MODEL_BY_ID = new Map(STEPFUN_STATIC_MODELS.map(model => [model.id, model] as const));

export function isStepfunChatModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	return normalized.length > 0 && !STEPFUN_NON_CHAT_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

// Advertised tiers map verbatim in effort order; a row advertising none resolves to no thinking, so the wire never
// sends a `reasoning_effort` the endpoint rejects.
function mapStepfunThinking(entry: OpenAICompatibleModelRecord): ThinkingConfig | undefined {
	const advertised = Array.isArray(entry.reasoning_effort_support_list)
		? entry.reasoning_effort_support_list.filter((value): value is string => typeof value === "string")
		: [];
	const efforts = THINKING_EFFORTS.filter(effort => advertised.includes(effort));
	return efforts.length === 0 ? undefined : { mode: "effort", efforts };
}

export interface StepfunModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

/**
 * A successful `/v1/models` snapshot is authoritative over the bundled seeds, so a retired id leaves the picker;
 * ids StepFun adds later take their effort dial from the endpoint's own `reasoning_effort_support_list`.
 */
export function stepfunModelManagerOptions(
	config?: StepfunModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "stepfun",
		defaultBaseUrl: STEPFUN_BASE_URL,
		config,
		requireApiKey: true,
		dynamicModelsAuthoritative: true,
		filterModel: (_entry, model) => isStepfunChatModelId(model.id),
		mapModel: (entry, defaults, bundled) => {
			const reference = bundled ?? STEPFUN_STATIC_MODEL_BY_ID.get(defaults.id);
			const mapped = mapWithBundledReference(entry, defaults, reference);
			const compat = { ...mapped.compat, ...STEPFUN_WIRE_COMPAT };
			if (reference) return { ...mapped, compat };
			const thinking = mapStepfunThinking(entry);
			return thinking === undefined ? { ...mapped, compat } : { ...mapped, reasoning: true, thinking, compat };
		},
	});
}

const COMMAND_CODE_PROVIDER_BASE_PATH = "https://api.commandcode.ai/provider";
// The Provider API exposes no per-model output maximum and the CLI requests 64K by default.
const COMMAND_CODE_DEFAULT_MAX_TOKENS = 65_536;

function commandCodeLadder(ids: readonly string[], efforts: readonly Effort[]): [string, readonly Effort[]][] {
	return ids.map(id => [id, efforts]);
}

// Effort ladders mirror the command-code@1.44.0 effort registry (plus the Muse Spark lineage and
// `deepseek/deepseek-v4.1-flash` from 1.53.0). Every other served id has no effort dial and must omit the
// effort control on the wire.
const COMMAND_CODE_EFFORT_LADDERS: ReadonlyMap<string, readonly Effort[]> = new Map([
	...commandCodeLadder(
		[
			"claude-fable-5",
			"claude-fable-5-1",
			"claude-opus-4-7",
			"claude-opus-4-8",
			"claude-opus-5",
			"claude-sonnet-4-6",
			"claude-sonnet-5",
		],
		[Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	),
	...commandCodeLadder(
		[
			"deepseek/deepseek-v4-flash",
			"deepseek/deepseek-v4-flash-vision-exp",
			"deepseek/deepseek-v4-pro",
			"zai-org/GLM-5.2",
		],
		[Effort.High, Effort.Max],
	),
	...commandCodeLadder(
		[
			"deepseek/deepseek-v4-flash-fast",
			"deepseek/deepseek-v4.1-flash",
			"moonshotai/Kimi-K3",
			"z-ai/glm-5.3-flash",
			"zai-org/GLM-5.3",
		],
		[Effort.Low, Effort.High, Effort.Max],
	),
	...commandCodeLadder(
		[
			"google/gemini-3.1-flash-lite",
			"google/gemini-3.5-flash",
			"google/gemini-3.5-flash-lite",
			"google/gemini-3.6-flash",
			"google/gemini-3.7-flash",
			"google/gemini-3.8-flash",
			"gpt-5.4-mini",
			"tencent/hy4-preview",
			"xai/grok-4.5",
		],
		[Effort.Low, Effort.Medium, Effort.High],
	),
	...commandCodeLadder(
		["gpt-5.3-codex", "gpt-5.4", "gpt-5.5", "xai/grok-4.6"],
		[Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	),
	...commandCodeLadder(
		["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
		[Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	),
	...commandCodeLadder(
		[
			"meta/muse-spark-1.1",
			"meta/muse-spark-1.2",
			"meta/muse-spark-1.2-contributor",
			"meta/muse-spark-1.3",
			"meta/muse-spark-1.3-contributor",
		],
		[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	),
	...commandCodeLadder(
		["Qwen/Qwen3.8-27B", "Qwen/Qwen3.8-Flash", "Qwen/Qwen3.8-Max", "Qwen/Qwen3.8-Max-0902"],
		[Effort.Low, Effort.Medium, Effort.XHigh],
	),
	...commandCodeLadder(["sakana/fugu-ultra"], [Effort.High, Effort.XHigh]),
]);

// The only per-model caps in the CLI registry, plus the Codex prompt window (its advertised window includes
// the output budget).
const COMMAND_CODE_LIMITS: Readonly<Record<string, { contextWindow?: number; maxTokens?: number }>> = {
	"Qwen/Qwen3.8-27B": { maxTokens: 32_768 },
	"z-ai/glm-5.3-flash": { maxTokens: 131_072 },
	"gpt-5.3-codex": { contextWindow: 272_000 },
};

// Rows carry no modality metadata; `deepseek/deepseek-v4.1-flash` is documented with image input even though its
// id has no vision token.
const COMMAND_CODE_IMAGE_MODELS: ReadonlySet<string> = new Set(["deepseek/deepseek-v4.1-flash"]);

type CommandCodeCost = ModelSpec<"openai-completions">["cost"];

function commandCodeCost(
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite = 0,
	longContext?: CommandCodeCost["longContext"],
): CommandCodeCost {
	return { input, output, cacheRead, cacheWrite, ...(longContext && { longContext }) };
}

// Command Code's per-1M-token USD list prices (rate card in command-code@1.44.0 + the live models page). Standing
// deals are priced at their effective rates; DeepSeek V4 uses the off-peak display rates. Unlisted ids (the
// free models) keep zero cost — the mapper never inherits another provider's rates.
const COMMAND_CODE_PRICING: Readonly<Record<string, CommandCodeCost>> = {
	"claude-sonnet-5": commandCodeCost(2, 10, 0.2, 2.5),
	"claude-sonnet-4-6": commandCodeCost(3, 15, 0.3, 3.75),
	"claude-fable-5-1": commandCodeCost(10, 50, 0.25, 12.5),
	"claude-fable-5": commandCodeCost(10, 50, 1, 12.5),
	"claude-opus-5": commandCodeCost(5, 25, 0.5, 6.25),
	"claude-opus-4-8": commandCodeCost(5, 25, 0.5, 6.25),
	"claude-opus-4-7": commandCodeCost(5, 25, 0.5, 6.25),
	"claude-haiku-4-5-20251001": commandCodeCost(1, 5, 0.1, 1.25),
	"gpt-5.6-sol": commandCodeCost(5, 30, 0.5, 6.25),
	"gpt-5.6-terra": commandCodeCost(2, 12, 0.2, 2.5),
	"gpt-5.6-luna": commandCodeCost(0.2, 1.2, 0.02, 0.25),
	"gpt-5.5": commandCodeCost(5, 30, 0.5),
	"gpt-5.4": commandCodeCost(2.5, 15, 0.25),
	"gpt-5.3-codex": commandCodeCost(2, 8, 0.5),
	"gpt-5.4-mini": commandCodeCost(0.75, 4.5, 0.075),
	"deepseek/deepseek-v4-pro": commandCodeCost(0.66, 1.98, 0.022),
	"deepseek/deepseek-v4-flash": commandCodeCost(0.22, 0.66, 0.007),
	"deepseek/deepseek-v4-flash-vision-exp": commandCodeCost(0.22, 0.66, 0.007),
	"deepseek/deepseek-v4-flash-fast": commandCodeCost(0.28, 0.56, 0.07),
	"deepseek/deepseek-v4.1-flash": commandCodeCost(0.15, 0.6, 0.003),
	"moonshotai/Kimi-K3": commandCodeCost(3, 15, 0.3),
	"moonshotai/Kimi-K2.7-Code": commandCodeCost(0.95, 4, 0.19),
	"moonshotai/Kimi-K2.7-Code-Highspeed": commandCodeCost(1.9, 8, 0.38),
	"moonshotai/Kimi-K2.6": commandCodeCost(0.95, 4, 0.16),
	"moonshotai/Kimi-K2.5": commandCodeCost(0.6, 3, 0.1),
	"z-ai/glm-5.3-flash": commandCodeCost(0.15, 0.5, 0.03),
	"zai-org/GLM-5.3": commandCodeCost(1.4, 4.4, 0.26),
	"zai-org/GLM-5.2": commandCodeCost(1.4, 4.4, 0.26),
	"zai-org/GLM-5.1": commandCodeCost(1.4, 4.4, 0.26),
	"zai-org/GLM-5.2-Fast": commandCodeCost(3, 10.25, 0.5),
	"zai-org/GLM-5": commandCodeCost(1, 3.2, 0.2),
	"MiniMaxAI/MiniMax-M3": commandCodeCost(0.3, 1.2, 0.06),
	"MiniMaxAI/MiniMax-M2.7": commandCodeCost(0.3, 1.2, 0.06),
	"MiniMaxAI/MiniMax-M2.5": commandCodeCost(0.3, 1.2, 0.03),
	"xiaomi/mimo-v2.5-pro": commandCodeCost(0.435, 0.87, 0.0036),
	"xiaomi/mimo-v2.5": commandCodeCost(0.14, 0.28, 0.0028),
	"Qwen/Qwen3.8-Max-0902": commandCodeCost(2, 6, 0.25),
	"Qwen/Qwen3.8-Max": commandCodeCost(2, 6, 0.25, 2.5),
	"Qwen/Qwen3.8-27B": commandCodeCost(0.4, 3, 0.04),
	"Qwen/Qwen3.8-Flash": commandCodeCost(0.16, 0.47, 0.016),
	"Qwen/Qwen3.7-Max": commandCodeCost(2.5, 7.5, 0.5, 3.13),
	"Qwen/Qwen3.7-Plus": commandCodeCost(0.4, 1.6, 0.08, 0.5, {
		inputThreshold: 256_000,
		input: 1.2,
		output: 4.8,
		cacheRead: 0.24,
		cacheWrite: 1.5,
	}),
	// Two upstream tiers (>32K, >256K) but one long-context slot: the higher tier from the first crossing
	// over-reports 32K-256K spend rather than under-reporting beyond 256K.
	"Qwen/Qwen3.7-Flash": commandCodeCost(0.03, 0.13, 0.006, 0.038, {
		inputThreshold: 32_000,
		input: 0.2,
		output: 0.8,
		cacheRead: 0.04,
		cacheWrite: 0.25,
	}),
	"Qwen/Qwen3.6-Max-Preview": commandCodeCost(1.3, 7.8, 0.26, 1.63),
	"Qwen/Qwen3.6-Plus": commandCodeCost(0.5, 3, 0.1),
	"stepfun/Step-3.7-Flash": commandCodeCost(0.2, 1.15, 0.04),
	"stepfun/Step-3.5-Flash": commandCodeCost(0.1, 0.3, 0.02),
	"tencent/hy4-preview": commandCodeCost(0.834, 2.501, 0.042),
	"tencent/hy3-paid": commandCodeCost(0.14, 0.58, 0.035),
	"google/gemini-3.8-flash": commandCodeCost(1.5, 7.5, 0.15),
	"google/gemini-3.7-flash": commandCodeCost(1.5, 7.5, 0.15, 0.08334),
	"google/gemini-3.6-flash": commandCodeCost(1.5, 7.5, 0.15),
	"google/gemini-3.5-flash": commandCodeCost(1.5, 9, 0.15),
	"google/gemini-3.5-flash-lite": commandCodeCost(0.3, 2.5, 0.03),
	"google/gemini-3.1-flash-lite": commandCodeCost(0.25, 1.5, 0.03),
	"sakana/fugu-ultra": commandCodeCost(5, 30, 0.5),
	"nvidia/nemotron-3-ultra-550b-a55b": commandCodeCost(0.6, 2.4, 0.12),
	"thinkingmachines/inkling": commandCodeCost(1, 4.05, 0.17),
	"thinkingmachines/inkling-small": commandCodeCost(0.5, 1.2, 0.1),
	"meta/muse-spark-1.1": commandCodeCost(1.25, 4.25, 0.15),
	"meta/muse-spark-1.2": commandCodeCost(1.25, 4.25, 0.15),
	"meta/muse-spark-1.3": commandCodeCost(1.25, 4.25, 0.15),
	"meta/muse-spark-1.2-contributor": commandCodeCost(0.1, 0.2, 0.002),
	"meta/muse-spark-1.3-contributor": commandCodeCost(0.1, 0.2, 0.002),
	"xai/grok-4.5": commandCodeCost(2, 6, 0.5),
	// Whole-request 2x tier above 200K input.
	"xai/grok-4.6": commandCodeCost(2, 6, 0.5, 0, {
		inputThreshold: 200_000,
		input: 4,
		output: 12,
		cacheRead: 1,
		cacheWrite: 0,
	}),
};

/** `baseUrl` is normalized to the shared `/provider` root: Claude ids use its Messages endpoint, others `/v1`. */
export interface CommandCodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function normalizeCommandCodeBasePath(baseUrl: string | undefined): string {
	const normalized = (baseUrl ?? COMMAND_CODE_PROVIDER_BASE_PATH).trim().replace(/\/+$/, "");
	return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

function mapCommandCodeModel(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<Api>,
	basePath: string,
	discoveryBaseUrl: string,
): ModelSpec<Api> {
	const id = defaults.id;
	const efforts = COMMAND_CODE_EFFORT_LADDERS.get(id);
	const limits = COMMAND_CODE_LIMITS[id];
	const base = {
		id,
		name: toModelName(entry.name, defaults.name),
		provider: defaults.provider,
		reasoning: efforts !== undefined,
		cost: COMMAND_CODE_PRICING[id] ?? commandCodeCost(0, 0, 0),
		contextWindow: limits?.contextWindow ?? toPositiveNumber(entry.context_length, null),
		maxTokens: limits?.maxTokens ?? COMMAND_CODE_DEFAULT_MAX_TOKENS,
	};
	if (id.startsWith("claude-")) {
		const model: ModelSpec<"anthropic-messages"> = {
			...base,
			api: "anthropic-messages",
			baseUrl: basePath,
			input: ["text"],
			...(efforts && { thinking: { mode: "anthropic-adaptive", efforts: [...efforts] } }),
			compat: { supportsEagerToolInputStreaming: false, supportsLongCacheRetention: false },
		};
		return model;
	}
	const image = COMMAND_CODE_IMAGE_MODELS.has(id);
	const model: ModelSpec<"openai-completions"> = {
		...base,
		api: "openai-completions",
		baseUrl: discoveryBaseUrl,
		input: image ? ["text", "image"] : ["text"],
		...(efforts && { thinking: { mode: "effort", efforts: [...efforts] } }),
		compat: {
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsReasoningEffort: efforts !== undefined,
			maxTokensField: "max_tokens",
			...(image && { stripImageInput: false }),
		},
	};
	return model;
}

/**
 * Mixed-protocol discovery over the public `/v1/models` catalog. Rows carry no reasoning, modality, or pricing
 * metadata, so the reviewed Command Code policy above is the whole capability source: no same-id reference from
 * another host may lend reasoning, rates, image support, or limits.
 */
export function commandCodeModelManagerOptions(config?: CommandCodeModelManagerConfig): ModelManagerOptions<Api> {
	const basePath = normalizeCommandCodeBasePath(config?.baseUrl);
	const discoveryBaseUrl = `${basePath}/v1`;
	return {
		providerId: "commandcode",
		dynamicModelsAuthoritative: true,
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels<Api>({
				api: "openai-completions",
				provider: "commandcode",
				baseUrl: discoveryBaseUrl,
				// Public catalog; the key is forwarded when present so entitled rows resolve like inference.
				apiKey: config?.apiKey,
				mapModel: (entry, defaults) => mapCommandCodeModel(entry, defaults, basePath, discoveryBaseUrl),
				fetch: config?.fetch,
			}),
	};
}

export interface XaiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

// xAI bills the whole request at 2x the base rates once the prompt reaches 200K tokens, on both the API and
// SuperGrok surfaces. Deriving the tier from the base keeps it in lockstep with list-price updates.
const XAI_LONG_CONTEXT_THRESHOLD = 200_000;
const XAI_LONG_CONTEXT_MULTIPLIER = 2;

// SuperGrok surfaces a few models under ids that differ from their public `xai` equivalent.
const XAI_OAUTH_PRICE_ALIASES: Readonly<Record<string, string>> = {
	"grok-4.20-multi-agent-0309": "grok-4.20-multi-agent-beta-latest",
};

function xaiHasLongContextTier(modelId: string): boolean {
	return (
		modelId === "grok-4.3" ||
		modelId === "grok-4.5" ||
		modelId === "grok-4.6" ||
		modelId === "grok-4.7" ||
		modelId === "grok-build-0.1" ||
		modelId.startsWith("grok-4.20")
	);
}

function hasTokenPrice(cost: ModelSpec["cost"]): boolean {
	return cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
}

function withXaiLongContextTier(model: ModelSpec): ModelSpec {
	if (!xaiHasLongContextTier(model.id) || !hasTokenPrice(model.cost)) return model;
	const longContext: LongContextTokenCost = {
		inputThreshold: XAI_LONG_CONTEXT_THRESHOLD,
		inputThresholdInclusive: true,
		input: model.cost.input * XAI_LONG_CONTEXT_MULTIPLIER,
		output: model.cost.output * XAI_LONG_CONTEXT_MULTIPLIER,
		cacheRead: model.cost.cacheRead * XAI_LONG_CONTEXT_MULTIPLIER,
		cacheWrite: model.cost.cacheWrite * XAI_LONG_CONTEXT_MULTIPLIER,
	};
	return { ...model, cost: { ...model.cost, longContext } };
}

/**
 * Applies xAI's >200K rate card and mirrors public-model prices onto unpriced SuperGrok rows as
 * API-equivalent estimates (the subscription itself reports no pricing).
 */
export function applyXaiCatalogPricing(models: readonly ModelSpec[]): ModelSpec[] {
	const publicCosts = new Map(
		models
			.filter(model => model.provider === "xai" && hasTokenPrice(model.cost))
			.map(model => [model.id, model.cost]),
	);
	return models.map(model => {
		if (model.provider === "xai") return withXaiLongContextTier(model);
		if (model.provider !== "xai-oauth") return model;
		if (hasTokenPrice(model.cost)) return withXaiLongContextTier(model);
		const publicCost = publicCosts.get(model.id) ?? publicCosts.get(XAI_OAUTH_PRICE_ALIASES[model.id] ?? "");
		return publicCost ? withXaiLongContextTier({ ...model, cost: { ...publicCost } }) : model;
	});
}

export function xaiModelManagerOptions(config?: XaiModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	return {
		...createOpenAICompatibleModelManagerOptions({
			api: "openai-responses",
			providerId: "xai",
			defaultBaseUrl: "https://api.x.ai/v1",
			config,
			requireApiKey: true,
			mapModel: mapWithBundledReference,
		}),

		dropCachedModelIdsOnStaticMismatch: getBundledModels("xai").map(model => model.id),
	};
}

export interface XaiOAuthModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

interface XAICuratedModel {
	id: string;
	contextWindow: number;
	name?: string;

	reasoning?: boolean;

	supportsReasoningEffort?: boolean;

	input?: ("text" | "image")[];
}

export const XAI_OAUTH_CURATED_MODELS: readonly XAICuratedModel[] = [
	{
		id: "grok-build",
		contextWindow: 512_000,
		name: "Grok Build",
		supportsReasoningEffort: false,
		input: ["text", "image"],
	},
	{
		id: "grok-build-0.1",
		contextWindow: 256_000,
		name: "Grok Build 0.1",
		supportsReasoningEffort: false,
		input: ["text", "image"],
	},
	{ id: "grok-4.3", contextWindow: 1_000_000, name: "Grok 4.3", input: ["text", "image"] },
	{ id: "grok-4.5", contextWindow: 500_000, name: "Grok 4.5", input: ["text", "image"] },
	{ id: "grok-4.6", contextWindow: 500_000, name: "Grok 4.6", input: ["text", "image"] },
	{ id: "grok-4.7", contextWindow: 500_000, name: "Grok 4.7", input: ["text", "image"] },

	{ id: "grok-4.20-multi-agent-0309", contextWindow: 2_000_000, name: "Grok 4.20 (Multi-Agent)" },
	{
		id: "grok-4.20-0309-reasoning",
		contextWindow: 2_000_000,
		name: "Grok 4.20 (Reasoning)",
		supportsReasoningEffort: false,
		input: ["text", "image"],
	},
	{
		id: "grok-4.20-0309-non-reasoning",
		contextWindow: 2_000_000,
		name: "Grok 4.20 (Non-Reasoning)",
		reasoning: false,
		input: ["text", "image"],
	},

	{
		id: "grok-composer-2.5-fast",
		contextWindow: 200_000,
		name: "Grok Composer 2.5 Fast",
		reasoning: false,
		input: ["text"],
	},
] as const;

const XAI_NON_CHAT_PREFIXES = ["grok-imagine-", "grok-stt-", "grok-voice-"] as const;

function withXaiOAuthCompatDefaults(model: ModelSpec<"openai-responses">): ModelSpec<"openai-responses"> {
	const compat = {
		...(model.compat ?? {}),
		includeEncryptedReasoning: model.compat?.includeEncryptedReasoning ?? true,
		filterReasoningHistory: model.compat?.filterReasoningHistory ?? false,
		supportsImageDetailOriginal: model.compat?.supportsImageDetailOriginal ?? false,
		omitReasoningEffort: model.compat?.omitReasoningEffort ?? !isGrokReasoningEffortCapable(model.id),
	};
	return { ...model, compat };
}

export function applyXaiResponsesThinkingPolicy(model: ModelSpec<"openai-responses">): ModelSpec<"openai-responses"> {
	const effortCapable = model.compat?.supportsReasoningEffort ?? isGrokReasoningEffortCapable(model.id);
	const compat = {
		...(model.compat ?? {}),
		supportsReasoningEffort: effortCapable,
		omitReasoningEffort: model.compat?.omitReasoningEffort ?? !effortCapable,
	};
	if (effortCapable) {
		compat.reasoningEffortMap = { ...xaiResponsesReasoningEffortMap(model.id) };
	} else {
		delete compat.reasoningEffortMap;
	}
	return { ...model, compat };
}

function mergeCuratedIntoModel(
	base: ModelSpec<"openai-responses">,
	curated: XAICuratedModel,
): ModelSpec<"openai-responses"> {
	const effortCapable = curated.supportsReasoningEffort ?? isGrokReasoningEffortCapable(curated.id);
	const compat = {
		...(base.compat ?? {}),
		includeEncryptedReasoning: base.compat?.includeEncryptedReasoning ?? true,
		filterReasoningHistory: false,
		supportsImageDetailOriginal: base.compat?.supportsImageDetailOriginal ?? false,
		omitReasoningEffort: !effortCapable,
		supportsReasoningEffort: effortCapable,
	};
	if (effortCapable) {
		compat.reasoningEffortMap = { ...xaiResponsesReasoningEffortMap(curated.id) };
	} else {
		delete compat.reasoningEffortMap;
	}
	return {
		...base,
		contextWindow: curated.contextWindow,
		maxTokens: curated.contextWindow,
		name: curated.name ?? base.name,
		reasoning: curated.reasoning ?? true,
		input: curated.input ?? base.input,
		compat,
	};
}

function applyXAIOAuthCuration(dynamic: readonly ModelSpec<"openai-responses">[]): ModelSpec<"openai-responses">[] {
	const filtered = dynamic.filter(e => !XAI_NON_CHAT_PREFIXES.some(p => e.id.startsWith(p)));

	const byId = new Map<string, ModelSpec<"openai-responses">>(filtered.map(e => [e.id, e]));
	for (const curated of XAI_OAUTH_CURATED_MODELS) {
		const existing = byId.get(curated.id);
		if (existing) {
			byId.set(curated.id, mergeCuratedIntoModel(existing, curated));
		}
	}

	const template = filtered[0];
	if (template) {
		for (const curated of XAI_OAUTH_CURATED_MODELS) {
			if (!byId.has(curated.id)) {
				const base: ModelSpec<"openai-responses"> = { ...template, id: curated.id, name: curated.id };
				byId.set(curated.id, mergeCuratedIntoModel(base, curated));
			}
		}
	}

	const curatedIds = new Set(XAI_OAUTH_CURATED_MODELS.map(c => c.id));
	const curatedFirst = XAI_OAUTH_CURATED_MODELS.map(c => byId.get(c.id)).filter(
		(e): e is ModelSpec<"openai-responses"> => e !== undefined,
	);
	const rest = filtered.filter(e => !curatedIds.has(e.id)).map(withXaiOAuthCompatDefaults);
	return [...curatedFirst, ...rest];
}

export function buildXaiOAuthStaticSeed(baseUrl?: string): ModelSpec<"openai-responses">[] {
	const resolvedBaseUrl = baseUrl ?? "https://api.x.ai/v1";
	return XAI_OAUTH_CURATED_MODELS.map(curated => {
		const base: ModelSpec<"openai-responses"> = {
			id: curated.id,
			name: curated.id,
			api: "openai-responses",
			provider: "xai-oauth",
			baseUrl: resolvedBaseUrl,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: curated.contextWindow,
			maxTokens: curated.contextWindow,
			compat: { reasoningEffortMap: xaiResponsesReasoningEffortMap(curated.id) },
		};
		return mergeCuratedIntoModel(base, curated);
	});
}

export function xaiOAuthModelManagerOptions(
	config?: XaiOAuthModelManagerConfig,
): ModelManagerOptions<"openai-responses"> {
	const defaultBaseUrl = "https://api.x.ai/v1";
	const resolvedBaseUrl = config?.baseUrl ?? defaultBaseUrl;
	const base = createOpenAICompatibleModelManagerOptions({
		api: "openai-responses",
		providerId: "xai-oauth",
		defaultBaseUrl,
		config,
		requireApiKey: true,
		mapModel: mapWithBundledReference,
	});

	const staticModels = buildXaiOAuthStaticSeed(resolvedBaseUrl);
	if (!base.fetchDynamicModels) {
		return { ...base, staticModels };
	}

	const inner = base.fetchDynamicModels;
	return {
		...base,
		staticModels,
		fetchDynamicModels: async () => {
			const dynamic = await inner();
			return dynamic == null ? dynamic : applyXAIOAuthCuration(dynamic);
		},
	};
}

const AIML_API_NON_CHAT_MODEL_ID_PATTERN =
	/(?:^|[/:._-])(?:audio|embed|embedding|embeddings|i2i|i2v|image|speech|t2i|t2v|tts|video)(?:$|[/:._-])/i;

const AIML_API_NON_CHAT_MODEL_ID_SUBSTRINGS = ["dall-e", "dalle", "flux", "imagen", "sora", "veo", "whisper"] as const;

export function isLikelyAimlApiChatModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	if (!normalized) return false;
	return (
		!AIML_API_NON_CHAT_MODEL_ID_PATTERN.test(normalized) &&
		!AIML_API_NON_CHAT_MODEL_ID_SUBSTRINGS.some(token => normalized.includes(token))
	);
}

export interface AimlApiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function aimlApiModelManagerOptions(
	config?: AimlApiModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "aimlapi",
		defaultBaseUrl: "https://api.aimlapi.com/v1",
		config,
		dynamicModelsAuthoritative: true,
		requireApiKey: true,
		filterModel: (_entry, model) => isLikelyAimlApiChatModelId(model.id),
		mapModel: mapWithBundledReference,
	});
}

export interface DeepSeekModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function deepseekModelManagerOptions(
	config?: DeepSeekModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("deepseek", "https://api.deepseek.com", config);
}

export interface SiliconFlowModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

const SILICONFLOW_NON_CHAT_MODEL_TOKENS = [
	"embedding",
	"reranker",
	"bge-",
	"bce-",
	"stable-diffusion",
	"image",
	"flux",
	"kolors",
	"sensevoice",
	"cosyvoice",
	"fish-speech",
	"indextts",
	"sovits",
	"whisper",
	"hunyuanvideo",
	"wan2",
	"ltx-video",
	"speech",
	"moderator",
	"tts",
] as const;

export function isLikelySiliconFlowChatModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	return !SILICONFLOW_NON_CHAT_MODEL_TOKENS.some(token => normalized.includes(token));
}

const SILICONFLOW_MODELS_DEV_DESCRIPTORS: readonly ModelsDevProviderDescriptor[] = [
	openAiCompletionsDescriptor("siliconflow", "siliconflow", "https://api.siliconflow.com/v1", {
		filterModel: () => true,
	}),
	openAiCompletionsDescriptor("siliconflow-cn", "siliconflow-cn", "https://api.siliconflow.cn/v1", {
		filterModel: () => true,
	}),
];

const SILICONFLOW_MODELS_DEV_REFERENCE_TIMEOUT_MS = 5_000;

async function loadSiliconFlowModelsDevReferences(
	providerId: "siliconflow" | "siliconflow-cn",
	fetchImpl?: FetchImpl,
): Promise<Map<string, ModelSpec<"openai-completions">>> {
	const descriptor = SILICONFLOW_MODELS_DEV_DESCRIPTORS.find(d => d.providerId === providerId);
	if (!descriptor) {
		return new Map();
	}
	try {
		const payload = await withCatalogDiscoveryTimeout(SILICONFLOW_MODELS_DEV_REFERENCE_TIMEOUT_MS, signal =>
			fetchWellKnownModels(fetchImpl, signal),
		);
		return createModelsDevReferenceMap<"openai-completions">(
			mapModelsDevToModels(payload as Record<string, unknown>, [descriptor]),
		);
	} catch {
		return new Map();
	}
}

function createSiliconFlowModelManagerOptions(
	providerId: "siliconflow" | "siliconflow-cn",
	defaultBaseUrl: string,
	config?: SiliconFlowModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? defaultBaseUrl;
	return {
		providerId,
		cacheProviderId: resolveModelCacheProviderId(providerId),
		dynamicModelsAuthoritative: true,
		...(apiKey && {
			fetchDynamicModels: async () => {
				const modelsDevReferences = await loadSiliconFlowModelsDevReferences(providerId, config?.fetch);

				const canonicalReferences = getBundledModelReferenceIndex();
				return fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: providerId,
					baseUrl,
					apiKey,
					filterModel: (_entry, model) => isLikelySiliconFlowChatModelId(model.id),
					mapModel: (entry, defaults) => {
						const modelsDevReference = modelsDevReferences.get(defaults.id);
						if (modelsDevReference) {
							return mapWithBundledReference(entry, defaults, modelsDevReference);
						}

						const canonical = resolveModelReference(defaults.id, canonicalReferences) as
							| ModelSpec<"openai-completions">
							| undefined;
						if (!canonical) {
							return defaults;
						}
						const contextWindow = canonical.contextWindow ?? defaults.contextWindow;
						const maxTokens =
							canonical.maxTokens != null && contextWindow != null
								? Math.min(canonical.maxTokens, contextWindow)
								: (canonical.maxTokens ?? defaults.maxTokens);
						return {
							...defaults,
							name: toModelName(entry.name, canonical.name ?? defaults.name),
							reasoning: canonical.reasoning,
							input: canonical.input,
							contextWindow,
							maxTokens,
						};
					},
					fetch: config?.fetch,
				});
			},
		}),
	};
}

export function siliconflowModelManagerOptions(
	config?: SiliconFlowModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSiliconFlowModelManagerOptions("siliconflow", "https://api.siliconflow.com/v1", config);
}

export function siliconflowCnModelManagerOptions(
	config?: SiliconFlowModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSiliconFlowModelManagerOptions("siliconflow-cn", "https://api.siliconflow.cn/v1", config);
}

export interface ZhipuCodingPlanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function zhipuCodingPlanModelManagerOptions(
	config?: ZhipuCodingPlanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://open.bigmodel.cn/api/coding/paas/v4";
	return {
		providerId: "zhipu-coding-plan",
		dynamicModelsAuthoritative: true,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "zhipu-coding-plan",
					baseUrl,
					apiKey,
					mapModel: (
						_entry: OpenAICompatibleModelRecord,
						defaults: ModelSpec<"openai-completions">,
						_context: OpenAICompatibleModelMapperContext<"openai-completions">,
					): ModelSpec<"openai-completions"> => {
						const id = defaults.id;
						return {
							...defaults,
							reasoning: isReasoningGlmModelId(id) || id.includes("thinking"),
							input: isGlmVisionModelId(id) ? (["text", "image"] as const) : ["text"],
							compat: {
								thinkingFormat: "zai",
								reasoningContentField: "reasoning_content",
								supportsDeveloperRole: false,
							},
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export const FIREWORKS_KIMI_MAX_TOKENS = 32_768;

export const FIREWORKS_KIMI_K27_CODE_MAX_TOKENS = 65_536;

export function isFireworksKimiK2ModelId(modelId: string): boolean {
	const trimmed = modelId.toLowerCase();
	if (/kimi[-._]?k2(?:[._-]?|p)7[-._]?code/.test(trimmed)) return false;
	if (trimmed.startsWith("kimi-k2")) return true;
	return /\/kimi-k2(?:p\d+)?(?:[._-]|$)/.test(trimmed);
}

export function clampFireworksKimiMaxTokens(modelId: string, candidate: number): number;
export function clampFireworksKimiMaxTokens(modelId: string, candidate: number | null): number | null;
export function clampFireworksKimiMaxTokens(modelId: string, candidate: number | null): number | null {
	if (candidate === null) return null;
	return isFireworksKimiK2ModelId(modelId) ? Math.min(candidate, FIREWORKS_KIMI_MAX_TOKENS) : candidate;
}

export const KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS = 32_768;

export function isKimiK27CodeModelId(modelId: string): boolean {
	return /(?:^|\/)kimi[-._]?k2(?:[._-]?|p)7[-._]?code(?:[-._]?highspeed)?$/i.test(modelId);
}

export function clampKimiK27CodeMaxTokens(modelId: string, candidate: number): number;
export function clampKimiK27CodeMaxTokens(modelId: string, candidate: number | null): number | null;
export function clampKimiK27CodeMaxTokens(modelId: string, candidate: number | null): number | null {
	if (candidate === null) return null;
	return isKimiK27CodeModelId(modelId) ? Math.min(candidate, KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS) : candidate;
}

const FIREWORKS_FAST_VARIANT_SPECS: ReadonlyArray<{
	base: string;
	name: string;
	cost: { input: number; output: number; cacheRead: number };
}> = [
	{ base: "kimi-k2.7-code", name: "Kimi K2.7 Code Fast", cost: { input: 1.9, output: 8, cacheRead: 0.38 } },
	{ base: "kimi-k2.6", name: "Kimi K2.6 Fast", cost: { input: 2, output: 8, cacheRead: 0.3 } },
	{ base: "glm-5.1", name: "GLM-5.1 Fast", cost: { input: 2.8, output: 8.8, cacheRead: 0.52 } },
	{ base: "glm-5.2", name: "GLM-5.2 Fast", cost: { input: 2.1, output: 6.6, cacheRead: 0.21 } },
];

export function buildFireworksFastSeed(): ModelSpec<"openai-completions">[] {
	const bundled = createBundledReferenceMap<"openai-completions">("fireworks");
	const seeds: ModelSpec<"openai-completions">[] = [];
	for (const variant of FIREWORKS_FAST_VARIANT_SPECS) {
		const base = bundled.get(variant.base);
		if (!base) continue;
		seeds.push({
			...base,
			id: `${variant.base}${FIREWORKS_FAST_SUFFIX}`,
			name: variant.name,
			cost: {
				input: variant.cost.input,
				output: variant.cost.output,
				cacheRead: variant.cost.cacheRead,
				cacheWrite: 0,
			},
		});
	}
	return seeds;
}

export function stripFireworksDeepSeekThinkingToggle(
	model: ModelSpec<"openai-completions">,
	publicModelId: string,
): ModelSpec<"openai-completions"> {
	if (!publicModelId.startsWith("deepseek-v4")) return model;
	const compat = model.compat;
	if (!compat?.extraBody || !("thinking" in compat.extraBody)) return model;

	const extraBody = { ...compat.extraBody };
	delete extraBody.thinking;
	if (Object.keys(extraBody).length > 0) {
		return { ...model, compat: { ...compat, extraBody } };
	}

	const nextCompat = { ...compat };
	delete nextCompat.extraBody;
	return { ...model, compat: nextCompat };
}

export interface FireworksModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

const FIREWORKS_CONTROL_PLANE_ACCOUNT = "fireworks";
const FIREWORKS_SERVERLESS_FILTER = "supports_serverless=true";
const FIREWORKS_CONTROL_PLANE_PAGE_SIZE = 200;
const FIREWORKS_CONTROL_PLANE_MAX_PAGES = 25;

interface FireworksControlPlaneModel {
	name?: unknown;
	displayName?: unknown;
	contextLength?: unknown;
	supportsImageInput?: unknown;
	supportsTools?: unknown;
	supportsServerless?: unknown;
	state?: unknown;
}

function toFireworksControlPlaneModelsUrl(baseUrl: string, account: string): string | null {
	try {
		return `${new URL(baseUrl).origin}/v1/accounts/${account}/models`;
	} catch {
		return null;
	}
}

function mapFireworksControlPlaneModel(
	record: FireworksControlPlaneModel,
	publicModelId: string,
	reference: ModelSpec<"openai-completions"> | undefined,
	baseUrl: string,
): ModelSpec<"openai-completions"> {
	const name = toModelName(record.displayName, reference?.name ?? publicModelId);
	const supportsImage = toBoolean(record.supportsImageInput) === true;
	const supportsTools = toBoolean(record.supportsTools);
	const contextWindow = toPositiveNumber(record.contextLength, reference?.contextWindow ?? null);

	const fallbackMaxTokens = isKimiK27CodeModelId(publicModelId)
		? FIREWORKS_KIMI_K27_CODE_MAX_TOKENS
		: isFireworksKimiK2ModelId(publicModelId)
			? FIREWORKS_KIMI_MAX_TOKENS
			: null;
	const maxTokens = clampFireworksKimiMaxTokens(publicModelId, reference?.maxTokens ?? fallbackMaxTokens);
	const base: ModelSpec<"openai-completions"> = reference ?? {
		id: publicModelId,
		name,
		api: "openai-completions",
		provider: "fireworks",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
	const model: ModelSpec<"openai-completions"> = {
		...base,
		id: publicModelId,
		api: "openai-completions",
		provider: "fireworks",
		baseUrl,
		name,

		reasoning: reference?.reasoning ?? true,
		input: supportsImage ? ["text", "image"] : (reference?.input ?? ["text"]),
		contextWindow,
		maxTokens,
		...(supportsTools === false ? { supportsTools: false } : {}),
	};
	return stripFireworksDeepSeekThinkingToggle(model, publicModelId);
}

async function fetchFireworksServerlessModels(options: {
	baseUrl: string;
	apiKey: string;
	resolveReference: (publicModelId: string) => ModelSpec<"openai-completions"> | undefined;
	fetch?: FetchImpl;
}): Promise<ModelSpec<"openai-completions">[] | null> {
	const listUrl = toFireworksControlPlaneModelsUrl(options.baseUrl, FIREWORKS_CONTROL_PLANE_ACCOUNT);
	if (!listUrl) return null;
	const fetchImpl = discoveryFetch(options.fetch);
	const collected = new Map<string, ModelSpec<"openai-completions">>();
	let pageToken = "";
	for (let page = 0; page < FIREWORKS_CONTROL_PLANE_MAX_PAGES; page++) {
		const url = new URL(listUrl);
		url.searchParams.set("filter", FIREWORKS_SERVERLESS_FILTER);
		url.searchParams.set("pageSize", String(FIREWORKS_CONTROL_PLANE_PAGE_SIZE));
		if (pageToken) url.searchParams.set("pageToken", pageToken);
		let response: Response;
		try {
			response = await fetchImpl(url.toString(), {
				method: "GET",
				headers: { Accept: "application/json", Authorization: `Bearer ${options.apiKey}` },
			});
		} catch {
			return null;
		}
		if (!response.ok) return null;
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return null;
		}
		if (!isRecord(payload)) return null;
		const models = Array.isArray(payload.models) ? payload.models : [];
		for (const entry of models) {
			if (!isRecord(entry)) continue;
			const record = entry as FireworksControlPlaneModel;
			if (toBoolean(record.supportsServerless) !== true) continue;
			if (typeof record.state === "string" && record.state !== "READY") continue;
			const wireName = typeof record.name === "string" ? record.name : "";
			if (!wireName) continue;
			const publicModelId = toFireworksPublicModelId(wireName);
			if (!publicModelId) continue;
			collected.set(
				publicModelId,
				mapFireworksControlPlaneModel(
					record,
					publicModelId,
					options.resolveReference(publicModelId),
					options.baseUrl,
				),
			);
		}
		const next = typeof payload.nextPageToken === "string" ? payload.nextPageToken : "";
		if (!next) break;
		pageToken = next;
	}
	return Array.from(collected.values());
}

function createModelsDevReferenceMap<TApi extends Api>(
	models: readonly ModelSpec<Api>[],
): Map<string, ModelSpec<TApi>> {
	const references = new Map<string, ModelSpec<TApi>>();
	for (const model of models) {
		const candidate = model as ModelSpec<TApi>;
		if (!isBareIdReferenceProvider(candidate.provider)) continue;
		const existing = references.get(candidate.id);
		if (!existing) {
			references.set(candidate.id, candidate);
			continue;
		}
		if ((candidate.contextWindow ?? 0) > (existing.contextWindow ?? 0)) {
			references.set(candidate.id, candidate);
			continue;
		}
		if (
			candidate.contextWindow === existing.contextWindow &&
			(candidate.maxTokens ?? 0) > (existing.maxTokens ?? 0)
		) {
			references.set(candidate.id, candidate);
		}
	}
	return references;
}

async function loadModelsDevReferences<TApi extends Api>(fetchImpl?: FetchImpl): Promise<Map<string, ModelSpec<TApi>>> {
	try {
		const payload = await fetchWellKnownModels(fetchImpl);
		return createModelsDevReferenceMap<TApi>(
			mapModelsDevToModels(payload as Record<string, unknown>, MODELS_DEV_PROVIDER_DESCRIPTORS),
		);
	} catch {
		return new Map<string, ModelSpec<TApi>>();
	}
}
export function fireworksModelManagerOptions(
	config?: FireworksModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.fireworks.ai/inference/v1";
	const bundledReferences = createReferenceResolver(() =>
		createBundledReferenceMap<"openai-completions">("fireworks"),
	);
	return {
		providerId: "fireworks",
		...(apiKey && {
			fetchDynamicModels: async () => {
				const modelsDevReferences = await loadModelsDevReferences<"openai-completions">(config?.fetch);
				return fetchFireworksServerlessModels({
					baseUrl,
					apiKey,
					resolveReference: publicModelId =>
						modelsDevReferences.get(publicModelId) ?? bundledReferences(publicModelId),
					fetch: config?.fetch,
				});
			},
		}),
	};
}

// Pricing and limits are the published Fire Pass router tariff
// (https://docs.fireworks.ai/firepass), not upstream-discoverable: dedicated
// `fpk_…` keys never authorize `/v1/models`, so this seed is the authoritative
// source. cacheRead is 0.1x input; cacheWrite stays 0 (not billed separately).
export const FIREPASS_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	{
		id: "glm-5.2-fast",
		name: "GLM 5.2 Fast (Fire Pass)",
		api: "openai-completions",
		provider: "firepass",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 2.1, output: 6.6, cacheRead: 0.21, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
	},
	{
		id: "kimi-k3-fast",
		name: "Kimi K3 Fast (Fire Pass)",
		api: "openai-completions",
		provider: "firepass",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 4.5, output: 22.5, cacheRead: 0.45, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
	},
];

export interface FirepassModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function firepassModelManagerOptions(
	_config?: FirepassModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return {
		providerId: "firepass",
	};
}

const CLINEPASS_MODELS_URL = `${CLINEPASS_API_BASE_URL}/ai/cline/recommended-models`;
const CLINEPASS_FALLBACK_CONTEXT_WINDOW = 128_000;
const CLINEPASS_FALLBACK_MAX_TOKENS = 8_192;

function buildClinePassFallbackModel(id: string): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "cline-pass",
		baseUrl: CLINEPASS_API_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: CLINEPASS_FALLBACK_CONTEXT_WINDOW,
		maxTokens: CLINEPASS_FALLBACK_MAX_TOKENS,
		compat: { supportsReasoningEffort: false },
	};
}

// Mirrors the official CLI's enrichment from OpenRouter's public catalog (Cline's gateway routes through it),
// keyed by full id and by slug. Consulted only for ids without a real upstream reference.
interface ClinePassLiveCatalogEntry {
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	cost?: ModelSpec<"openai-completions">["cost"];
	reasoning?: boolean;
	input?: ("text" | "image")[];
}

interface ClinePassLiveCatalog {
	byId: ReadonlyMap<string, ClinePassLiveCatalogEntry>;
	bySlug: ReadonlyMap<string, ClinePassLiveCatalogEntry>;
}

const CLINE_PASS_LIVE_CATALOG_URL = "https://openrouter.ai/api/v1/models";

/** Enrichment tier, never authoritative: any failure degrades to the bundled path. */
async function fetchClinePassLiveCatalog(fetchImpl: FetchImpl): Promise<ClinePassLiveCatalog | undefined> {
	try {
		const response = await withCatalogDiscoveryTimeout(5_000, signal =>
			fetchImpl(CLINE_PASS_LIVE_CATALOG_URL, { signal }),
		);
		if (!response.ok) return undefined;
		const payload: unknown = await response.json();
		if (!isRecord(payload) || !Array.isArray(payload.data)) return undefined;
		const byId = new Map<string, ClinePassLiveCatalogEntry>();
		const bySlug = new Map<string, ClinePassLiveCatalogEntry>();
		for (const raw of payload.data) {
			if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) continue;
			const pricing = isRecord(raw.pricing) ? raw.pricing : undefined;
			const topProvider = isRecord(raw.top_provider) ? raw.top_provider : undefined;
			const params = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : undefined;
			const modality = String(isRecord(raw.architecture) ? (raw.architecture.modality ?? "") : "");
			const contextWindow = toPositiveNumber(raw.context_length, 0);
			const maxTokens = toPositiveNumber(topProvider?.max_completion_tokens, 0);
			const entry: ClinePassLiveCatalogEntry = {
				...(typeof raw.name === "string" && raw.name ? { name: raw.name.replace(/^[^:]+:\s*/, "") } : {}),
				...(contextWindow > 0 ? { contextWindow } : {}),
				...(maxTokens > 0 ? { maxTokens } : {}),
				...(pricing
					? {
							cost: {
								input: parseFloat(String(pricing.prompt ?? "0")) * 1_000_000,
								output: parseFloat(String(pricing.completion ?? "0")) * 1_000_000,
								cacheRead: parseFloat(String(pricing.input_cache_read ?? "0")) * 1_000_000,
								cacheWrite: parseFloat(String(pricing.input_cache_write ?? "0")) * 1_000_000,
							},
						}
					: {}),
				...(params ? { reasoning: params.includes("reasoning") } : {}),
				...(modality
					? { input: modality.includes("image") ? (["text", "image"] as const) : (["text"] as const) }
					: {}),
			};
			byId.set(raw.id, entry);
			// Cline's `buildModelsNameMap` algorithm: roster ids are lab-less slugs
			// ("glm-5.2"), so the catalog is also keyed by its last id segment.
			const slug = raw.id.split("/").at(-1);
			if (slug) bySlug.set(slug, entry);
		}
		return byId.size > 0 ? { byId, bySlug } : undefined;
	} catch {
		return undefined;
	}
}

/** Zero legs mean "unpriced upstream", not "free" — pass models bill quota regardless. */
function hasClinePassBillableCost(cost: ModelSpec<"openai-completions">["cost"] | undefined): boolean {
	return cost !== undefined && (cost.input > 0 || cost.output > 0);
}

function buildCuratedClinePassModel(
	id: string,
	tier: "subscription" | "free",
): ModelSpec<"openai-completions"> | undefined {
	const metadata = getClinePassModelMetadata(id);
	if (!metadata || metadata.tier !== tier) return undefined;
	return {
		...buildClinePassFallbackModel(id),
		name: metadata.name,
		contextWindow: metadata.contextWindow,
		maxTokens: metadata.maxTokens,
		input: metadata.input,
		cost: metadata.cost,
		reasoning: metadata.reasoning,
		thinking: metadata.thinking,
		compat: {
			...(metadata.thinking === undefined ? { supportsReasoningEffort: false } : {}),
			...(tier === "free" ? { wireModelIdMode: "raw" as const } : {}),
		},
	};
}

// Subscription models bill plan quota, but carry the upstream list price so cost reads as API-equivalent
// spend (an all-$0 roster would show every model as free). Ids without an upstream reference keep zero.
function buildClinePassSubscriptionModel(
	id: string,
	references: ReadonlyMap<string, ModelSpec<"openai-completions">>,
	liveCatalog?: ClinePassLiveCatalog,
): ModelSpec<"openai-completions"> {
	const curated = buildCuratedClinePassModel(id, "subscription");
	if (curated) return curated;
	const base = references.get(id) ?? buildClinePassFallbackModel(id);
	const reference = resolveModelReference(id, getBundledModelReferenceIndex());
	// A reference pointing back at the ClinePass bundle means the last regen
	// knew nothing about the id and encoded fallback constants — treat as none.
	const upstream = reference && reference.provider !== "cline-pass" ? reference : undefined;
	// Same degeneracy on the bundle side: a bundled entry whose limits are the
	// fallback pair was written by a regen that had no upstream data for the id.
	const baseLimitsAreFallback =
		base.contextWindow === CLINEPASS_FALLBACK_CONTEXT_WINDOW && base.maxTokens === CLINEPASS_FALLBACK_MAX_TOKENS;
	if (upstream) {
		// Known to the bundle with real limits: overlay the list price only.
		// Otherwise full enrichment, like the free-tier path.
		return references.has(id) && !baseLimitsAreFallback
			? { ...base, cost: upstream.cost }
			: {
					...base,
					name: references.has(id) ? base.name : upstream.name,
					reasoning: upstream.reasoning,
					input: upstream.input,
					cost: upstream.cost,
					contextWindow: upstream.contextWindow,
					maxTokens: upstream.maxTokens,
					...(upstream.reasoning ? {} : { thinking: undefined }),
				};
	}
	const live = liveCatalog?.bySlug.get(id);
	if (!live) return base;
	return {
		...base,
		...(live.name ? { name: live.name } : {}),
		...(live.contextWindow ? { contextWindow: live.contextWindow } : {}),
		...(live.maxTokens ? { maxTokens: live.maxTokens } : {}),
		...(hasClinePassBillableCost(live.cost) ? { cost: live.cost } : {}),
		...(live.reasoning !== undefined ? { reasoning: live.reasoning } : {}),
		...(live.input ? { input: live.input } : {}),
		...(live.reasoning === false ? { thinking: undefined } : {}),
	};
}

// Free-tier entries are full OpenRouter-style ids billed at $0 outside the subscription quota. Limits and
// modalities resolve through the bundled upstream reference; compat and thinking are not inherited (they
// describe the reference's native host). The gateway already namespaces these ids, so they go out raw.
function buildClinePassFreeModel(id: string, liveCatalog?: ClinePassLiveCatalog): ModelSpec<"openai-completions"> {
	const curated = buildCuratedClinePassModel(id, "free");
	if (curated) return curated;
	const reference = resolveModelReference(id, getBundledModelReferenceIndex());
	const upstream = reference && reference.provider !== "cline-pass" ? reference : undefined;
	// Free ids are OpenRouter-native, so the live catalog matches by full id
	// before falling back to the slug — the official client's own lookup order.
	const live = liveCatalog?.byId.get(id) ?? liveCatalog?.bySlug.get(id.split("/").at(-1) ?? id);
	// References can carry their own free markers (e.g. OpenRouter-style
	// "Laguna S 2.1 (free)"); strip before applying our single tier suffix.
	const baseName = (upstream?.name ?? live?.name ?? id.split("/").at(-1) ?? id)
		.replace(/\s*\(free\)\s*$/i, "")
		.replace(/:free$/i, "")
		.trim();
	const fallback = buildClinePassFallbackModel(id);
	const reasoning = upstream?.reasoning ?? live?.reasoning ?? fallback.reasoning;
	return {
		...fallback,
		name: `${baseName || id} (free)`,
		reasoning,
		input: upstream?.input ?? live?.input ?? fallback.input,
		contextWindow: upstream?.contextWindow ?? live?.contextWindow ?? fallback.contextWindow,
		maxTokens: upstream?.maxTokens ?? live?.maxTokens ?? fallback.maxTokens,
		// A non-reasoning reference must not carry the Cline effort ladder.
		...(reasoning ? {} : { thinking: undefined }),
		compat: { supportsReasoningEffort: false, wireModelIdMode: "raw" },
	};
}

async function fetchClinePassModels(
	fetchImpl: FetchImpl,
	references: ReadonlyMap<string, ModelSpec<"openai-completions">>,
): Promise<ModelSpec<"openai-completions">[]> {
	// The roster is authoritative for ids; the live reference catalog is a pure
	// enrichment tier fetched alongside and tolerated away (offline → bundle).
	const [response, liveCatalog] = await Promise.all([
		withCatalogDiscoveryTimeout(5_000, signal =>
			fetchImpl(CLINEPASS_MODELS_URL, { signal, headers: clinePassClientHeaders() }),
		),
		fetchClinePassLiveCatalog(fetchImpl),
	]);
	if (!response.ok) {
		throw new Error(`Failed to fetch ClinePass models: HTTP ${response.status}`);
	}
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.clinePass)) {
		throw new Error("ClinePass model catalog response is missing clinePass");
	}

	const models = new Map<string, ModelSpec<"openai-completions">>();
	for (const entry of payload.clinePass) {
		if (!isRecord(entry) || typeof entry.id !== "string") {
			continue;
		}
		const wireId = entry.id.trim();
		if (!wireId.startsWith("cline-pass/")) {
			continue;
		}
		const id = toClinePassPublicModelId(wireId).trim();
		if (!id) {
			continue;
		}
		models.set(id, buildClinePassSubscriptionModel(id, references, liveCatalog));
	}
	if (models.size === 0) {
		throw new Error("ClinePass model catalog contains no valid model IDs");
	}

	// Free tier rides the same key and gateway at $0 outside the subscription
	// quota. Optional overlay: entries validate individually, a cline-pass/-shaped
	// entry belongs to the pass bucket, pass ids win any collision, and pass-first
	// insertion order keeps the registry's first-available fallback on a
	// subscription model.
	const freeEntries = Array.isArray(payload.free) ? payload.free : [];
	for (const entry of freeEntries) {
		if (!isRecord(entry) || typeof entry.id !== "string") {
			continue;
		}
		const id = entry.id.trim();
		if (!id || id.startsWith("cline-pass/") || models.has(id)) {
			continue;
		}
		models.set(id, buildClinePassFreeModel(id, liveCatalog));
	}
	return [...models.values()];
}

/**
 * The public recommended-models endpoint is the authoritative ClinePass roster: `clinePass` lists subscription
 * models, the optional `free` bucket adds $0 models usable with the same key. Metadata resolves in three tiers:
 * the Cline-published snapshot, then bundled upstream references / OpenRouter enrichment, then conservative
 * constants.
 */
export function clinePassModelManagerOptions(config?: ModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const references = new Map(
		(getBundledModels("cline-pass") as Model<"openai-completions">[]).map(model => [model.id, toModelSpec(model)]),
	);
	const fetchImpl = discoveryFetch(config?.fetch);
	return {
		providerId: "cline-pass",
		dynamicModelsAuthoritative: true,
		fetchDynamicModels: () => fetchClinePassModels(fetchImpl, references),
	};
}

export interface WaferModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

const WAFER_DEFAULT_BASE_URL = "https://pass.wafer.ai/v1";
const WAFER_MAX_TOKENS_CAP = 65536;

interface WaferRecord {
	context_length?: unknown;
	tier?: unknown;
	provider?: unknown;
	capabilities?: { vision?: unknown; reasoning?: unknown; tools?: unknown };
	pricing?: {
		input_cents_per_million?: unknown;
		output_cents_per_million?: unknown;
		cache_read_cents_per_million?: unknown;
	};
	display_name?: unknown;
}

function readWaferRecord(entry: OpenAICompatibleModelRecord): WaferRecord | undefined {
	const raw = (entry as { wafer?: unknown }).wafer;
	return raw && typeof raw === "object" ? (raw as WaferRecord) : undefined;
}

type WaferThinkingFormat = "zai" | "qwen";

export function resolveWaferServerlessThinkingFormat(
	modelId: string,
	upstreamProvider: unknown,
): WaferThinkingFormat | undefined {
	const upstream = typeof upstreamProvider === "string" ? upstreamProvider.trim().toLowerCase() : "";
	if (upstream) {
		if (
			upstream === "zai" ||
			upstream === "z.ai" ||
			upstream === "z-ai" ||
			upstream.includes("zhipu") ||
			upstream.includes("moonshot") ||
			upstream.includes("kimi")
		) {
			return "zai";
		}
		if (upstream.includes("qwen") || upstream.includes("alibaba") || upstream.includes("dashscope")) {
			return "qwen";
		}
		return undefined;
	}

	return isReasoningGlmModelId(modelId.toLowerCase()) || isKimiModelId(modelId) ? "zai" : undefined;
}

function mapWaferModel(
	providerId: "wafer-serverless",
	baseUrl: string,
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
): ModelSpec<"openai-completions"> {
	const wafer = readWaferRecord(entry);
	const capabilities = wafer?.capabilities ?? {};
	const reasoning = capabilities.reasoning === true;
	const vision = capabilities.vision === true;
	const supportsTools = toBoolean(capabilities.tools) === false ? false : undefined;
	const contextWindow = toPositiveNumber(
		wafer?.context_length,
		toPositiveNumber((entry as { max_model_len?: unknown }).max_model_len, defaults.contextWindow),
	);
	const maxTokens = contextWindow !== null ? Math.min(contextWindow, WAFER_MAX_TOKENS_CAP) : null;
	const pricing = wafer?.pricing ?? {};
	const cost = {
		input: (toPositiveNumber(pricing.input_cents_per_million, 0) * 125) / 10000,
		output: (toPositiveNumber(pricing.output_cents_per_million, 0) * 125) / 10000,
		cacheRead: (toPositiveNumber(pricing.cache_read_cents_per_million, 0) * 125) / 10000,
		cacheWrite: 0,
	};
	const name = toModelName(wafer?.display_name, defaults.name);
	const base: ModelSpec<"openai-completions"> = {
		...defaults,
		id: defaults.id,
		name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		reasoning,
		input: vision ? (["text", "image"] as const) : ["text"],
		cost,
		contextWindow,
		maxTokens,
		...(supportsTools === false ? { supportsTools } : {}),
	};
	if (reasoning) {
		const thinkingFormat = resolveWaferServerlessThinkingFormat(defaults.id, wafer?.provider);
		return {
			...base,
			compat: {
				...(thinkingFormat ? { thinkingFormat } : {}),
				reasoningContentField: "reasoning_content",
				supportsDeveloperRole: false,
			},
		};
	}
	return {
		...base,
		compat: { supportsDeveloperRole: false },
	};
}

export function waferServerlessModelManagerOptions(
	config?: WaferModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? WAFER_DEFAULT_BASE_URL;
	const providerId = "wafer-serverless" as const;
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: providerId,
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => mapWaferModel(providerId, baseUrl, entry, defaults),
					fetch: config?.fetch,
				}),
		}),
	};
}

export interface MistralModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function mistralModelManagerOptions(
	config?: MistralModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("mistral", "https://api.mistral.ai/v1", config);
}

export interface OpenCodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function normalizeOpenCodeBasePath(baseUrl: string | undefined, fallbackBasePath: string): string {
	const value = normalizeAnthropicBaseUrl(baseUrl, fallbackBasePath);
	return value.endsWith("/v1") ? value.slice(0, -3) : value;
}

function openCodeBaseUrlForApi(api: Api, basePath: string): string {
	return api === "anthropic-messages" ? basePath : `${basePath}/v1`;
}

// The gateway's GPT-6 Astra listing carries no transport metadata; it is served only at /responses (#12030).
// models.dev omits muse-spark-1.3-contributor-free entirely; the gateway serves it only at /responses (#10610).
const OPENCODE_ZEN_API_ID_OVERRIDES: Readonly<Record<string, Api>> = {
	"union-alpha": "anthropic-messages",
	"gpt-6-astra": "openai-responses",
	"muse-spark-1.3-contributor-free": "openai-responses",
	"minimax-m3": "openai-completions",
	"minimax-m3-free": "openai-completions",
};

// Rows cached before a capability correction keep stale thinking metadata until the authoritative TTL expires.
const OPENCODE_CACHE_MIGRATION_MODEL_IDS = ["glm-5.3-flash"] as const;
const OPENCODE_ZEN_CACHE_MIGRATION_MODEL_IDS = ["gemini-3.7-flash", "gemini-3.8-flash"] as const;

const OPENCODE_GO_API_ID_OVERRIDES: Readonly<Record<string, Api>> = {
	"union-alpha": "anthropic-messages",
	"deepseek-v4-flash": "openai-responses",
	"muse-spark-1.2": "openai-responses",
	"muse-spark-1.2-contributor": "openai-responses",
	"muse-spark-1.3": "openai-responses",
	"muse-spark-1.3-contributor": "openai-responses",
	"minimax-m2.7": "openai-completions",
	"minimax-m3": "openai-completions",
	"minimax-m3-free": "openai-completions",
	"qwen3.5-plus": "openai-completions",
	"qwen3.6-plus": "openai-completions",
};

const OPENCODE_VARIANT_SUFFIXES = ["-contributor", "-free"] as const;

function openCodeBaseModelId(id: string): string | null {
	for (const suffix of OPENCODE_VARIANT_SUFFIXES) {
		if (id.endsWith(suffix) && id.length > suffix.length) return id.slice(0, -suffix.length);
	}
	return null;
}

// Go's DeepSeek Flash lanes read images although their ids carry no vision token and
// live discovery seeds them text-only.
const OPENCODE_GO_IMAGE_INPUT_MODEL_IDS: Record<string, true> = {
	"deepseek-flash": true,
	"deepseek-v4.1-flash": true,
};

function withOpenCodeDeclaredInput<TApi extends Api>(spec: ModelSpec<TApi>): ModelSpec<TApi> {
	if (spec.provider !== "opencode-go" || OPENCODE_GO_IMAGE_INPUT_MODEL_IDS[spec.id] !== true) return spec;
	return spec.input.includes("image") ? spec : { ...spec, input: ["text", "image"] };
}

function openCodeModelManagerOptions(
	providerId: "opencode-go" | "opencode-zen",
	config?: OpenCodeModelManagerConfig,
): ModelManagerOptions<Api> {
	const apiKey = config?.apiKey;
	const defaultBaseUrl = getDefaultModelDiscoveryBaseUrl(providerId)!;
	const defaultBasePath = defaultBaseUrl.endsWith("/v1") ? defaultBaseUrl.slice(0, -3) : defaultBaseUrl;
	const basePath = normalizeOpenCodeBasePath(config?.baseUrl, defaultBasePath);
	const discoveryBaseUrl = openCodeBaseUrlForApi("openai-completions", basePath);
	const references = createBundledReferenceMap<Api>(providerId);

	const siblingReferences = createBundledReferenceMap<Api>(
		providerId === "opencode-go" ? "opencode-zen" : "opencode-go",
	);
	const apiOverrides = providerId === "opencode-go" ? OPENCODE_GO_API_ID_OVERRIDES : OPENCODE_ZEN_API_ID_OVERRIDES;

	const fallbackApi = (id: string, base: string | null): Api | undefined => {
		const hints = [
			siblingReferences.get(id)?.api,
			base ? references.get(base)?.api : undefined,
			base ? siblingReferences.get(base)?.api : undefined,
		];
		return hints.includes("openai-responses") ? "openai-responses" : undefined;
	};
	const resolveApi = (id: string, defaultApi: Api): Api => {
		const base = openCodeBaseModelId(id);
		return (
			apiOverrides[id] ??
			(base ? apiOverrides[base] : undefined) ??
			references.get(id)?.api ??
			fallbackApi(id, base) ??
			defaultApi
		);
	};
	return {
		providerId,
		cacheProviderId: resolveModelCacheProviderId(providerId, { apiKey, baseUrl: discoveryBaseUrl }),
		dynamicModelsAuthoritative: true,

		// Per-id route pins and capability migrations are cache identity (#8957, #9960).
		dropCachedModelIdsOnStaticMismatch: [
			...Object.keys(apiOverrides),
			...OPENCODE_CACHE_MIGRATION_MODEL_IDS,
			...(providerId === "opencode-zen" ? OPENCODE_ZEN_CACHE_MIGRATION_MODEL_IDS : []),
		],
		modelsDev: {
			fetch: () => fetchRevalidatedWellKnownModelsWithTimeout(config?.fetch),
			map: payload => {
				if (!isRecord(payload)) return [];
				return mapModelsDevToModels(payload, OPENCODE_MODELS_DEV_DESCRIPTORS)
					.filter(model => model.provider === providerId)
					.map(model => {
						const api = resolveApi(model.id, "openai-completions");
						return withOpenCodeDeclaredInput({ ...model, api, baseUrl: openCodeBaseUrlForApi(api, basePath) });
					});
			},
		},
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels<Api>({
					api: "openai-completions",
					provider: providerId,
					baseUrl: discoveryBaseUrl,
					apiKey,
					// The gateway requires x-opencode-session on background requests; attribute with the install id.
					headers: { "User-Agent": USER_AGENT, "x-opencode-session": getInstallId() },
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						const name = toModelName(entry.name, reference?.name ?? defaults.name);

						const api = resolveApi(defaults.id, defaults.api);
						const baseUrl = openCodeBaseUrlForApi(api, basePath);
						if (isMuseSparkModelId(defaults.id)) {
							return {
								...(reference ?? defaults),
								id: defaults.id,
								name,
								api,
								provider: providerId,
								baseUrl,
								reasoning: true,
								input: reference?.input ?? ["text", "image"],
								thinking: reference?.thinking ?? META_MUSE_SPARK_THINKING,
								contextWindow: toPositiveNumber(entry.context_length, reference?.contextWindow ?? 1_048_576),
								maxTokens: toPositiveNumber(entry.max_completion_tokens, reference?.maxTokens ?? 131_072),
							};
						}
						if (!reference) {
							return withOpenCodeDeclaredInput({ ...defaults, name, api, baseUrl });
						}
						return withOpenCodeDeclaredInput({
							...reference,
							id: defaults.id,
							name,
							api,
							baseUrl,
							contextWindow: toPositiveNumber(entry.context_length, reference.contextWindow),
							maxTokens: toPositiveNumber(entry.max_completion_tokens, reference.maxTokens),
						});
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export function opencodeZenModelManagerOptions(config?: OpenCodeModelManagerConfig): ModelManagerOptions<Api> {
	return openCodeModelManagerOptions("opencode-zen", config);
}

export function opencodeGoModelManagerOptions(config?: OpenCodeModelManagerConfig): ModelManagerOptions<Api> {
	return openCodeModelManagerOptions("opencode-go", config);
}

export interface OllamaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function ollamaModelManagerOptions(config?: OllamaModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeOllamaBaseUrl(config?.baseUrl);
	const nativeBaseUrl = toOllamaNativeBaseUrl(baseUrl);
	const references = createBundledReferenceMap<"openai-responses">("ollama" as Parameters<typeof getBundledModels>[0]);
	const resolveMetadata = createOllamaMetadataResolver(nativeBaseUrl, config?.fetch);
	return {
		providerId: "ollama",
		cacheProviderId: resolveModelCacheProviderId("ollama", { baseUrl }),
		fetchDynamicModels: async () => {
			const openAiCompatible = await fetchOpenAICompatibleModels({
				api: "openai-responses",
				provider: "ollama",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					if (!reference) {
						return {
							...defaults,
							name: toModelName(entry.name, defaults.name),
							contextWindow: OLLAMA_FALLBACK_CONTEXT_WINDOW,
							maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
						};
					}
					return mapWithBundledReference(entry, defaults, reference);
				},
				fetch: config?.fetch,
			});
			if (openAiCompatible && openAiCompatible.length > 0) {
				await Promise.all(
					openAiCompatible.map(async model => {
						const metadata = await resolveMetadata(model.id);
						model.contextWindow = metadata.contextWindow;
						if (metadata.reasoning !== undefined) {
							model.reasoning = metadata.reasoning;
							model.thinking = metadata.thinking;
						}
						if (metadata.input) {
							model.input = metadata.input;
						}
					}),
				);
				return openAiCompatible;
			}
			const nativeFallback = await fetchOllamaNativeModels(baseUrl, resolveMetadata, config?.fetch);
			if (nativeFallback && nativeFallback.length > 0) {
				return nativeFallback;
			}
			return openAiCompatible;
		},
	};
}

export interface OpenRouterModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function mapOpenRouterThinking(entry: OpenAICompatibleModelRecord): ThinkingConfig | undefined {
	const reasoning = entry.reasoning;
	if (!isRecord(reasoning)) return undefined;
	const supportedEfforts = reasoning.supported_efforts;
	if (!Array.isArray(supportedEfforts)) return undefined;
	const efforts = THINKING_EFFORTS.filter(effort => supportedEfforts.includes(effort));
	if (efforts.length === 0) return undefined;
	const defaultLevel =
		typeof reasoning.default_effort === "string"
			? THINKING_EFFORTS.find(effort => effort === reasoning.default_effort)
			: undefined;
	return {
		mode: "effort",
		efforts,
		...(defaultLevel !== undefined && efforts.includes(defaultLevel) ? { defaultLevel } : {}),
		// Mandatory-reasoning endpoints (stealth/ox-alpha) 400 on `reasoning:{enabled:false}`.
		...(reasoning.mandatory === true ? { requiresEffort: true } : {}),
	};
}

export function openrouterModelManagerOptions(
	config?: OpenRouterModelManagerConfig,
): ModelManagerOptions<"openrouter"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://openrouter.ai/api/v1";
	const references = createBundledReferenceMap<"openrouter">("openrouter");
	return {
		providerId: "openrouter",

		cacheProviderId: resolveModelCacheProviderId("openrouter"),
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openrouter",
				provider: "openrouter",
				baseUrl,
				apiKey,
				filterModel: (entry: OpenAICompatibleModelRecord) => {
					const params = entry.supported_parameters;
					return Array.isArray(params) && params.includes("tools");
				},
				mapModel: (
					entry: OpenAICompatibleModelRecord,
					defaults: ModelSpec<"openrouter">,
					_context: OpenAICompatibleModelMapperContext<"openrouter">,
				): ModelSpec<"openrouter"> => {
					const reference = references.get(defaults.id);
					const baseModel = mapWithBundledReference(entry, defaults, reference);
					const pricing = entry.pricing as Record<string, unknown> | undefined;
					const params = Array.isArray(entry.supported_parameters) ? (entry.supported_parameters as string[]) : [];
					const thinking = mapOpenRouterThinking(entry);
					const architecture = isRecord(entry.architecture) ? entry.architecture : undefined;
					// `modality` (`text+image->text`) also names output modalities; prefer the explicit input list.
					const input: ("text" | "image")[] = Array.isArray(architecture?.input_modalities)
						? toInputCapabilities(architecture.input_modalities)
						: String(architecture?.modality ?? "").includes("image")
							? ["text", "image"]
							: ["text"];
					const topProvider = entry.top_provider as Record<string, unknown> | undefined;

					const supportsToolChoice = params.includes("tool_choice");

					return {
						...baseModel,
						reasoning: params.includes("reasoning"),
						...(thinking !== undefined ? { thinking } : {}),
						input,
						cost: {
							input: parseFloat(String(pricing?.prompt ?? "0")) * 1_000_000,
							output: parseFloat(String(pricing?.completion ?? "0")) * 1_000_000,
							cacheRead: parseFloat(String(pricing?.input_cache_read ?? "0")) * 1_000_000,
							cacheWrite: parseFloat(String(pricing?.input_cache_write ?? "0")) * 1_000_000,
						},
						contextWindow:
							typeof entry.context_length === "number" ? entry.context_length : baseModel.contextWindow,
						maxTokens:
							typeof topProvider?.max_completion_tokens === "number"
								? topProvider.max_completion_tokens
								: baseModel.maxTokens,
						...(!supportsToolChoice && {
							compat: { ...(baseModel.compat ?? {}), supportsToolChoice: false },
						}),
					};
				},
				fetch: config?.fetch,
			}),
	};
}

const ZENMUX_OPENAI_BASE_URL = "https://zenmux.ai/api/v1";
const ZENMUX_ANTHROPIC_BASE_URL = "https://zenmux.ai/api/anthropic";

function normalizeZenMuxOpenAiBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return ZENMUX_OPENAI_BASE_URL;
	}
	const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
	if (normalized.endsWith("/api/anthropic")) {
		return normalized.replace("/api/anthropic", "/api/v1");
	}
	return normalized;
}

function toZenMuxAnthropicBaseUrl(openAiBaseUrl: string): string {
	try {
		const parsed = new URL(openAiBaseUrl);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = trimmedPath.endsWith("/api/v1")
			? `${trimmedPath.slice(0, -"/api/v1".length)}/api/anthropic`
			: "/api/anthropic";
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		return ZENMUX_ANTHROPIC_BASE_URL;
	}
}

function isZenMuxAnthropicModel(entry: OpenAICompatibleModelRecord, modelId: string): boolean {
	if (typeof entry.owned_by === "string" && entry.owned_by.toLowerCase() === "anthropic") {
		return true;
	}
	return modelId.toLowerCase().startsWith("anthropic/");
}

function getZenMuxPricingValue(pricings: Record<string, unknown> | undefined, key: string): number {
	const bucket = pricings?.[key];
	if (!Array.isArray(bucket)) {
		return 0;
	}
	for (const item of bucket) {
		if (!isRecord(item)) {
			continue;
		}
		const value = toNumber(item.value);
		if (value !== undefined) {
			return value;
		}
	}
	return 0;
}

function getZenMuxCacheWritePrice(pricings: Record<string, unknown> | undefined): number {
	const oneHour = getZenMuxPricingValue(pricings, "input_cache_write_1_h");
	if (oneHour > 0) {
		return oneHour;
	}
	const fiveMinute = getZenMuxPricingValue(pricings, "input_cache_write_5_min");
	if (fiveMinute > 0) {
		return fiveMinute;
	}
	return getZenMuxPricingValue(pricings, "input_cache_write");
}

export interface ZenMuxModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function zenmuxModelManagerOptions(config?: ZenMuxModelManagerConfig): ModelManagerOptions<Api> {
	const apiKey = config?.apiKey;
	const openAiBaseUrl = normalizeZenMuxOpenAiBaseUrl(config?.baseUrl);
	const anthropicBaseUrl = toZenMuxAnthropicBaseUrl(openAiBaseUrl);
	return {
		providerId: "zenmux",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels<Api>({
				api: "openai-completions",
				provider: "zenmux",
				baseUrl: openAiBaseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const pricings = isRecord(entry.pricings) ? entry.pricings : undefined;
					const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined;
					const isAnthropicModel = isZenMuxAnthropicModel(entry, defaults.id);
					return {
						...defaults,
						name: toModelName(entry.display_name, defaults.name),
						api: isAnthropicModel ? "anthropic-messages" : "openai-completions",
						baseUrl: isAnthropicModel ? anthropicBaseUrl : openAiBaseUrl,
						reasoning: capabilities?.reasoning === true || defaults.reasoning,
						input: toInputCapabilities(entry.input_modalities),
						cost: {
							input: getZenMuxPricingValue(pricings, "prompt"),
							output: getZenMuxPricingValue(pricings, "completion"),
							cacheRead: getZenMuxPricingValue(pricings, "input_cache_read"),
							cacheWrite: getZenMuxCacheWritePrice(pricings),
						},
						contextWindow: toPositiveNumber(entry.context_length, defaults.contextWindow),
						maxTokens: toPositiveNumber(entry.max_completion_tokens, defaults.maxTokens),
					};
				},
				fetch: config?.fetch,
			}),
	};
}

export interface KiloModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function kiloModelManagerOptions(config?: KiloModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.kilo.ai/api/gateway";
	return {
		providerId: "kilo",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "kilo",
				baseUrl,
				apiKey,
				fetch: config?.fetch,
			}),
	};
}

export interface AlibabaCodingPlanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function alibabaCodingPlanModelManagerOptions(
	config?: AlibabaCodingPlanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "alibaba-coding-plan",
		defaultBaseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
		config,
		mapModel: mapWithBundledReference,
	});
}

export { ALIBABA_TOKEN_PLAN_BASE_URL };

const ALIBABA_TOKEN_PLAN_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const ALIBABA_TOKEN_PLAN_COMPAT: OpenAICompat = {
	supportsDeveloperRole: false,
};
const ALIBABA_TOKEN_PLAN_REASONING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
};

// Qwen 3.8 Max/Flash steer depth through OpenAI `reasoning_effort` (enable_thinking on) and replay
// reasoning_content across preserved-thinking turns; Max Preview stays on the binary Qwen toggle.
const ALIBABA_TOKEN_PLAN_QWEN_EFFORT_COMPAT: OpenAICompat = {
	...ALIBABA_TOKEN_PLAN_COMPAT,
	supportsReasoningEffort: true,
	replayReasoningContent: true,
	whenThinking: {
		thinkingFormat: "openai",
		extraBody: { enable_thinking: true },
	},
};

export const ALIBABA_TOKEN_PLAN_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	{
		id: "qwen3.8-max-preview",
		name: "Qwen3.8 Max Preview",
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: ALIBABA_TOKEN_PLAN_COST,
		contextWindow: 983_616,
		maxTokens: 131_072,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.High, Effort.XHigh],
			requiresEffort: true,
		},
		compat: {
			...ALIBABA_TOKEN_PLAN_COMPAT,
			supportsReasoningEffort: true,
		},
	},
	{
		id: "qwen3.8-max",
		name: "Qwen3.8 Max",
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: ALIBABA_TOKEN_PLAN_COST,
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.XHigh],
			defaultLevel: Effort.XHigh,
		},
		compat: ALIBABA_TOKEN_PLAN_QWEN_EFFORT_COMPAT,
	},
	{
		id: "qwen3.8-flash",
		name: "Qwen3.8 Flash",
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: ALIBABA_TOKEN_PLAN_COST,
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		thinking: ALIBABA_TOKEN_PLAN_REASONING,
		compat: ALIBABA_TOKEN_PLAN_QWEN_EFFORT_COMPAT,
	},
	{
		id: "qwen3.7-max",
		name: "Qwen3.7 Max",
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: ALIBABA_TOKEN_PLAN_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		thinking: ALIBABA_TOKEN_PLAN_REASONING,
		compat: ALIBABA_TOKEN_PLAN_COMPAT,
	},
	{
		id: "qwen3.7-plus",
		name: "Qwen3.7 Plus",
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: ALIBABA_TOKEN_PLAN_COST,
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		thinking: ALIBABA_TOKEN_PLAN_REASONING,
		compat: ALIBABA_TOKEN_PLAN_COMPAT,
	},
	{
		id: "qwen3.6-flash",
		name: "Qwen3.6 Flash",
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: ALIBABA_TOKEN_PLAN_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		thinking: ALIBABA_TOKEN_PLAN_REASONING,
		compat: ALIBABA_TOKEN_PLAN_COMPAT,
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: ALIBABA_TOKEN_PLAN_COST,
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		thinking: {
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.Max],
		},
		compat: ALIBABA_TOKEN_PLAN_COMPAT,
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: ALIBABA_TOKEN_PLAN_COST,
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		thinking: {
			mode: "effort",
			efforts: [Effort.High, Effort.Max],
		},
		compat: ALIBABA_TOKEN_PLAN_COMPAT,
	},
];

export interface AlibabaTokenPlanModelLimits {
	contextWindow: number;
	maxTokens: number;
}

export const ALIBABA_TOKEN_PLAN_DISCOVERED_MODEL_LIMITS: Readonly<Record<string, AlibabaTokenPlanModelLimits>> = {
	"qwen3.6-plus": {
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	"qwen3.8-max": {
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	},
	"deepseek-v4-flash": {
		contextWindow: 1_000_000,
		maxTokens: 384_000,
	},
	"deepseek-v4-flash-0731": {
		contextWindow: 1_000_000,
		maxTokens: 384_000,
	},
	"deepseek-v4-pro-0813": {
		contextWindow: 1_000_000,
		maxTokens: 384_000,
	},
	"deepseek-v3.2": {
		contextWindow: 131_072,
		maxTokens: 65_536,
	},
	"glm-5.1": {
		contextWindow: 202_752,
		maxTokens: 128_000,
	},
	"glm-5": {
		contextWindow: 202_752,
		maxTokens: 16_384,
	},
	"kimi-k2.7-code": {
		contextWindow: 262_144,
		maxTokens: 262_144,
	},
	"kimi-k2.6": {
		contextWindow: 262_144,
		maxTokens: 262_144,
	},
	"kimi-k2.5": {
		contextWindow: 262_144,
		maxTokens: 98_304,
	},
	"minimax-m2.5": {
		contextWindow: 196_608,
		maxTokens: 32_768,
	},
};

const ALIBABA_TOKEN_PLAN_NON_CHAT_MODEL_PREFIXES = [
	"fun-asr",
	"happyhorse-",
	"qwen-audio-",
	"qwen-image-",
	"text-embedding-",
	"wan2.7-",
] as const;

function isAlibabaTokenPlanChatModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	return (
		normalized.length > 0 && !ALIBABA_TOKEN_PLAN_NON_CHAT_MODEL_PREFIXES.some(prefix => normalized.startsWith(prefix))
	);
}

export interface AlibabaTokenPlanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function alibabaTokenPlanModelManagerOptions(
	config?: AlibabaTokenPlanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const credential = config?.apiKey ? parseAlibabaTokenPlanCredential(config.apiKey) : undefined;
	const apiKey = credential?.token;

	const baseUrl = credential?.baseUrl ?? config?.baseUrl ?? ALIBABA_TOKEN_PLAN_BASE_URL;
	return {
		providerId: "alibaba-token-plan",
		dynamicModelsAuthoritative: true,
		staticModels: ALIBABA_TOKEN_PLAN_STATIC_MODELS,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "alibaba-token-plan",
					baseUrl,
					apiKey,
					filterModel: (_entry, model) => isAlibabaTokenPlanChatModelId(model.id),
					mapModel: (_entry, defaults) => {
						const reference = ALIBABA_TOKEN_PLAN_STATIC_MODELS.find(model => model.id === defaults.id);
						if (reference) {
							return {
								...reference,
								id: defaults.id,
								api: defaults.api,
								provider: defaults.provider,
								baseUrl: defaults.baseUrl,
							};
						}
						const normalizedId = defaults.id.trim().toLowerCase();
						const limits = ALIBABA_TOKEN_PLAN_DISCOVERED_MODEL_LIMITS[normalizedId];
						const enriched = limits
							? {
									...defaults,
									contextWindow: limits.contextWindow,
									maxTokens: limits.maxTokens,
								}
							: defaults;

						if (normalizedId.startsWith("deepseek-v4")) {
							return {
								...enriched,
								reasoning: true,
								thinking: {
									mode: "effort" as const,
									efforts: [Effort.High, Effort.Max],
								},
							};
						}
						return enriched;
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export interface VercelAiGatewayModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function normalizeVercelAiGatewayBaseUrls(rawBaseUrl: string | undefined): { baseUrl: string; catalogBaseUrl: string } {
	const baseUrl = (rawBaseUrl === undefined ? "https://ai-gateway.vercel.sh" : rawBaseUrl.trim()).replace(/\/+$/, "");
	const catalogBaseUrl = baseUrl === "" || baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

	return {
		baseUrl: baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl,
		catalogBaseUrl,
	};
}

export function vercelAiGatewayModelManagerOptions(
	config?: VercelAiGatewayModelManagerConfig,
): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	const { baseUrl, catalogBaseUrl } = normalizeVercelAiGatewayBaseUrls(config?.baseUrl);
	return {
		providerId: "vercel-ai-gateway",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "anthropic-messages",
				provider: "vercel-ai-gateway",
				baseUrl: catalogBaseUrl,
				apiKey,
				filterModel: (entry: OpenAICompatibleModelRecord) => {
					const tags = entry.tags;
					return Array.isArray(tags) && tags.includes("tool-use");
				},
				mapModel: (
					entry: OpenAICompatibleModelRecord,
					defaults: ModelSpec<"anthropic-messages">,
					_context: OpenAICompatibleModelMapperContext<"anthropic-messages">,
				): ModelSpec<"anthropic-messages"> => {
					const pricing = entry.pricing as Record<string, unknown> | undefined;
					const tags = Array.isArray(entry.tags) ? (entry.tags as string[]) : [];
					const reportedMaxTokens = typeof entry.max_tokens === "number" ? entry.max_tokens : defaults.maxTokens;
					const modelId = typeof entry.id === "string" ? entry.id : defaults.id;
					const maxTokens =
						modelId === "meta/muse-spark-1.2-contributor" && typeof reportedMaxTokens === "number"
							? Math.min(reportedMaxTokens, 131_072)
							: reportedMaxTokens;

					return {
						...defaults,
						baseUrl,
						reasoning: tags.includes("reasoning"),
						input: tags.includes("vision") ? ["text", "image"] : ["text"],
						cost: {
							input: (toNumber(pricing?.input) ?? 0) * 1_000_000,
							output: (toNumber(pricing?.output) ?? 0) * 1_000_000,
							cacheRead: (toNumber(pricing?.input_cache_read) ?? 0) * 1_000_000,
							cacheWrite: (toNumber(pricing?.input_cache_write) ?? 0) * 1_000_000,
						},
						contextWindow:
							typeof entry.context_window === "number" ? entry.context_window : defaults.contextWindow,
						maxTokens,
					};
				},
				fetch: config?.fetch,
			}),
	};
}

export interface KimiCodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function mapKimiThinking(entry: OpenAICompatibleModelRecord): ThinkingConfig | undefined {
	const raw = entry.think_efforts;
	if (!isRecord(raw) || raw.support !== true) return undefined;
	const validEfforts = raw.valid_efforts;
	if (!Array.isArray(validEfforts)) return undefined;
	const efforts = THINKING_EFFORTS.filter(effort => validEfforts.includes(effort));
	if (efforts.length === 0) return undefined;

	const thinking: ThinkingConfig = { mode: "effort", efforts };
	if (entry.supports_thinking_type === "only") {
		thinking.requiresEffort = true;
	}
	if (typeof raw.default_effort === "string") {
		const defaultLevel = THINKING_EFFORTS.find(effort => effort === raw.default_effort);
		if (defaultLevel !== undefined && efforts.includes(defaultLevel)) {
			thinking.defaultLevel = defaultLevel;
		}
	}
	return thinking;
}

function kimiSupportsReasoning(entry: OpenAICompatibleModelRecord, modelId: string): boolean {
	switch (entry.supports_thinking_type) {
		case "only":
		case "both":
			return true;
		case "no":
			return false;
		default:
			return entry.supports_reasoning === true || modelId.includes("thinking");
	}
}

function mapKimiApiFormat(protocol: unknown): OpenAICompat["kimiApiFormat"] {
	if (protocol === "anthropic") return "anthropic";
	if (protocol === null) return "openai";
	return undefined;
}

export const KIMI_CODE_K3_MAX_TOKENS = 131_072;
export const KIMI_CODE_FOR_CODING_MAX_TOKENS = 32_768;

export const KIMI_CODE_DEFAULT_MAX_TOKENS = 32_000;

export function kimiCodeMaxTokens(modelId: string, fallback?: number): number;
export function kimiCodeMaxTokens(modelId: string, fallback: number | null): number | null;
export function kimiCodeMaxTokens(
	modelId: string,
	fallback: number | null = KIMI_CODE_DEFAULT_MAX_TOKENS,
): number | null {
	const id = modelId.toLowerCase();
	if (id.startsWith("k3")) return KIMI_CODE_K3_MAX_TOKENS;
	if (id.startsWith("kimi-for-coding")) return KIMI_CODE_FOR_CODING_MAX_TOKENS;
	return fallback;
}

// /coding/v1/models carries no pricing; seed the public Moonshot list card only when every token price is 0.
// `kimi-for-coding` (K2.8 Preview) has no public SKU yet and uses the K2.7 Code line rate.
const KIMI_CODE_LIST_COSTS: Readonly<Record<string, ModelCost>> = {
	k3: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
	"k3-256k": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
	"kimi-for-coding": { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
	"kimi-for-coding-highspeed": { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
	"kimi-k2": { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
	"kimi-k2.5": { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
	"kimi-k2-turbo-preview": { input: 2.4, output: 10, cacheRead: 0.6, cacheWrite: 0 },
};

export function kimiCodeCost(modelId: string, cost: ModelCost): ModelCost {
	if (cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0) return cost;
	const listCost = KIMI_CODE_LIST_COSTS[modelId];
	return listCost ? { ...listCost } : cost;
}

export function kimiCodeModelManagerOptions(
	config?: KimiCodeModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.kimi.com/coding/v1";
	return {
		providerId: "kimi-code",
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "kimi-code",
					baseUrl,
					apiKey,
					headers: {
						"User-Agent": "KimiCLI/1.0",
						"X-Msh-Platform": "kimi_cli",
					},
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: ModelSpec<"openai-completions">,
						_context: OpenAICompatibleModelMapperContext<"openai-completions">,
					): ModelSpec<"openai-completions"> => {
						const id = defaults.id;
						const reasoning = kimiSupportsReasoning(entry, id);
						const thinking = reasoning ? mapKimiThinking(entry) : undefined;
						return {
							...defaults,
							name: typeof entry.display_name === "string" ? entry.display_name : defaults.name,
							reasoning,
							input: entry.supports_image_in === true || id.includes("k2.5") ? ["text", "image"] : ["text"],
							contextWindow: typeof entry.context_length === "number" ? entry.context_length : 262144,
							maxTokens: kimiCodeMaxTokens(id),
							cost: kimiCodeCost(id, defaults.cost),
							thinking,
							compat: {
								thinkingFormat: thinking ? "kimi" : "zai",
								kimiApiFormat: mapKimiApiFormat(entry.protocol),
								reasoningContentField: "reasoning_content",
								supportsDeveloperRole: false,
							},
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export interface LmStudioNativeModelMetadata {
	input: ("text" | "image")[];
	contextWindow?: number;
}

export interface LmStudioNativeModelMetadataOptions {
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

const LM_STUDIO_NATIVE_METADATA_TIMEOUT_MS = 250;

function toLmStudioNativeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	const normalized = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
	return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

function getLmStudioCapabilityNames(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap(item => (typeof item === "string" ? [item.toLowerCase()] : []));
}

function getLmStudioNativeInput(entry: Record<string, unknown>): ("text" | "image")[] {
	const modelType = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
	const capabilities = getLmStudioCapabilityNames(entry.capabilities);
	const supportsImage = modelType === "vlm" || capabilities.includes("vision") || capabilities.includes("image");
	return supportsImage ? ["text", "image"] : ["text"];
}

function getLmStudioNativeContextWindow(entry: Record<string, unknown>): number | undefined {
	const loadedContextWindow = entry.state === "loaded" ? toPositiveNumber(entry.loaded_context_length, null) : null;
	return (
		loadedContextWindow ??
		toPositiveNumber(entry.max_context_length, null) ??
		toPositiveNumber(entry.context_length, null) ??
		toPositiveNumber(entry.max_model_len, null) ??
		undefined
	);
}

export async function fetchLmStudioNativeModelMetadata(
	baseUrl: string,
	fetchImpl: FetchImpl = fetch,
	options?: LmStudioNativeModelMetadataOptions,
): Promise<Map<string, LmStudioNativeModelMetadata> | null> {
	const nativeBaseUrl = toLmStudioNativeBaseUrl(baseUrl);
	const fetchMetadata = async (signal?: AbortSignal): Promise<Map<string, LmStudioNativeModelMetadata> | null> => {
		try {
			const response = await fetchImpl(`${nativeBaseUrl}/api/v0/models`, {
				method: "GET",
				headers: { Accept: "application/json", ...(options?.headers ?? {}) },
				signal,
			});
			if (!response.ok) {
				return null;
			}
			const payload = await response.json();
			if (!isRecord(payload) || !Array.isArray(payload.data)) {
				return null;
			}
			const metadata = new Map<string, LmStudioNativeModelMetadata>();
			for (const entry of payload.data) {
				if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
					continue;
				}
				const contextWindow = getLmStudioNativeContextWindow(entry);
				metadata.set(entry.id, {
					input: getLmStudioNativeInput(entry),
					...(contextWindow === undefined ? {} : { contextWindow }),
				});
			}
			return metadata;
		} catch {
			return null;
		}
	};
	if (options?.signal !== undefined) {
		return fetchMetadata(options.signal);
	}
	return withCatalogDiscoveryTimeout(LM_STUDIO_NATIVE_METADATA_TIMEOUT_MS, fetchMetadata);
}

export interface LmStudioModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function lmStudioModelManagerOptions(
	config?: LmStudioModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? Bun.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";
	const references = createBundledReferenceMap<"openai-completions">("lm-studio" as any);
	return {
		providerId: "lm-studio",
		fetchDynamicModels: async () => {
			const nativeMetadataPromise = fetchLmStudioNativeModelMetadata(baseUrl, config?.fetch, {
				headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
			});
			const models = await fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "lm-studio",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					const model = mapWithBundledReference(entry, defaults, reference);
					return { ...model, reasoning: model.reasoning || reference === undefined };
				},
				fetch: config?.fetch,
			});
			if (!models) {
				return models;
			}
			const nativeMetadata = await nativeMetadataPromise;
			if (!nativeMetadata) {
				return models;
			}
			return models.map(model => {
				const metadata = nativeMetadata.get(model.id);
				if (!metadata) {
					return model;
				}
				return {
					...model,
					input: metadata.input,
					contextWindow: metadata.contextWindow ?? model.contextWindow,
				};
			});
		},
	};
}

export interface SyntheticModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

interface SyntheticModelRecord extends OpenAICompatibleModelRecord {
	supported_features?: unknown;
	input_modalities?: unknown;
	max_output_length?: unknown;
	reasoning_parameters?: unknown;
	pricing?: unknown;
}

const SYNTHETIC_WIRE_EFFORT_NONE = "none";

const SYNTHETIC_FALLBACK_MAX_TOKENS = 8192;

function toSyntheticStringList(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function resolveSyntheticThinking(wireEfforts: readonly string[]): ThinkingConfig | undefined {
	const efforts = THINKING_EFFORTS.filter(effort => wireEfforts.includes(effort));
	const wireHasNone = wireEfforts.includes(SYNTHETIC_WIRE_EFFORT_NONE);
	if (efforts.length === 0) {
		return wireHasNone
			? { mode: "effort", efforts: [Effort.Minimal], effortMap: { [Effort.Minimal]: SYNTHETIC_WIRE_EFFORT_NONE } }
			: undefined;
	}
	if (!wireHasNone || efforts.includes(Effort.Minimal)) {
		return { mode: "effort", efforts };
	}
	return {
		mode: "effort",
		efforts: [Effort.Minimal, ...efforts],
		effortMap: { [Effort.Minimal]: SYNTHETIC_WIRE_EFFORT_NONE },
	};
}

function toSyntheticCostPerMillion(value: unknown): number | undefined {
	const parsed = toNumber(typeof value === "string" ? value.trim().replace(/^\$/, "") : value);
	if (parsed === undefined || parsed < 0) {
		return undefined;
	}

	return Math.round(parsed * 1e12) / 1e6;
}

function resolveSyntheticCost(
	pricing: unknown,
	fallback: ModelSpec<"openai-completions">["cost"],
): ModelSpec<"openai-completions">["cost"] {
	if (!isRecord(pricing)) {
		return fallback;
	}
	const input = toSyntheticCostPerMillion(pricing.prompt);
	const output = toSyntheticCostPerMillion(pricing.completion);
	if (input === undefined || output === undefined) {
		return fallback;
	}
	return {
		input,
		output,
		cacheRead: toSyntheticCostPerMillion(pricing.input_cache_reads) ?? fallback.cacheRead,
		cacheWrite: toSyntheticCostPerMillion(pricing.input_cache_writes) ?? fallback.cacheWrite,
	};
}

export function syntheticModelManagerOptions(
	config?: SyntheticModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.synthetic.new/openai/v1";
	const references = new Map(
		(getBundledModels("synthetic") as Model<"openai-completions">[]).map(model => [model.id, toModelSpec(model)]),
	);
	return {
		providerId: "synthetic",
		dynamicModelsAuthoritative: true,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "synthetic",
					baseUrl,
					apiKey,
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: ModelSpec<"openai-completions">,
						_context: OpenAICompatibleModelMapperContext<"openai-completions">,
					): ModelSpec<"openai-completions"> => {
						const record = entry as SyntheticModelRecord;
						const reference = references.get(defaults.id);
						const referenceSupportsImage = reference?.input.includes("image") ?? false;
						const features = toSyntheticStringList(record.supported_features);
						const modalities = toSyntheticStringList(record.input_modalities);
						const wireEfforts = isRecord(record.reasoning_parameters)
							? toSyntheticStringList(record.reasoning_parameters.efforts)
							: [];
						const wireReasoning = features.includes("reasoning") || wireEfforts.length > 0;
						const thinking = resolveSyntheticThinking(wireEfforts);

						const namedTierCount =
							(thinking?.efforts.length ?? 0) - (wireEfforts.includes(SYNTHETIC_WIRE_EFFORT_NONE) ? 1 : 0);
						const reasoning =
							wireReasoning && namedTierCount > 0
								? true
								: wireEfforts.length > 0
									? false
									: entry.supports_reasoning === true || (reference?.reasoning ?? false);

						const base = reference ? { ...reference, id: defaults.id, baseUrl } : defaults;
						return {
							...base,
							name: toModelName(entry.name, reference?.name ?? defaults.name),
							reasoning,
							...(thinking ? { thinking } : {}),
							// Advertised `input_modalities` are authoritative: a wire that names its
							// modalities (even text-only) must not regrow `image` from the bundled
							// reference. Only when the wire omits them do `supports_vision` and the
							// reference get a vote.
							input:
								modalities.length > 0
									? modalities.includes("image")
										? ["text", "image"]
										: ["text"]
									: entry.supports_vision === true || referenceSupportsImage
										? ["text", "image"]
										: ["text"],

							...(record.supported_features !== undefined &&
							!features.includes("tools") &&
							reference?.supportsTools !== true
								? { supportsTools: false }
								: reference?.supportsTools === false
									? { supportsTools: false }
									: {}),
							cost: resolveSyntheticCost(record.pricing, base.cost),
							contextWindow: toPositiveNumber(
								entry.context_length,
								reference?.contextWindow ?? defaults.contextWindow,
							),
							maxTokens: toPositiveNumber(
								record.max_output_length ?? entry.max_tokens,
								reference?.maxTokens ?? SYNTHETIC_FALLBACK_MAX_TOKENS,
							),
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export interface VeniceModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function veniceModelManagerOptions(
	config?: VeniceModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "venice",
		defaultBaseUrl: "https://api.venice.ai/api/v1",
		config,
		mapModel: (entry, defaults, reference) => {
			const model = mapWithBundledReference(entry, defaults, reference);
			return {
				...model,
				maxTokens: clampKimiK27CodeMaxTokens(defaults.id, model.maxTokens),
				compat: { ...model.compat, supportsUsageInStreaming: false },
			};
		},
	});
}

export interface BasetenModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

// Earlier releases cached these without reasoning levels; bust the cache so upgrades pick up the ladders.
const BASETEN_CACHE_MIGRATION_MODEL_IDS = [
	"zai-org/GLM-5.3",
	"zai-org/GLM-5.3-Flash",
	"deepseek-ai/DeepSeek-V4-Flash-0731",
	"deepseek-ai/DeepSeek-V4.1-Flash",
	"deepseek-ai/DeepSeek-V4-Pro-0813",
];

export function basetenModelManagerOptions(
	config?: BasetenModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "baseten",
		defaultBaseUrl: "https://inference.baseten.co/v1",
		config,
		dynamicModelsAuthoritative: true,
		requireApiKey: true,
		dropCachedModelIdsOnStaticMismatch: BASETEN_CACHE_MIGRATION_MODEL_IDS,
		mapModel: (entry, defaults, reference) => {
			const raw = entry as Record<string, unknown> & {
				supported_features?: unknown;
				input_modalities?: unknown;
				pricing?: Record<string, unknown>;
			};
			const features = Array.isArray(raw.supported_features) ? raw.supported_features : [];
			const modalities = Array.isArray(raw.input_modalities) ? raw.input_modalities : [];

			// Only models with a verified Baseten reasoning policy; an unknown model may use another wire shape.
			const isSupportedBasetenReasoningModel =
				isKimiK3ModelId(defaults.id) ||
				isGlm52ReasoningEffortModelId(defaults.id) ||
				isGlm53ReasoningEffortModelId(defaults.id) ||
				defaults.id === "openai/gpt-oss-120b" ||
				/(?:^|\/)deepseek-v4/i.test(defaults.id);
			const reasoning =
				isSupportedBasetenReasoningModel &&
				(features.includes("reasoning") || features.includes("reasoning_effort"));
			const supportsTools = features.includes("tools") ? undefined : false;
			const vision = modalities.includes("image") || (reference?.input.includes("image") ?? false);

			const pricing = raw.pricing ?? {};
			const cost = {
				input: toPositiveNumber(pricing.prompt, 0) * 1_000_000,
				output: toPositiveNumber(pricing.completion, 0) * 1_000_000,
				cacheRead: toPositiveNumber(pricing.input_cache_read, 0) * 1_000_000,
				cacheWrite: 0,
			};

			const contextWindow = toPositiveNumber(raw.context_length, reference?.contextWindow ?? defaults.contextWindow);
			const maxTokens = toPositiveNumber(raw.max_completion_tokens, reference?.maxTokens ?? defaults.maxTokens);
			const baseModel = mapWithBundledReference(entry, defaults, reference);

			return {
				...baseModel,
				reasoning,
				input: vision ? ["text", "image"] : ["text"],
				cost,
				contextWindow,
				maxTokens,
				...(supportsTools === false ? { supportsTools } : {}),
			};
		},
	});
}

export interface TogetherModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function togetherModelManagerOptions(
	config?: TogetherModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("together", "https://api.together.xyz/v1", config);
}

export interface CoreWeaveModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function coreWeaveModelManagerOptions(
	config?: CoreWeaveModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("coreweave", "https://api.inference.wandb.ai/v1", {
		...config,
		headers: () => coreWeaveProjectHeaders(Bun.env),
	});
}

const META_MODEL_API_BASE_URL = getDefaultModelDiscoveryBaseUrl("meta")!;
const META_MUSE_SPARK_COST = { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 } as const;
// Contributor SKUs (`-contributor`): same model, discounted because prompts are used for training.
const META_MUSE_SPARK_CONTRIBUTOR_COST = { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 } as const;
const META_MUSE_SPARK_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
};
// Meta documents the `max` effort tier for Muse Spark 1.3 (standard) only; contributor tiers and other
// revisions stay on the 5-tier ladder.
const META_MUSE_SPARK_MAX_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
};
// Meta's /v1/models lists image generation and transcription SKUs beside the Muse Spark chat models.
const META_NON_CHAT_MODEL_PREFIXES = ["muse-image-", "muse-voice-"] as const;
const MUSE_SPARK_REVISION_PATTERN = /^muse-spark-(\d+)\.(\d+)(?:\.(\d+))?(-contributor)?$/;

type MuseSparkTier = "standard" | "contributor";

function museSparkSpec(
	revision: string,
	tier: MuseSparkTier,
	thinking: ThinkingConfig = META_MUSE_SPARK_THINKING,
): ModelSpec<"openai-responses"> {
	const contributor = tier === "contributor";
	return {
		id: contributor ? `muse-spark-${revision}-contributor` : `muse-spark-${revision}`,
		name: contributor ? `Muse Spark ${revision} (C)` : `Muse Spark ${revision}`,
		api: "openai-responses",
		provider: "meta",
		baseUrl: META_MODEL_API_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: contributor ? META_MUSE_SPARK_CONTRIBUTOR_COST : META_MUSE_SPARK_COST,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		thinking,
		compat: {
			supportsReasoningEffort: true,
			includeEncryptedReasoning: true,
		},
	};
}

/**
 * Muse Spark revisions served by Meta's first-party Responses API. Meta's `/v1/models` lists bare ids with no
 * capability metadata, so every revision must be seeded here or discovery yields a text-only, non-reasoning model
 * with an unknown context window.
 */
export const META_MUSE_STATIC_MODELS: readonly ModelSpec<"openai-responses">[] = [
	museSparkSpec("1.1", "standard"),
	museSparkSpec("1.2", "standard"),
	museSparkSpec("1.2", "contributor"),
	museSparkSpec("1.3", "standard", META_MUSE_SPARK_MAX_THINKING),
	museSparkSpec("1.3", "contributor"),
];

const META_MUSE_MODEL_BY_ID: Partial<Record<string, ModelSpec<"openai-responses">>> = Object.fromEntries(
	META_MUSE_STATIC_MODELS.map(model => [model.id, model]),
);

function isMetaChatModelId(id: string): boolean {
	return !META_NON_CHAT_MODEL_PREFIXES.some(prefix => id.startsWith(prefix));
}

/**
 * Lineage reference for a Muse Spark revision Meta ships before the seed lists it. Every revision so far kept the
 * 1M window, the effort ladder, and per-tier pricing, so a new one inherits them (with its own display name) instead
 * of surfacing as a text-only model with no limits. Only reviewed seed rows advertise `max`, so unknown revisions
 * take the 5-tier ladder.
 */
function museSparkLineageSpec(id: string): ModelSpec<"openai-responses"> | undefined {
	const match = MUSE_SPARK_REVISION_PATTERN.exec(id);
	if (!match) return undefined;
	const [, major, minor, patch, contributorSuffix] = match;
	const revision = patch === undefined || Number(patch) === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
	return { ...museSparkSpec(revision, contributorSuffix ? "contributor" : "standard"), id };
}

const BEDROCK_MANTLE_BASE_URL = "https://bedrock-mantle.{region}.api.aws/openai/v1";
const BEDROCK_MANTLE_GPT_5_X_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
};
const BEDROCK_MANTLE_GPT_5_6_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
};

export const BEDROCK_MANTLE_STATIC_MODELS: readonly ModelSpec<"openai-responses">[] = [
	{
		id: "openai.gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "bedrock-mantle",
		baseUrl: BEDROCK_MANTLE_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.75, output: 16.5, cacheRead: 0.275, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		thinking: BEDROCK_MANTLE_GPT_5_X_THINKING,
	},
	{
		id: "openai.gpt-5.5",
		name: "GPT-5.5",
		api: "openai-responses",
		provider: "bedrock-mantle",
		baseUrl: BEDROCK_MANTLE_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		thinking: BEDROCK_MANTLE_GPT_5_X_THINKING,
	},
	{
		id: "openai.gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		api: "openai-responses",
		provider: "bedrock-mantle",
		baseUrl: BEDROCK_MANTLE_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.22, output: 1.32, cacheRead: 0.022, cacheWrite: 0.275 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		thinking: BEDROCK_MANTLE_GPT_5_6_THINKING,
	},
	{
		id: "openai.gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "openai-responses",
		provider: "bedrock-mantle",
		baseUrl: BEDROCK_MANTLE_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 6.88 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		thinking: BEDROCK_MANTLE_GPT_5_6_THINKING,
	},
	{
		id: "openai.gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		api: "openai-responses",
		provider: "bedrock-mantle",
		baseUrl: BEDROCK_MANTLE_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.2, output: 13.2, cacheRead: 0.22, cacheWrite: 2.75 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		thinking: BEDROCK_MANTLE_GPT_5_6_THINKING,
	},
];

const BEDROCK_MANTLE_MODEL_BY_ID: Partial<Record<string, ModelSpec<"openai-responses">>> = Object.fromEntries(
	BEDROCK_MANTLE_STATIC_MODELS.map(model => [model.id, model]),
);

export function bedrockMantleModelManagerOptions(
	config: ModelManagerConfig = {},
): ModelManagerOptions<"openai-responses"> {
	const inferenceBaseUrl = config.baseUrl ?? BEDROCK_MANTLE_BASE_URL;
	const discoveryBaseUrl = inferenceBaseUrl.replace(/\/openai\/v1\/?$/, "/v1");
	return {
		providerId: "bedrock-mantle",
		staticModels: BEDROCK_MANTLE_STATIC_MODELS,

		dynamicModelsAuthoritative: true,
		...(config.authenticated && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-responses",
					provider: "bedrock-mantle",
					baseUrl: discoveryBaseUrl,
					fetch: config.fetch,
					mapModel: (entry, defaults) =>
						mapWithBundledReference(
							entry,
							{ ...defaults, baseUrl: BEDROCK_MANTLE_BASE_URL },
							BEDROCK_MANTLE_MODEL_BY_ID[defaults.id],
						),
				}),
		}),
	};
}

export interface MetaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function metaModelManagerOptions(config?: MetaModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	return {
		...createOpenAICompatibleModelManagerOptions({
			api: "openai-responses",
			providerId: "meta",
			defaultBaseUrl: META_MODEL_API_BASE_URL,
			config,
			requireApiKey: true,
			filterModel: (_entry, model) => isMetaChatModelId(model.id),
			// The seed backs ids the bundle has not been regenerated with yet; the lineage spec backs revisions the
			// seed has not been taught.
			mapModel: (entry, defaults, reference) =>
				mapWithBundledReference(
					entry,
					defaults,
					reference ?? META_MUSE_MODEL_BY_ID[defaults.id] ?? museSparkLineageSpec(defaults.id),
				),
		}),
		staticModels: META_MUSE_STATIC_MODELS,
	};
}

/** Muse Code shares Meta Model API's model capabilities and equivalent token pricing. */
export const MUSE_CODE_STATIC_MODELS: readonly ModelSpec<"openai-responses">[] = META_MUSE_STATIC_MODELS.map(model => ({
	...model,
	provider: "muse-code",
}));

const MUSE_CODE_MODEL_BY_ID: Partial<Record<string, ModelSpec<"openai-responses">>> = Object.fromEntries(
	MUSE_CODE_STATIC_MODELS.map(model => [model.id, model]),
);

function museCodeLineageSpec(id: string): ModelSpec<"openai-responses"> | undefined {
	const model = museSparkLineageSpec(id);
	return model ? { ...model, provider: "muse-code" } : undefined;
}

/**
 * Muse Code subscriptions use the same Model API wire contract as direct Meta API keys; the roster is scoped to the
 * subscription-minted key, so a successful fetch replaces the seed.
 */
export function museCodeModelManagerOptions(config?: MetaModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	return {
		...createOpenAICompatibleModelManagerOptions({
			api: "openai-responses",
			providerId: "muse-code",
			defaultBaseUrl: META_MODEL_API_BASE_URL,
			config,
			headers: { "x-api-version": "1.0.0" },
			dynamicModelsAuthoritative: true,
			requireApiKey: true,
			filterModel: (_entry, model) => isMetaChatModelId(model.id),
			mapModel: (entry, defaults, reference) =>
				mapWithBundledReference(
					entry,
					defaults,
					reference ?? MUSE_CODE_MODEL_BY_ID[defaults.id] ?? museCodeLineageSpec(defaults.id),
				),
			cacheProviderId: resolveModelCacheProviderId("muse-code", {
				apiKey: config?.apiKey,
				baseUrl: config?.baseUrl ?? META_MODEL_API_BASE_URL,
			}),
		}),
		staticModels: MUSE_CODE_STATIC_MODELS,
	};
}

export interface MoonshotModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

const MOONSHOT_KIMI_K3_COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 } as const;
const MOONSHOT_KIMI_K3_CONTEXT_WINDOW = 1_048_576;
const MOONSHOT_KIMI_K3_MAX_TOKENS = 131_072;
const MOONSHOT_KIMI_K3_THINKING: ThinkingConfig = { mode: "effort", efforts: [Effort.Max], requiresEffort: true };

export function moonshotModelManagerOptions(
	config?: MoonshotModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createOpenAICompatibleModelManagerOptions({
		api: "openai-completions",
		providerId: "moonshot",

		defaultBaseUrl: Bun.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1",
		config,
		requireApiKey: true,
		mapModel: (entry, defaults, reference) => {
			const model = mapWithBundledReference(entry, defaults, reference);
			const id = model.id.toLowerCase();

			if (!reference && isKimiK3ModelId(id)) {
				const isZeroCost = model.cost.input === 0 && model.cost.output === 0 && model.cost.cacheRead === 0;
				return {
					...model,
					reasoning: true,
					input: ["text", "image"],
					cost: isZeroCost ? { ...MOONSHOT_KIMI_K3_COST } : model.cost,
					contextWindow: model.contextWindow ?? MOONSHOT_KIMI_K3_CONTEXT_WINDOW,
					maxTokens: model.maxTokens ?? MOONSHOT_KIMI_K3_MAX_TOKENS,
					thinking: model.thinking ?? { ...MOONSHOT_KIMI_K3_THINKING },
				};
			}

			const isKimiK2Reasoning = id.includes("thinking") || /(^|\/)kimi-k2(?:\.\d+)?(?:[-:]|$)/.test(id);
			const isVision = id.includes("vision") || id.includes("vl") || /(^|\/)kimi-k2(?:\.\d+)?(?:[-:]|$)/.test(id);
			return {
				...model,
				reasoning: isKimiK2Reasoning || model.reasoning,
				input: isVision ? ["text", "image"] : model.input,
				thinking:
					model.thinking ??
					(isKimiK2Reasoning
						? { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] }
						: undefined),
			};
		},
	});
}

const SAKANA_DEFAULT_BASE_URL = "https://api.sakana.ai/v1";
const SAKANA_FREE_ROUTER_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const SAKANA_FUGU_ULTRA_COST = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } as const;
const SAKANA_FUGU_ULTRA_CONTEXT_WINDOW = 1_000_000;
const SAKANA_FUGU_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.High, Effort.Max],
};
const SAKANA_RESPONSES_COMPAT: ModelSpec<"openai-responses">["compat"] = {
	includeEncryptedReasoning: false,
	streamIdleTimeoutMs: 0,
};

function normalizeSakanaBaseUrl(baseUrl: string | undefined): string {
	const value = baseUrl?.trim() || SAKANA_DEFAULT_BASE_URL;
	const normalized = value.replace(/\/+$/, "");
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function isSakanaFuguModelId(modelId: string): boolean {
	return /^fugu(?:$|-)/i.test(modelId);
}

function createSakanaFuguStaticModel(
	id: string,
	name: string,
	cost: ModelSpec<"openai-responses">["cost"],
	contextWindow: number | null,
): ModelSpec<"openai-responses"> {
	return {
		id,
		name,
		api: "openai-responses",
		provider: "sakana",
		baseUrl: SAKANA_DEFAULT_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { ...cost },
		contextWindow,
		maxTokens: null,
		thinking: { ...SAKANA_FUGU_THINKING },
		compat: { ...SAKANA_RESPONSES_COMPAT },
	};
}

export const SAKANA_FUGU_STATIC_MODELS: readonly ModelSpec<"openai-responses">[] = [
	createSakanaFuguStaticModel("fugu", "Fugu", SAKANA_FREE_ROUTER_COST, SAKANA_FUGU_ULTRA_CONTEXT_WINDOW),
	createSakanaFuguStaticModel("fugu-ultra", "Fugu Ultra", SAKANA_FUGU_ULTRA_COST, SAKANA_FUGU_ULTRA_CONTEXT_WINDOW),
	createSakanaFuguStaticModel(
		"fugu-ultra-20260615",
		"Fugu Ultra 20260615",
		SAKANA_FUGU_ULTRA_COST,
		SAKANA_FUGU_ULTRA_CONTEXT_WINDOW,
	),
];

const SAKANA_FUGU_STATIC_MODEL_BY_ID = new Map(SAKANA_FUGU_STATIC_MODELS.map(model => [model.id, model] as const));
const SAKANA_FUGU_STATIC_MODEL_IDS = SAKANA_FUGU_STATIC_MODELS.map(model => model.id);

export interface SakanaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function sakanaModelManagerOptions(config?: SakanaModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeSakanaBaseUrl(config?.baseUrl ?? Bun.env.SAKANA_BASE_URL ?? Bun.env.FUGU_BASE_URL);
	const references = createBundledReferenceMap<"openai-responses">("sakana");
	return {
		providerId: "sakana",
		dynamicModelsAuthoritative: true,
		dropCachedModelIdsOnStaticMismatch: SAKANA_FUGU_STATIC_MODEL_IDS,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-responses",
					provider: "sakana",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id) ?? SAKANA_FUGU_STATIC_MODEL_BY_ID.get(defaults.id);
						const model = mapWithBundledReference(entry, defaults, reference);
						if (!reference && isSakanaFuguModelId(model.id)) {
							return {
								...model,
								reasoning: true,
								thinking: { ...SAKANA_FUGU_THINKING },
								compat: { ...SAKANA_RESPONSES_COMPAT },
							};
						}
						return model;
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

const AIAND_DEFAULT_BASE_URL = "https://api.aiand.com/v1";

const AIAND_EFFORT_BY_WIRE_VALUE: Record<string, Effort> = {
	minimal: Effort.Minimal,
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};

function normalizeAiandBaseUrl(baseUrl: string | undefined): string {
	const value = baseUrl?.trim() || AIAND_DEFAULT_BASE_URL;
	const normalized = value.replace(/\/+$/, "");
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function createAiandStaticModel(
	id: string,
	name: string,
	cost: { input: number; output: number },
	contextWindow: number,
	input: ModelSpec<"openai-completions">["input"],
): ModelSpec<"openai-completions"> {
	return {
		id,
		name,
		api: "openai-completions",
		provider: "aiand",
		baseUrl: AIAND_DEFAULT_BASE_URL,
		reasoning: true,
		input: [...input],
		cost: { input: cost.input, output: cost.output, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: null,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High], defaultLevel: Effort.Medium },
	};
}

export const AIAND_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	createAiandStaticModel("qwen/qwen3.6-27b", "Qwen3.6 27B", { input: 0, output: 0 }, 262_144, ["text"]),
	createAiandStaticModel(
		"deepseek-ai/deepseek-v4-flash",
		"DeepSeek V4 Flash",
		{ input: 0.15, output: 0.25 },
		1_000_000,
		["text"],
	),
	createAiandStaticModel("google/gemma-4-31b-it", "Gemma 4 31B IT", { input: 0.2, output: 0.5 }, 262_144, [
		"text",
		"image",
	]),
	createAiandStaticModel("openai/gpt-oss-120b", "GPT OSS 120B", { input: 0.15, output: 0.6 }, 131_072, ["text"]),
	createAiandStaticModel("deepseek-ai/deepseek-v4-pro", "DeepSeek V4 Pro", { input: 1, output: 2.5 }, 1_000_000, [
		"text",
	]),
	createAiandStaticModel("moonshotai/kimi-k2.7-code", "Kimi K2.7 Code", { input: 0.75, output: 3.5 }, 262_144, [
		"text",
		"image",
	]),
	createAiandStaticModel("moonshotai/kimi-k2.6", "Kimi K2.6", { input: 0.85, output: 3.5 }, 262_144, [
		"text",
		"image",
	]),
	createAiandStaticModel("zai-org/glm-5.2", "GLM 5.2", { input: 1, output: 4 }, 1_000_000, ["text"]),
	createAiandStaticModel("zai-org/glm-5.1", "GLM 5.1", { input: 1.4, output: 4.4 }, 202_752, ["text"]),
];

const AIAND_STATIC_MODEL_IDS = AIAND_STATIC_MODELS.map(model => model.id);

function mapAiandThinking(entry: OpenAICompatibleModelRecord): ThinkingConfig | undefined {
	const efforts = Array.isArray(entry.reasoning_efforts)
		? entry.reasoning_efforts.flatMap(value =>
				typeof value === "string" && AIAND_EFFORT_BY_WIRE_VALUE[value] ? [AIAND_EFFORT_BY_WIRE_VALUE[value]] : [],
			)
		: [];
	if (efforts.length === 0) {
		return undefined;
	}
	const defaultLevel =
		typeof entry.reasoning_effort_default === "string"
			? AIAND_EFFORT_BY_WIRE_VALUE[entry.reasoning_effort_default]
			: undefined;
	return {
		mode: "effort",
		efforts,
		...(defaultLevel && efforts.includes(defaultLevel) && { defaultLevel }),
	};
}

function mapAiandCost(entry: OpenAICompatibleModelRecord): ModelSpec<"openai-completions">["cost"] {
	if (typeof entry.currency === "string" && entry.currency !== "usd") {
		return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	}
	return {
		input: toPositiveNumber(entry.input_per_1m, 0),
		output: toPositiveNumber(entry.output_per_1m, 0),
		cacheRead: 0,
		cacheWrite: 0,
	};
}

function mapAiandModel(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
): ModelSpec<"openai-completions"> {
	const capabilities: unknown[] = Array.isArray(entry.capabilities) ? entry.capabilities : [];
	const reasoning = capabilities.includes("reasoning");
	const thinking = reasoning ? mapAiandThinking(entry) : undefined;
	const description =
		typeof entry.description === "string" && entry.description.trim() ? entry.description : undefined;
	return {
		...defaults,
		name: description ?? toModelName(entry.name, defaults.name),
		reasoning,
		input: capabilities.includes("vision") ? ["text", "image"] : ["text"],
		cost: mapAiandCost(entry),
		contextWindow: toPositiveNumber(entry.context_window, null),
		...(thinking && { thinking }),
	};
}

export interface AiandModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function aiandModelManagerOptions(config?: AiandModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeAiandBaseUrl(config?.baseUrl ?? Bun.env.AIAND_BASE_URL);
	return {
		providerId: "aiand",
		dynamicModelsAuthoritative: true,
		dropCachedModelIdsOnStaticMismatch: AIAND_STATIC_MODEL_IDS,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "aiand",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => mapAiandModel(entry, defaults),
					fetch: config?.fetch,
				}),
		}),
	};
}

const ABLITERATION_DEFAULT_BASE_URL = "https://api.abliteration.ai/v1";
// The gateway never returns encrypted reasoning items and streams long reasoning turns without keepalives.
const ABLITERATION_WIRE_COMPAT = { includeEncryptedReasoning: false, streamIdleTimeoutMs: 0 } as const;

function normalizeAbliterationBaseUrl(baseUrl: string | undefined): string {
	const normalized = (baseUrl?.trim() || ABLITERATION_DEFAULT_BASE_URL).replace(/\/+$/, "");
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function createAbliterationStaticModel(
	id: string,
	name: string,
	options: Pick<ModelSpec<"openai-responses">, "input" | "cost" | "contextWindow" | "maxTokens" | "thinking"> & {
		tokenizer?: ModelSpec<"openai-responses">["tokenizer"];
	},
): ModelSpec<"openai-responses"> {
	return {
		id,
		name,
		api: "openai-responses",
		provider: "abliteration",
		baseUrl: ABLITERATION_DEFAULT_BASE_URL,
		reasoning: true,
		...options,
		compat: { ...ABLITERATION_WIRE_COMPAT },
	};
}

/**
 * Documented abliteration.ai catalog (docs.abliteration.ai/models): abliterated GLM deployments behind opaque
 * ids. The large models run fewer modes than the ladder they accept and round aliases up (medium → high,
 * xhigh → max); the aliases stay selectable so a request is never clamped below its documented mode, and the
 * effort map sends the native mode on the wire.
 */
export const ABLITERATION_STATIC_MODELS: readonly ModelSpec<"openai-responses">[] = [
	createAbliterationStaticModel("abliterated-model", "Abliterated Model", {
		input: ["text", "image"],
		cost: { input: 3, output: 3, cacheRead: 0.3, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_134,
		// Distinct depths; Responses rejects `max`.
		thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
	}),
	// GLM 5.3: low/high/max, default max; disable-shaped controls run at hidden low, so effort is mandatory.
	createAbliterationStaticModel("abliterated-model-large-v2", "Abliterated Model Large V2", {
		input: ["text"],
		cost: { input: 5, output: 5, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 999_990,
		tokenizer: "glm5",
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			defaultLevel: Effort.Max,
			effortMap: { [Effort.Medium]: "high", [Effort.XHigh]: "max" },
			requiresEffort: true,
		},
	}),
	// GLM 5.2: high/max, default high.
	createAbliterationStaticModel("abliterated-model-large", "Abliterated Model Large", {
		input: ["text"],
		cost: { input: 5, output: 5, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 999_990,
		tokenizer: "glm5",
		thinking: {
			mode: "effort",
			efforts: [Effort.High, Effort.XHigh, Effort.Max],
			defaultLevel: Effort.High,
			effortMap: { [Effort.XHigh]: "max" },
		},
	}),
];

const ABLITERATION_STATIC_MODEL_BY_ID = new Map(ABLITERATION_STATIC_MODELS.map(model => [model.id, model] as const));
const ABLITERATION_STATIC_MODEL_IDS = ABLITERATION_STATIC_MODELS.map(model => model.id);

export interface AbliterationModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function abliterationModelManagerOptions(
	config?: AbliterationModelManagerConfig,
): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeAbliterationBaseUrl(config?.baseUrl);
	const references = createBundledReferenceMap<"openai-responses">("abliteration");
	return {
		providerId: "abliteration",
		dynamicModelsAuthoritative: true,
		dropCachedModelIdsOnStaticMismatch: ABLITERATION_STATIC_MODEL_IDS,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-responses",
					provider: "abliteration",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id) ?? ABLITERATION_STATIC_MODEL_BY_ID.get(defaults.id);
						const model = mapWithBundledReference(entry, defaults, reference);
						// Every abliteration.ai model reasons, and `/v1/models` carries no capability metadata.
						return {
							...model,
							reasoning: true,
							compat: { ...model.compat, ...ABLITERATION_WIRE_COMPAT },
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export interface QwenPortalModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function qwenPortalModelManagerOptions(
	config?: QwenPortalModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("qwen-portal", "https://portal.qwen.ai/v1", config);
}

export interface QianfanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function qianfanModelManagerOptions(
	config?: QianfanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("qianfan", "https://qianfan.baidubce.com/v2", config);
}

export interface CloudflareAiGatewayModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function cloudflareAiGatewayModelManagerOptions(
	config?: CloudflareAiGatewayModelManagerConfig,
): ModelManagerOptions<"anthropic-messages"> {
	return createSimpleAnthropicProviderOptions(
		"cloudflare-ai-gateway",
		"https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic",
		config,
	);
}

export type XiaomiTokenPlanRegion = "sgp" | "ams" | "cn";

export interface XiaomiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	providerId?: Provider;
	tokenPlanRegion?: XiaomiTokenPlanRegion;
}

const XIAOMI_TOKEN_PLAN_BASE_URLS: Record<XiaomiTokenPlanRegion, string> = {
	sgp: "https://token-plan-sgp.xiaomimimo.com/v1",
	ams: "https://token-plan-ams.xiaomimimo.com/v1",
	cn: "https://token-plan-cn.xiaomimimo.com/v1",
};

function xiaomiTokenPlanCnModel(id: string, name: string): ModelSpec<"openai-completions"> {
	return {
		id,
		name,
		api: "openai-completions",
		provider: "xiaomi-token-plan-cn",
		baseUrl: XIAOMI_TOKEN_PLAN_BASE_URLS.cn,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
	};
}

// The CN plan's credential-scoped roster returns bare ids, so these documented V2.6
// capabilities stay authoritative across bundling and online refreshes.
export const XIAOMI_TOKEN_PLAN_CN_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	xiaomiTokenPlanCnModel("mimo-v2.6-pro", "MiMo-V2.6-Pro"),
	xiaomiTokenPlanCnModel("mimo-v2.6-flash", "MiMo-V2.6-Flash"),
	xiaomiTokenPlanCnModel("mimo-v2.6-pro-ultraspeed", "MiMo-V2.6-Pro-Ultraspeed"),
];

const XIAOMI_TOKEN_PLAN_FALLBACK_BASE_URLS = [
	XIAOMI_TOKEN_PLAN_BASE_URLS.sgp,
	XIAOMI_TOKEN_PLAN_BASE_URLS.ams,
	XIAOMI_TOKEN_PLAN_BASE_URLS.cn,
];

export function xiaomiModelManagerOptions(
	config?: XiaomiModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const providerId = config?.providerId ?? "xiaomi";
	const tokenPlanBaseUrls = config?.tokenPlanRegion
		? [XIAOMI_TOKEN_PLAN_BASE_URLS[config.tokenPlanRegion]]
		: XIAOMI_TOKEN_PLAN_FALLBACK_BASE_URLS;
	const XIAOMI_STANDARD_BASE_URL = "https://api.xiaomimimo.com/v1";
	const isTokenPlanProvider = config?.tokenPlanRegion !== undefined || providerId.startsWith("xiaomi-token-plan-");
	const isTokenPlanKey = isTokenPlanProvider || apiKey?.startsWith("tp-");

	const baseUrl = isTokenPlanKey ? tokenPlanBaseUrls[0] : (config?.baseUrl ?? XIAOMI_STANDARD_BASE_URL);
	const references = createBundledReferenceMap<"openai-completions">("xiaomi");
	if (providerId === "xiaomi-token-plan-cn") {
		for (const seed of XIAOMI_TOKEN_PLAN_CN_STATIC_MODELS) references.set(seed.id, seed);
	}
	const fetchModels = (url: string) =>
		fetchOpenAICompatibleModels({
			api: "openai-completions",
			provider: providerId,
			baseUrl: url,
			apiKey,
			filterModel: (_entry, model) => !model.id.includes("-tts") && !model.id.includes("-asr"),
			mapModel: (entry, defaults) => {
				const reference = references.get(defaults.id);
				const model = mapWithBundledReference(entry, defaults, reference);
				return {
					...model,
					api: "openai-completions",
					provider: providerId,
					baseUrl: defaults.baseUrl,
					name: toModelName(entry.display_name, model.name),
				};
			},
			fetch: config?.fetch,
		});
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: async () => {
				if (!isTokenPlanKey) {
					return fetchModels(baseUrl);
				}
				for (const url of tokenPlanBaseUrls) {
					const result = await fetchModels(url);
					if (result) return result;
				}
				return null;
			},
		}),
	};
}

export interface LiteLLMModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export interface FetchLiteLLMRichModelsOptions<TApi extends Api> {
	api: TApi;
	provider: Provider;
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	fetch?: FetchImpl;
	signal?: AbortSignal;
	timeoutMs?: number;
	referenceResolver?: (modelId: string) => ModelSpec<TApi> | undefined;
	resolveApi?: (entry: Record<string, unknown>, modelId: string) => TApi;
}

type LiteLLMRichModelEntry = Record<string, unknown>;
type LiteLLMApiRoute = "openai" | "other" | "unknown";
type LiteLLMRichEndpointModel<TApi extends Api> = {
	model: ModelSpec<TApi>;
	apiRoute: LiteLLMApiRoute;
	supportsVision: unknown;
	supportsReasoning: unknown;
	hasContextWindow: boolean;
	hasMaxTokens: boolean;
	hasToolMetadata: boolean;
	hasSupportedOpenAIParams: boolean;
	hasCost: boolean;
	reportedCost: Partial<ModelSpec<Api>["cost"]>;
};
type LiteLLMRichEndpointFailure = {
	endpoint: string;
	reason: "http-status" | "invalid-json" | "network-error";
	status?: number;
	error?: unknown;
};
type LiteLLMRichEndpointResult<TApi extends Api> =
	| {
			models: LiteLLMRichEndpointModel<TApi>[];
			excludedModelIds: ReadonlySet<string>;
			incompleteVisionMetadata: boolean;
	  }
	| { failure: LiteLLMRichEndpointFailure };

const LITELLM_RICH_ENDPOINTS = ["/model_group/info", "/v2/model/info", "/model/info", "/v1/model/info"] as const;
const LITELLM_TASK_SPECIFIC_MODES: Record<string, true> = {
	audio_speech: true,
	audio_transcription: true,
	batch: true,
	embedding: true,
	guardrail: true,
	image_edit: true,
	image_generation: true,
	moderation: true,
	ocr: true,
	rerank: true,
	search: true,
	vector_store: true,
	video_generation: true,
};
export const OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW = 128_000;
export const OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS = 32_768;
const UNKNOWN_PROXY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const warnedLiteLLMMetadataBases = new Set<string>();
const LITELLM_UNUSABLE_SENTINEL_IDS: Record<string, true> = {
	"all-team-models": true,
	"all-proxy-models": true,
	"no-default-models": true,
};
function warnLiteLLMMetadataFallback(managementBaseUrl: string, failure: LiteLLMRichEndpointFailure): void {
	if (warnedLiteLLMMetadataBases.has(managementBaseUrl)) {
		return;
	}
	warnedLiteLLMMetadataBases.add(managementBaseUrl);
	logger.warn("LiteLLM rich model metadata unavailable; falling back to /v1/models", {
		endpoint: `${managementBaseUrl}${failure.endpoint}`,
		status: failure.status ?? "unavailable",
		reason: failure.reason,
		...(failure.status === 403
			? { requiredPermission: "Grant this LiteLLM key access to the model metadata endpoints" }
			: {}),
		...(failure.error !== undefined ? { error: failure.error } : {}),
	});
}

export function isSelectableLiteLLMModelMode(mode: unknown): boolean {
	return typeof mode !== "string" || LITELLM_TASK_SPECIFIC_MODES[mode] !== true;
}

export function normalizeLiteLLMManagementBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/g, "");
	if (!trimmed) {
		return "";
	}
	try {
		const parsed = new URL(trimmed);
		const path = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = path.endsWith("/v1") ? path.slice(0, -3) || "/" : path || "/";
		const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
		return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	} catch {
		return trimmed.replace(/\/v1$/, "");
	}
}

function normalizeLiteLLMRuntimeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

const LITELLM_RESELLER_USAGE_SUFFIX = /\s+\(\d+(?:\.\d+)?[x×] usage\)$/i;

function stripLiteLLMResellerUsageSuffix(name: string): string {
	const cleaned = name.replace(LITELLM_RESELLER_USAGE_SUFFIX, "").trim();
	return cleaned.length > 0 ? cleaned : name;
}

function toLiteLLMDisplayName(modelName: string | undefined, referenceName: string | undefined, id: string): string {
	const cleanedModelName = modelName ? stripLiteLLMResellerUsageSuffix(modelName) : undefined;
	if (cleanedModelName && cleanedModelName !== id) {
		return cleanedModelName;
	}
	return referenceName ? stripLiteLLMResellerUsageSuffix(referenceName) : id;
}

function mapLiteLLMOpenAICompatibleModel(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<Api>,
	reference: ModelSpec<Api> | undefined,
): ModelSpec<Api> | null {
	if (!isSelectableLiteLLMModelMode(entry.mode)) {
		return null;
	}
	const model = mapWithBundledReference(entry, defaults, reference);
	return {
		...model,
		api: resolveLiteLLMApi(undefined, model.id),
		name: stripLiteLLMResellerUsageSuffix(model.name),
	};
}

function toNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function extractLiteLLMRichEntries(payload: unknown): LiteLLMRichModelEntry[] | null {
	if (Array.isArray(payload)) {
		return payload.flatMap(entry => (isRecord(entry) ? [entry] : []));
	}
	if (!isRecord(payload)) {
		return null;
	}
	for (const candidate of [payload.data, payload.models, payload.result, payload.items]) {
		if (candidate === undefined) {
			continue;
		}
		const entries = extractLiteLLMRichEntries(candidate);
		if (entries !== null) {
			return entries;
		}
	}
	return null;
}

function getLiteLLMModelInfo(entry: LiteLLMRichModelEntry): LiteLLMRichModelEntry | undefined {
	return isRecord(entry.model_info) ? entry.model_info : undefined;
}

function getLiteLLMParams(entry: LiteLLMRichModelEntry): LiteLLMRichModelEntry | undefined {
	return isRecord(entry.litellm_params) ? entry.litellm_params : undefined;
}

function getLiteLLMMetadataValue(entry: LiteLLMRichModelEntry, key: string): unknown {
	return entry[key] ?? getLiteLLMModelInfo(entry)?.[key];
}

function getLiteLLMPerMillionCost(entry: LiteLLMRichModelEntry, key: string): number | undefined {
	const perToken = toNumber(getLiteLLMMetadataValue(entry, key));
	return perToken !== undefined && perToken > 0 ? perToken * 1_000_000 : undefined;
}

function getLiteLLMReportedCost(entry: LiteLLMRichModelEntry): Partial<ModelSpec<Api>["cost"]> {
	const input = getLiteLLMPerMillionCost(entry, "input_cost_per_token");
	const output = getLiteLLMPerMillionCost(entry, "output_cost_per_token");
	const cacheRead = getLiteLLMPerMillionCost(entry, "cache_read_input_token_cost");
	const cacheWrite = getLiteLLMPerMillionCost(entry, "cache_creation_input_token_cost");
	return {
		...(input !== undefined ? { input } : {}),
		...(output !== undefined ? { output } : {}),
		...(cacheRead !== undefined ? { cacheRead } : {}),
		...(cacheWrite !== undefined ? { cacheWrite } : {}),
	};
}

function getLiteLLMCost(entry: LiteLLMRichModelEntry): ModelSpec<Api>["cost"] | undefined {
	const cost = getLiteLLMReportedCost(entry);
	if (cost.input === undefined && cost.output === undefined) {
		return undefined;
	}
	return {
		input: cost.input ?? 0,
		output: cost.output ?? 0,
		cacheRead: cost.cacheRead ?? 0,
		cacheWrite: cost.cacheWrite ?? 0,
	};
}

function getLiteLLMRichModelId(entry: LiteLLMRichModelEntry): string | undefined {
	return (
		toNonEmptyString(entry.model_group) ??
		toNonEmptyString(entry.model_name) ??
		toNonEmptyString(entry.id) ??
		toNonEmptyString(getLiteLLMParams(entry)?.model)
	);
}

function getSupportedOpenAIParams(entry: LiteLLMRichModelEntry): string[] | undefined {
	const value = getLiteLLMMetadataValue(entry, "supported_openai_params");
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.flatMap(item => (typeof item === "string" ? [item] : []));
}

function getLiteLLMProviders(entry: LiteLLMRichModelEntry): string[] | undefined {
	if (!Array.isArray(entry.providers)) {
		return undefined;
	}
	const providers = entry.providers.flatMap(provider => {
		const normalized = toNonEmptyString(provider)?.toLowerCase();
		return normalized ? [normalized] : [];
	});
	return providers.length > 0 ? providers : undefined;
}

function classifyLiteLLMApiRoute(entry: LiteLLMRichModelEntry | undefined, id: string): LiteLLMApiRoute {
	if (entry) {
		const providers = getLiteLLMProviders(entry);
		if (providers) {
			return providers.every(provider => provider === "openai") ? "openai" : "other";
		}

		const params = getLiteLLMParams(entry);
		const configuredProvider = toNonEmptyString(params?.custom_llm_provider)?.toLowerCase();
		if (configuredProvider) {
			return configuredProvider === "openai" ? "openai" : "other";
		}

		const backendModel = toNonEmptyString(params?.model);
		const backendSeparator = backendModel?.indexOf("/") ?? -1;
		if (backendModel && backendSeparator > 0) {
			return backendModel.slice(0, backendSeparator).toLowerCase() === "openai" ? "openai" : "other";
		}

		const baseModel = toNonEmptyString(getLiteLLMMetadataValue(entry, "base_model"));
		const baseSeparator = baseModel?.indexOf("/") ?? -1;
		if (baseModel && baseSeparator > 0) {
			return baseModel.slice(0, baseSeparator).toLowerCase() === "openai" ? "openai" : "other";
		}
	}

	const modelId = id.toLowerCase().startsWith("openai/") ? id.slice("openai/".length) : id;
	return isLikelyOpenAIResponsesModelId(modelId) ? "openai" : "unknown";
}

export function resolveLiteLLMApi(
	entry: Record<string, unknown> | undefined,
	id: string,
	fallbackApi: Api = "openai-completions",
): Api {
	return classifyLiteLLMApiRoute(entry, id) === "openai" ? "openai-responses" : fallbackApi;
}

function isLiteLLMUnusableSentinelPlaceholder(entry: LiteLLMRichModelEntry): boolean {
	const modelGroup = toNonEmptyString(entry.model_group);
	const id = toNonEmptyString(entry.id);
	if (
		(modelGroup === undefined || LITELLM_UNUSABLE_SENTINEL_IDS[modelGroup] !== true) &&
		(id === undefined || LITELLM_UNUSABLE_SENTINEL_IDS[id] !== true)
	) {
		return false;
	}
	const providers = entry.providers;
	if (providers !== undefined && (!Array.isArray(providers) || providers.length > 0)) {
		return false;
	}
	const modelName = toNonEmptyString(entry.model_name);
	if (modelName && LITELLM_UNUSABLE_SENTINEL_IDS[modelName] !== true) {
		return false;
	}
	if (id && LITELLM_UNUSABLE_SENTINEL_IDS[id] !== true) {
		return false;
	}
	const backendModel = toNonEmptyString(getLiteLLMParams(entry)?.model);
	if (backendModel && LITELLM_UNUSABLE_SENTINEL_IDS[backendModel] !== true) {
		return false;
	}
	if (
		toPositiveNumber(getLiteLLMMetadataValue(entry, "max_input_tokens"), null) !== null ||
		toPositiveNumber(getLiteLLMMetadataValue(entry, "max_output_tokens"), null) !== null
	) {
		return false;
	}
	if (
		getLiteLLMMetadataValue(entry, "supports_vision") === true ||
		getLiteLLMMetadataValue(entry, "supports_reasoning") === true ||
		getLiteLLMMetadataValue(entry, "supports_function_calling") === true ||
		getLiteLLMMetadataValue(entry, "supports_tools") === true
	) {
		return false;
	}
	const supportedOpenAIParams = getSupportedOpenAIParams(entry);
	if (supportedOpenAIParams && supportedOpenAIParams.length > 0) {
		return false;
	}
	return true;
}

function mapLiteLLMRichEntry<TApi extends Api>(
	entry: LiteLLMRichModelEntry,
	options: FetchLiteLLMRichModelsOptions<TApi>,
	runtimeBaseUrl: string,
): ModelSpec<TApi> | null {
	if (
		!isSelectableLiteLLMModelMode(getLiteLLMMetadataValue(entry, "mode")) ||
		isLiteLLMUnusableSentinelPlaceholder(entry)
	) {
		return null;
	}
	const id = getLiteLLMRichModelId(entry);
	if (!id) {
		return null;
	}
	const reference = options.referenceResolver?.(id);
	const modelName = toNonEmptyString(entry.model_name);
	const contextWindow = toPositiveNumber(
		getLiteLLMMetadataValue(entry, "max_input_tokens"),
		reference?.contextWindow ?? OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW,
	);
	const maxTokens = toPositiveNumber(
		getLiteLLMMetadataValue(entry, "max_output_tokens"),
		reference?.maxTokens ?? Math.min(contextWindow, OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS),
	);
	const supportsVision = getLiteLLMMetadataValue(entry, "supports_vision");
	const supportsReasoning = getLiteLLMMetadataValue(entry, "supports_reasoning");
	const supportedOpenAIParams = getSupportedOpenAIParams(entry);
	const supportsFunctionCalling = getLiteLLMMetadataValue(entry, "supports_function_calling");
	const supportsTools =
		supportsFunctionCalling === true
			? true
			: supportsFunctionCalling === false
				? false
				: supportedOpenAIParams !== undefined
					? supportedOpenAIParams.some(param =>
							["tools", "tool_choice", "functions", "function_call"].includes(param),
						)
					: reference?.supportsTools;
	// Only provider-independent effort hints may cross from the bundled reference:
	// its resolved transport compat (wire id mode, tool schema flavor, thinking
	// format) belongs to another provider and would rewrite requests to ids this
	// proxy never advertised (#9938).
	const referenceCompat = reference?.compat as OpenAICompat | undefined;
	const compat: OpenAICompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		...(supportedOpenAIParams !== undefined
			? { supportsReasoningEffort: supportedOpenAIParams.includes("reasoning_effort") }
			: referenceCompat?.supportsReasoningEffort !== undefined
				? { supportsReasoningEffort: referenceCompat.supportsReasoningEffort }
				: {}),
		...(referenceCompat?.reasoningEffortMap ? { reasoningEffortMap: referenceCompat.reasoningEffortMap } : {}),
		...(referenceCompat?.omitReasoningEffort !== undefined
			? { omitReasoningEffort: referenceCompat.omitReasoningEffort }
			: {}),
		// The deployment is authoritative about its own groups: a declared
		// `supports_vision` outranks the id-keyed DeepSeek text-only guard (#11982).
		...(supportsVision === true ? { stripImageInput: false } : {}),
	};
	return {
		id,
		name: toLiteLLMDisplayName(modelName, reference?.name, id),
		api: options.resolveApi?.(entry, id) ?? options.api,
		provider: options.provider,
		baseUrl: runtimeBaseUrl,
		contextWindow,
		maxTokens,
		input:
			supportsVision === true
				? ["text", "image"]
				: supportsVision === false
					? ["text"]
					: (reference?.input ?? ["text"]),
		reasoning: typeof supportsReasoning === "boolean" ? supportsReasoning : (reference?.reasoning ?? true),
		thinking: reference?.thinking,
		cost: getLiteLLMCost(entry) ?? reference?.cost ?? UNKNOWN_PROXY_COST,
		...(supportsTools !== undefined ? { supportsTools } : {}),
		compat: compat as ModelSpec<TApi>["compat"],
	};
}

function mergeLiteLLMCompat<TApi extends Api>(
	existing: ModelSpec<TApi>["compat"],
	next: ModelSpec<TApi>["compat"],
	nextReportedParams: boolean,
): ModelSpec<TApi>["compat"] {
	if (!existing) return next;
	if (!next) return existing;
	const merged: Record<string, unknown> = { ...(existing as Record<string, unknown>) };
	for (const axis in next as Record<string, unknown>) {
		const value = (next as Record<string, unknown>)[axis];
		if (value !== undefined) merged[axis] = value;
	}
	// Only a reported `supported_openai_params` list is evidence for reasoning
	// effort; a reference-inferred value must not override another endpoint's list.
	if (!nextReportedParams) {
		const reported = (existing as Record<string, unknown>).supportsReasoningEffort;
		if (reported === undefined) delete merged.supportsReasoningEffort;
		else merged.supportsReasoningEffort = reported;
	}
	return merged as unknown as ModelSpec<TApi>["compat"];
}

function mergeLiteLLMRichEndpointModels<TApi extends Api>(
	existing: LiteLLMRichEndpointModel<TApi>,
	next: LiteLLMRichEndpointModel<TApi>,
): LiteLLMRichEndpointModel<TApi> {
	const apiRoute =
		existing.apiRoute === "other" || next.apiRoute === "other"
			? "other"
			: existing.apiRoute === "openai" || next.apiRoute === "openai"
				? "openai"
				: "unknown";
	const api = next.apiRoute === apiRoute ? next.model.api : existing.model.api;
	const model: ModelSpec<TApi> = {
		...existing.model,
		api,
		name: next.model.name === next.model.id ? existing.model.name : next.model.name,
		contextWindow: next.hasContextWindow ? next.model.contextWindow : existing.model.contextWindow,
		maxTokens: next.hasMaxTokens ? next.model.maxTokens : existing.model.maxTokens,
		input: next.supportsVision === true || next.supportsVision === false ? next.model.input : existing.model.input,
		reasoning: typeof next.supportsReasoning === "boolean" ? next.model.reasoning : existing.model.reasoning,
		cost: { ...existing.model.cost, ...existing.reportedCost, ...next.reportedCost },
		compat: mergeLiteLLMCompat(existing.model.compat, next.model.compat, next.hasSupportedOpenAIParams),
	};
	if (next.hasToolMetadata) {
		model.supportsTools = next.model.supportsTools;
	}
	return {
		...next,
		apiRoute,
		model,
		reportedCost: { ...existing.reportedCost, ...next.reportedCost },
		hasContextWindow: existing.hasContextWindow || next.hasContextWindow,
		hasMaxTokens: existing.hasMaxTokens || next.hasMaxTokens,
		hasToolMetadata: existing.hasToolMetadata || next.hasToolMetadata,
		hasSupportedOpenAIParams: existing.hasSupportedOpenAIParams || next.hasSupportedOpenAIParams,
		hasCost: existing.hasCost || next.hasCost,
	};
}

async function fetchLiteLLMRichEndpoint<TApi extends Api>(
	endpoint: string,
	options: FetchLiteLLMRichModelsOptions<TApi>,
	managementBaseUrl: string,
	runtimeBaseUrl: string,
	signal?: AbortSignal,
): Promise<LiteLLMRichEndpointResult<TApi> | null> {
	const fetchImpl = discoveryFetch(options.fetch);
	const requestHeaders: Record<string, string> = {
		Accept: "application/json",
		...options.headers,
	};
	if (options.apiKey) {
		requestHeaders.Authorization = `Bearer ${options.apiKey}`;
	}
	let response: Response;
	try {
		response = await fetchImpl(`${managementBaseUrl}${endpoint}`, {
			method: "GET",
			headers: requestHeaders,
			signal,
		});
	} catch (error) {
		return { failure: { endpoint, reason: "network-error", error } };
	}
	if (!response.ok) {
		return response.status === 404 ? null : { failure: { endpoint, reason: "http-status", status: response.status } };
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		return { failure: { endpoint, reason: "invalid-json", status: response.status, error } };
	}
	const entries = extractLiteLLMRichEntries(payload);
	if (!entries || entries.length === 0) {
		return null;
	}
	const deduped = new Map<string, LiteLLMRichEndpointModel<TApi>>();
	const excludedModelIds = new Set<string>();
	for (const entry of entries) {
		if (isLiteLLMUnusableSentinelPlaceholder(entry)) {
			continue;
		}
		const modelId = getLiteLLMRichModelId(entry);
		if (!isSelectableLiteLLMModelMode(getLiteLLMMetadataValue(entry, "mode"))) {
			if (modelId) {
				excludedModelIds.add(modelId);
				deduped.delete(modelId);
			}
			continue;
		}
		if (modelId && excludedModelIds.has(modelId)) {
			continue;
		}
		const model = mapLiteLLMRichEntry(entry, options, runtimeBaseUrl);
		if (model) {
			const supportsVision = getLiteLLMMetadataValue(entry, "supports_vision");
			const supportsReasoning = getLiteLLMMetadataValue(entry, "supports_reasoning");
			const supportsFunctionCalling = getLiteLLMMetadataValue(entry, "supports_function_calling");
			const supportedOpenAIParams = getSupportedOpenAIParams(entry);
			const next: LiteLLMRichEndpointModel<TApi> = {
				model,
				apiRoute: classifyLiteLLMApiRoute(entry, model.id),
				supportsVision,
				supportsReasoning,
				hasContextWindow: toPositiveNumber(getLiteLLMMetadataValue(entry, "max_input_tokens"), null) !== null,
				hasMaxTokens: toPositiveNumber(getLiteLLMMetadataValue(entry, "max_output_tokens"), null) !== null,
				hasToolMetadata:
					supportsFunctionCalling === true ||
					supportsFunctionCalling === false ||
					supportedOpenAIParams !== undefined,
				hasSupportedOpenAIParams: supportedOpenAIParams !== undefined,
				hasCost: getLiteLLMCost(entry) !== undefined,
				reportedCost: getLiteLLMReportedCost(entry),
			};
			const existing = deduped.get(model.id);
			deduped.set(model.id, existing ? mergeLiteLLMRichEndpointModels(existing, next) : next);
		}
	}
	if (deduped.size === 0 && excludedModelIds.size === 0) {
		return null;
	}
	const models = Array.from(deduped.values()).sort((left, right) => left.model.id.localeCompare(right.model.id));
	return {
		models,
		excludedModelIds,
		incompleteVisionMetadata: models.some(entry => entry.supportsVision !== true && entry.supportsVision !== false),
	};
}

async function fetchLiteLLMRichModelsInternal<TApi extends Api>(
	options: FetchLiteLLMRichModelsOptions<TApi>,
): Promise<ModelSpec<TApi>[] | null> {
	const managementBaseUrl = normalizeLiteLLMManagementBaseUrl(options.baseUrl);
	const runtimeBaseUrl = normalizeLiteLLMRuntimeBaseUrl(options.baseUrl);
	if (!managementBaseUrl || !runtimeBaseUrl) {
		return null;
	}
	const fetchModels = async (signal?: AbortSignal): Promise<ModelSpec<TApi>[] | null> => {
		const deduped = new Map<string, LiteLLMRichEndpointModel<TApi>>();
		const excludedModelIds = new Set<string>();
		let metadataFailure: LiteLLMRichEndpointFailure | undefined;
		for (const endpoint of LITELLM_RICH_ENDPOINTS) {
			const result = await fetchLiteLLMRichEndpoint(endpoint, options, managementBaseUrl, runtimeBaseUrl, signal);
			if (!result) {
				continue;
			}
			if ("failure" in result) {
				if (
					result.failure.status !== 401 &&
					(!metadataFailure || (metadataFailure.status !== 403 && result.failure.status === 403))
				) {
					metadataFailure = result.failure;
				}
				continue;
			}
			for (const modelId of result.excludedModelIds) {
				excludedModelIds.add(modelId);
				deduped.delete(modelId);
			}
			const hadPriorModels = deduped.size > 0;
			for (const next of result.models) {
				if (excludedModelIds.has(next.model.id)) {
					continue;
				}
				const existing = deduped.get(next.model.id);
				if (!existing) {
					if (!hadPriorModels) {
						deduped.set(next.model.id, next);
					}
					continue;
				}
				deduped.set(next.model.id, mergeLiteLLMRichEndpointModels(existing, next));
			}
			if (deduped.size === 0) {
				continue;
			}
			let needsMoreMetadata = false;
			for (const entry of deduped.values()) {
				if (
					(entry.supportsVision !== true && entry.supportsVision !== false) ||
					(options.resolveApi !== undefined && entry.apiRoute === "unknown") ||
					(Object.keys(entry.reportedCost).length > 0 &&
						(entry.reportedCost.input === undefined ||
							entry.reportedCost.output === undefined ||
							entry.reportedCost.cacheRead === undefined ||
							entry.reportedCost.cacheWrite === undefined))
				) {
					needsMoreMetadata = true;
					break;
				}
			}
			if (!needsMoreMetadata) {
				break;
			}
		}
		if (deduped.size === 0) {
			if (excludedModelIds.size > 0) {
				return [];
			}
			if (metadataFailure) {
				warnLiteLLMMetadataFallback(managementBaseUrl, metadataFailure);
			}
			return null;
		}
		return Array.from(deduped.values())
			.map(entry => entry.model)
			.sort((left, right) => left.id.localeCompare(right.id));
	};
	if (options.signal !== undefined) {
		return fetchModels(options.signal);
	}
	return options.timeoutMs !== undefined ? withCatalogDiscoveryTimeout(options.timeoutMs, fetchModels) : fetchModels();
}

export async function fetchLiteLLMRichModels<TApi extends Api>(
	options: FetchLiteLLMRichModelsOptions<TApi>,
): Promise<ModelSpec<TApi>[] | null> {
	return fetchLiteLLMRichModelsInternal(options);
}

export function litellmModelManagerOptions(config?: LiteLLMModelManagerConfig): ModelManagerOptions<Api> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? getDefaultModelDiscoveryBaseUrl("litellm")!;
	return {
		providerId: "litellm",

		cacheProviderId: resolveModelCacheProviderId("litellm", { baseUrl }),

		fetchDynamicModels: async () => {
			const modelsDevReferences = await loadModelsDevReferences<Api>(config?.fetch);
			const resolveReference = createReferenceResolver(modelsDevReferences);
			const richModels = await fetchLiteLLMRichModels<Api>({
				api: "openai-completions",
				provider: "litellm",
				baseUrl,
				apiKey,
				fetch: config?.fetch,
				referenceResolver: resolveReference,
				resolveApi: resolveLiteLLMApi,
				timeoutMs: 10_000,
			});
			if (richModels !== null) {
				return richModels;
			}
			return fetchOpenAICompatibleModels<Api>({
				api: "openai-completions",
				provider: "litellm",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) =>
					mapLiteLLMOpenAICompatibleModel(entry, defaults, resolveReference(defaults.id)),
				fetch: config?.fetch,
			});
		},
	};
}

const VLLM_DISCOVERY_TIMEOUT_MS = 10_000;

export interface VllmModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function vllmModelManagerOptions(config?: VllmModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? getDefaultModelDiscoveryBaseUrl("vllm")!;
	const references = createBundledReferenceMap<"openai-completions">("vllm" as Parameters<typeof getBundledModels>[0]);
	return {
		providerId: "vllm",
		cacheProviderId: resolveModelCacheProviderId("vllm", { baseUrl }),
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "vllm",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					const model = mapWithBundledReference(entry, defaults, reference);
					return {
						...model,
						contextWindow: toPositiveNumber(entry.max_model_len, model.contextWindow),
						reasoning: model.reasoning || reference === undefined,
					};
				},
				fetch: config?.fetch,
				timeoutMs: VLLM_DISCOVERY_TIMEOUT_MS,
			}),
	};
}

export interface NanoGptModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function nanoGptModelManagerOptions(
	config?: NanoGptModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://nano-gpt.com/api/v1";
	const resolveReference = createReferenceResolver(() =>
		createBundledReferenceMap<"openai-completions">("nanogpt" as Parameters<typeof getBundledModels>[0]),
	);
	return {
		providerId: "nanogpt",
		...(apiKey && {
			fetchDynamicModels: async () => {
				const thinkingBaseIds = new Set<string>();
				const models = await fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "nanogpt",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = resolveReference(defaults.id);
						const mapped = mapWithBundledReference(entry, defaults, reference);
						return { ...mapped, api: "openai-completions", provider: "nanogpt" };
					},
					filterModel: (_entry, model) => {
						const match = NANO_GPT_THINKING_SUFFIX_RE.exec(model.id);
						if (match) {
							thinkingBaseIds.add(model.id.slice(0, match.index));
							return false;
						}
						return isLikelyNanoGptTextModelId(model.id);
					},
					fetch: config?.fetch,
				});
				if (!models) return null;

				for (const model of models) {
					if (!model.reasoning && thinkingBaseIds.has(model.id)) {
						(model as { reasoning: boolean }).reasoning = true;
					}
				}
				return models;
			},
		}),
	};
}

export interface GithubCopilotModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

const COPILOT_ANTHROPIC_MODEL_PATTERN = /^claude-(haiku|sonnet|opus|fable|mythos)-\d/;
// Every Grok 4.x Copilot serves is Responses-only (chat completions answers 400
// unsupported_api_for_model), matched by prefix so new revisions and their `-1m`
// siblings route without a per-release id; grok-code-fast-1 stays on completions.
const isCopilotResponsesModelId = (modelId: string): boolean =>
	modelId.startsWith("grok-4.") ||
	modelId.startsWith("gpt-5") ||
	modelId.startsWith("gpt-6") ||
	modelId.startsWith("oswe") ||
	modelId.startsWith("mai-");
// Ids whose cached route predates the Responses pin: an older cache still says
// openai-completions, which Copilot rejects with 400 unsupported_api_for_model.
const COPILOT_CACHE_INVALIDATED_MODEL_IDS = [
	"gpt-6-astra",
	"gpt-6-astra-1m",
	"grok-4.5",
	"grok-4.5-1m",
	"grok-4.6",
	"grok-4.6-1m",
	"grok-4.7",
	"grok-4.7-1m",
	"mai-code-1-flash-picker",
];

function inferCopilotApi(modelId: string): Api {
	if (COPILOT_ANTHROPIC_MODEL_PATTERN.test(modelId)) {
		return "anthropic-messages";
	}
	if (isCopilotResponsesModelId(modelId)) {
		return "openai-responses";
	}
	return "openai-completions";
}

/** Move a stale Copilot row onto its Messages/Responses route; its chat-completions compat block does not follow. */
export function routeGitHubCopilotModelSpec(model: ModelSpec<Api>): ModelSpec<Api> {
	const api = inferCopilotApi(model.id);
	if (api === model.api || api === "openai-completions") return model;
	return { ...model, api, compat: undefined };
}

function extractCopilotLimits(entry: OpenAICompatibleModelRecord): {
	maxPromptTokens?: number;
	maxContextWindowTokens?: number;
	maxOutputTokens?: number;
	maxNonStreamingOutputTokens?: number;
} {
	if (!isRecord(entry.capabilities)) {
		return {};
	}
	const limitsValue = entry.capabilities.limits;
	if (!isRecord(limitsValue)) {
		return {};
	}
	return {
		maxPromptTokens: toNumber(limitsValue.max_prompt_tokens),
		maxContextWindowTokens: toNumber(limitsValue.max_context_window_tokens),
		maxOutputTokens: toNumber(limitsValue.max_output_tokens),
		maxNonStreamingOutputTokens: toNumber(limitsValue.max_non_streaming_output_tokens),
	};
}

export const COPILOT_LONG_CONTEXT_ID_SUFFIX = "-1m";
const COPILOT_LONG_CONTEXT_NAME_SUFFIX = " (1M)";

interface CopilotTokenPriceTier {
	contextMax?: number;
	inputPrice?: number;
	outputPrice?: number;
	cachePrice?: number;
}

function parseCopilotTokenPriceTier(value: unknown): CopilotTokenPriceTier | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	return {
		contextMax: toNumber(value.context_max),
		inputPrice: toNumber(value.input_price),
		outputPrice: toNumber(value.output_price),
		cachePrice: toNumber(value.cache_price),
	};
}

function extractCopilotTokenPrices(entry: OpenAICompatibleModelRecord): {
	defaultTier?: CopilotTokenPriceTier;
	longContext?: CopilotTokenPriceTier;
} {
	if (!isRecord(entry.billing)) {
		return {};
	}
	const tokenPrices = entry.billing.token_prices;
	if (!isRecord(tokenPrices)) {
		return {};
	}
	return {
		defaultTier: parseCopilotTokenPriceTier(tokenPrices.default),
		longContext: parseCopilotTokenPriceTier(tokenPrices.long_context),
	};
}

function extractCopilotSupportsVision(entry: OpenAICompatibleModelRecord): boolean | undefined {
	if (!isRecord(entry.capabilities)) {
		return undefined;
	}
	const supports = entry.capabilities.supports;
	if (!isRecord(supports)) {
		return undefined;
	}
	return toBoolean(supports.vision);
}

function isCopilotChatModel(entry: OpenAICompatibleModelRecord): boolean {
	if (!isRecord(entry.capabilities)) {
		return true;
	}
	const type = entry.capabilities.type;
	return typeof type !== "string" || type === "chat";
}

function copilotTierCost(
	tier: CopilotTokenPriceTier | undefined,
): Omit<ModelSpec<Api>["cost"], "cacheWrite"> | undefined {
	if (tier?.inputPrice === undefined || tier.outputPrice === undefined) {
		return undefined;
	}
	return {
		input: tier.inputPrice / 100,
		output: tier.outputPrice / 100,
		cacheRead: (tier.cachePrice ?? 0) / 100,
	};
}

function createCopilotLongContextVariant(
	base: ModelSpec<Api>,
	fullContextWindow: number | null,
	maxTokens: number | null,
	longContext: CopilotTokenPriceTier | undefined,
): ModelSpec<Api> | undefined {
	const longContextMax = longContext?.contextMax;
	if (longContextMax === undefined || longContextMax <= 0 || fullContextWindow === null || maxTokens === null) {
		return undefined;
	}
	const variantWindow = Math.min(fullContextWindow, longContextMax + maxTokens);
	if (base.contextWindow === null || variantWindow <= base.contextWindow) {
		return undefined;
	}
	const longCost = copilotTierCost(longContext);
	return {
		...base,
		id: `${base.id}${COPILOT_LONG_CONTEXT_ID_SUFFIX}`,
		requestModelId: base.id,
		name: `${base.name}${COPILOT_LONG_CONTEXT_NAME_SUFFIX}`,
		contextWindow: variantWindow,

		...(longCost && { cost: { ...longCost, cacheWrite: base.cost.cacheWrite } }),
		contextPromotionTarget: undefined,
	};
}

export function githubCopilotModelManagerOptions(config?: GithubCopilotModelManagerConfig): ModelManagerOptions<Api> {
	const rawApiKey = config?.apiKey;
	const configuredBaseUrl = config?.baseUrl ?? "https://api.githubcopilot.com";
	const parsedApiKey = rawApiKey ? parseGitHubCopilotApiKey(rawApiKey) : undefined;
	const apiKey = parsedApiKey?.accessToken;
	const baseUrl =
		parsedApiKey?.apiEndpoint && configuredBaseUrl.includes("githubcopilot.com")
			? parsedApiKey.apiEndpoint
			: parsedApiKey?.enterpriseUrl && configuredBaseUrl.includes("githubcopilot.com")
				? getGitHubCopilotBaseUrl(parsedApiKey.enterpriseUrl)
				: configuredBaseUrl;
	let providerReferences: Map<string, ModelSpec<Api>> | undefined;
	const getProviderReferences = () => (providerReferences ??= createBundledReferenceMap<Api>("github-copilot"));
	const resolveReference = createReferenceResolver(getProviderReferences);
	return {
		providerId: "github-copilot",
		cacheProviderId: resolveModelCacheProviderId("github-copilot", { apiKey: rawApiKey, baseUrl }),
		dropCachedModelIdsOnStaticMismatch: COPILOT_CACHE_INVALIDATED_MODEL_IDS,

		restorableHeaderFallback: { ...COPILOT_API_HEADERS },
		...(apiKey && {
			fetchDynamicModels: async () => {
				const fetchImpl = discoveryFetch(config?.fetch);
				const requestBaseUrl = isPersonalGitHubCopilotBaseUrl(baseUrl)
					? ((await withCatalogDiscoveryTimeout(DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS, signal =>
							discoverGitHubCopilotApiEndpoint(apiKey, fetchImpl, signal),
						)) ?? baseUrl)
					: baseUrl;
				const longContextVariants: ModelSpec<Api>[] = [];
				const models = await fetchOpenAICompatibleModels<Api>({
					api: "openai-completions",
					provider: "github-copilot",
					baseUrl: requestBaseUrl,
					apiKey,
					headers: COPILOT_DISCOVERY_HEADERS,
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: ModelSpec<Api>,
						_context: OpenAICompatibleModelMapperContext<Api>,
					): ModelSpec<Api> | null => {
						if (!isCopilotChatModel(entry)) {
							return null;
						}
						const reference = resolveReference(defaults.id);
						const copilotLimits = extractCopilotLimits(entry);

						const contextWindow = toPositiveNumber(
							copilotLimits.maxContextWindowTokens,
							toPositiveNumber(
								entry.context_length,
								toPositiveNumber(
									copilotLimits.maxPromptTokens,
									reference?.contextWindow ?? defaults.contextWindow,
								),
							),
						);
						const maxTokens = toPositiveNumber(
							copilotLimits.maxOutputTokens,
							toPositiveNumber(
								entry.max_completion_tokens,
								toPositiveNumber(
									copilotLimits.maxNonStreamingOutputTokens,
									reference?.maxTokens ?? defaults.maxTokens,
								),
							),
						);
						const name =
							typeof entry.name === "string" && entry.name.trim().length > 0
								? entry.name
								: (reference?.name ?? defaults.name);
						const api = inferCopilotApi(defaults.id);
						const supportsVision = extractCopilotSupportsVision(entry);
						const input: ModelSpec<Api>["input"] =
							supportsVision === true
								? ["text", "image"]
								: supportsVision === false || !isPersonalGitHubCopilotBaseUrl(requestBaseUrl)
									? ["text"]
									: (reference?.input ?? defaults.input);

						const tokenPrices = extractCopilotTokenPrices(entry);
						const defaultContextMax = tokenPrices.defaultTier?.contextMax;
						const defaultTierWindow =
							defaultContextMax !== undefined &&
							defaultContextMax > 0 &&
							contextWindow !== null &&
							maxTokens !== null
								? Math.min(contextWindow, defaultContextMax + maxTokens)
								: contextWindow;
						const base: ModelSpec<Api> = reference
							? {
									...reference,
									api,
									provider: "github-copilot",
									baseUrl: requestBaseUrl,
									name,
									input,
									contextWindow: defaultTierWindow,
									maxTokens,
									headers: mergeCopilotApiHeaders(getProviderReferences().get(defaults.id)?.headers),
									...(api === "openai-completions"
										? {
												compat: {
													supportsStore: false,
													supportsDeveloperRole: false,
													supportsReasoningEffort: false,
												},
											}
										: // A bundled row whose route later moved to Responses/Messages still
											// carries the chat-completions compat block, whose
											// `supportsReasoningEffort: false` would strip the effort dial.
											{ compat: undefined }),
								}
							: {
									...defaults,
									api,
									baseUrl: requestBaseUrl,
									name,
									input,
									contextWindow: defaultTierWindow,
									maxTokens,
									headers: mergeCopilotApiHeaders(),

									...(api === "anthropic-messages" && anthropicModelSupportsThinking(defaults.id)
										? { reasoning: true }
										: {}),
									...(api === "openai-completions"
										? {
												compat: {
													supportsStore: false,
													supportsDeveloperRole: false,
													supportsReasoningEffort: false,
												},
											}
										: {}),
								};
						// Cross-provider fallback references (e.g. a Cursor collapsed family for an
						// enterprise-only sibling id) carry wire routing that must not transfer: the
						// off-tier `requestModelId` pin would send every request as the `-none` sibling.
						if (reference && reference.provider !== "github-copilot") {
							delete base.requestModelId;
							if (base.thinking) {
								// Shallow copy of the shared bundled reference: clone before deleting.
								base.thinking = { ...base.thinking };
								delete base.thinking.effortRouting;
							}
						}
						const defaultCost = copilotTierCost(tokenPrices.defaultTier);
						if (defaultCost) {
							base.cost = { ...defaultCost, cacheWrite: base.cost.cacheWrite };
						}
						const variant = createCopilotLongContextVariant(
							base,
							contextWindow,
							maxTokens,
							tokenPrices.longContext,
						);
						if (variant) {
							longContextVariants.push(variant);

							base.contextPromotionTarget ??= `github-copilot/${variant.id}`;
						}
						return base;
					},
					fetch: fetchImpl,
				});
				if (models === null) {
					return null;
				}

				const takenIds = new Set(models.map(model => model.id));
				for (const variant of longContextVariants) {
					if (takenIds.has(variant.id)) {
						continue;
					}
					takenIds.add(variant.id);
					models.push(variant);
				}
				return models.sort((left, right) => left.id.localeCompare(right.id));
			},
		}),
	};
}

export interface AnthropicModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function anthropicModelManagerOptions(
	config?: AnthropicModelManagerConfig,
): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;

	const baseUrl = normalizeAnthropicBaseUrl(config?.baseUrl, ANTHROPIC_BASE_URL);
	const discoveryBaseUrl = toAnthropicDiscoveryBaseUrl(baseUrl);
	return {
		providerId: "anthropic",
		modelsDev: {
			fetch: () => fetchRevalidatedWellKnownModelsWithTimeout(config?.fetch),
			map: payload => mapAnthropicModelsDev(payload, baseUrl),
		},
		...(apiKey && {
			fetchDynamicModels: async () => {
				const modelsDevModels = await fetchWellKnownModels(config?.fetch)
					.then(payload => mapAnthropicModelsDev(payload, baseUrl))
					.catch(() => []);
				const references = buildAnthropicReferenceMap(modelsDevModels);
				return (
					fetchOpenAICompatibleModels({
						api: "anthropic-messages",
						provider: "anthropic",
						baseUrl: discoveryBaseUrl,
						headers: buildAnthropicDiscoveryHeaders(apiKey),
						mapModel: (
							entry: OpenAICompatibleModelRecord,
							defaults: ModelSpec<"anthropic-messages">,
							_context: OpenAICompatibleModelMapperContext<"anthropic-messages">,
						): ModelSpec<"anthropic-messages"> => {
							const discoveredName = typeof entry.display_name === "string" ? entry.display_name : defaults.name;
							const reference = references.get(defaults.id);
							if (!reference) {
								return {
									...defaults,
									name: discoveredName,
									baseUrl,
								};
							}
							return {
								...reference,
								id: defaults.id,
								name: discoveredName,
								api: "anthropic-messages",
								provider: "anthropic",
								baseUrl,
							};
						},
						fetch: config?.fetch,
					}) ?? null
				);
			},
		}),
	};
}

export interface SingularityApiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

const SINGULARITYAPI_CHAT_ENDPOINT = "/v1/chat/completions";

// Documented image-generation ids; the capability list drops any other non-chat row.
const SINGULARITYAPI_IMAGE_MODEL_IDS: Readonly<Record<string, true>> = {
	"flux-1-schnell": true,
	"flux-pro-1.1": true,
	"gpt-image-2": true,
	"gpt-image-1.5": true,
};

const SINGULARITYAPI_GPT_56_MODEL_IDS: Readonly<Record<string, true>> = {
	"gpt-5.6-sol": true,
	"gpt-5.6-terra": true,
	"gpt-5.6-luna": true,
};

// Efforts measured against the live gateways (2026-09-22): the universal gateway 400s `xhigh`/`max`, the reserved
// lanes 400 `medium`. `none` is the off switch on both.
const SINGULARITYAPI_DEV_DEEPSEEK_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Low, Effort.Medium, Effort.High],
};
const SINGULARITYAPI_DEV_GPT_56_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
};
const SINGULARITYAPI_TECH_LANE_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Low, Effort.High, Effort.XHigh, Effort.Max],
};

// Lane guide: 262,144 tokens prompt+completion, not the documented 1M.
const SINGULARITYAPI_TECH_LANE_CONTEXT_WINDOW = 262_144;

function isSingularityApiTechLaneModelId(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return id.endsWith("deepseek-v4-flash-0731") || id.endsWith("deepseek-v4.1-flash");
}

function singularityApiChatCapability(entry: OpenAICompatibleModelRecord): {
	capability: Record<string, unknown> | undefined;
	servesChat: boolean;
} {
	const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities.filter(isRecord) : [];
	const capability = capabilities.find(candidate => candidate.endpoint === SINGULARITYAPI_CHAT_ENDPOINT);
	return { capability, servesChat: capabilities.length === 0 || capability !== undefined };
}

function toSingularityApiRate(value: unknown): number {
	const parsed = toNumber(value);
	return parsed !== undefined && parsed >= 0 ? parsed : 0;
}

function mapSingularityApiDevModel(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
): ModelSpec<"openai-completions"> | null {
	const { capability, servesChat } = singularityApiChatCapability(entry);
	const id = defaults.id.toLowerCase();
	// Image rows serve only /v1/images/generations; proto has no image transport.
	if (!servesChat || SINGULARITYAPI_IMAGE_MODEL_IDS[id] === true) return null;
	const pricing = capability && isRecord(capability.pricing) ? capability.pricing : undefined;
	const isDeepseek = id.includes("deepseek");
	// The wire publishes no reasoning metadata, so the reviewed ladders are asserted here; a reasoning-less GPT-5.6
	// row would omit `reasoning_effort`, which the gateway rejects whenever tools are present.
	const thinking =
		id.includes("deepseek-v4-flash") || id.includes("deepseek-v4-pro")
			? SINGULARITYAPI_DEV_DEEPSEEK_THINKING
			: SINGULARITYAPI_GPT_56_MODEL_IDS[id] === true
				? SINGULARITYAPI_DEV_GPT_56_THINKING
				: undefined;
	const compat: OpenAICompat = {
		maxTokensField: "max_tokens",
		...(isDeepseek && { supportsToolChoice: false }),
		...(thinking && { reasoningDisableMode: "none-effort" as const }),
		...(thinking === SINGULARITYAPI_DEV_DEEPSEEK_THINKING && { reasoningContentField: "reasoning_content" as const }),
	};
	return {
		...defaults,
		name: toModelName(entry.name, defaults.name),
		contextWindow: toPositiveNumber(capability?.context_window_tokens, defaults.contextWindow),
		maxTokens: toPositiveNumber(capability?.maximum_output_tokens, defaults.maxTokens),
		cost: pricing
			? {
					input: toSingularityApiRate(pricing.input_per_million_usd),
					output: toSingularityApiRate(pricing.output_per_million_usd),
					cacheRead: 0,
					cacheWrite: 0,
				}
			: defaults.cost,
		compat,
		...(thinking && { reasoning: true, thinking }),
	};
}

function mapSingularityApiTechModel(
	_entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
): ModelSpec<"openai-completions"> {
	const compat: OpenAICompat = { maxTokensField: "max_tokens", reasoningContentField: "reasoning_content" };
	if (!isSingularityApiTechLaneModelId(defaults.id)) return { ...defaults, compat };
	return {
		...defaults,
		reasoning: true,
		thinking: SINGULARITYAPI_TECH_LANE_THINKING,
		input: ["text", "image"],
		contextWindow: SINGULARITYAPI_TECH_LANE_CONTEXT_WINDOW,
		// Lane guide: up to 8 image parts per request, and an overflowing max_tokens is clamped to the lane ceiling.
		compat: { ...compat, reasoningDisableMode: "none-effort", clampOutputToModelMax: true, stripImageInput: false },
	};
}

function singularityApiModelManagerOptions(
	providerId: "singularityapi-dev" | "singularityapi-tech",
	canonical: string,
	config: SingularityApiModelManagerConfig | undefined,
	mapModel: (
		entry: OpenAICompatibleModelRecord,
		defaults: ModelSpec<"openai-completions">,
	) => ModelSpec<"openai-completions"> | null,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeSingularityApiBaseUrl(config?.baseUrl, canonical);
	return {
		providerId,
		cacheProviderId: resolveModelCacheProviderId(providerId, { apiKey, baseUrl }),
		dynamicModelsAuthoritative: true,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: providerId,
					baseUrl,
					apiKey,
					mapModel,
					fetch: config?.fetch,
				}),
		}),
	};
}

/** SingularityAPI pay-as-you-go universal gateway: rows publish per-endpoint limits and per-million pricing. */
export function singularityApiDevModelManagerOptions(
	config?: SingularityApiModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return singularityApiModelManagerOptions(
		"singularityapi-dev",
		SINGULARITYAPI_DEV_API_BASE_URL,
		config,
		mapSingularityApiDevModel,
	);
}

/** SingularityAPI slot-reserved DeepSeek lanes: bare `{id}` rows, per-key roster. */
export function singularityApiTechModelManagerOptions(
	config?: SingularityApiModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return singularityApiModelManagerOptions(
		"singularityapi-tech",
		SINGULARITYAPI_TECH_API_BASE_URL,
		config,
		mapSingularityApiTechModel,
	);
}

export interface ModelsDevProviderDescriptor {
	modelsDevKey: string;

	providerId: string;

	api: Api;

	baseUrl: string;

	defaultContextWindow?: number;

	defaultMaxTokens?: number;

	compat?: ModelSpec<Api>["compat"];

	headers?: Record<string, string>;

	filterModel?: (modelId: string, model: ModelsDevModel) => boolean;

	transformModel?: (
		model: ModelSpec<Api>,
		modelId: string,
		raw: ModelsDevModel,
	) => ModelSpec<Api> | ModelSpec<Api>[] | null;

	resolveApi?: (modelId: string, raw: ModelsDevModel) => { api: Api; baseUrl: string } | null;
}

export function mapModelsDevToModels(
	data: Record<string, unknown>,
	descriptors: readonly ModelsDevProviderDescriptor[],
): ModelSpec<Api>[] {
	const models: ModelSpec<Api>[] = [];
	for (const desc of descriptors) {
		const providerData = (data as Record<string, Record<string, unknown>>)[desc.modelsDevKey];
		if (!isRecord(providerData) || !isRecord(providerData.models)) continue;

		for (const [modelId, rawModel] of Object.entries(providerData.models)) {
			if (!isRecord(rawModel)) continue;
			const m = rawModel as ModelsDevModel;

			if (desc.filterModel) {
				if (!desc.filterModel(modelId, m)) continue;
			} else {
				if (m.tool_call !== true) continue;
			}

			const resolved = desc.resolveApi?.(modelId, m) ?? { api: desc.api, baseUrl: desc.baseUrl };
			if (!resolved) continue;

			const mapped: ModelSpec<Api> = {
				id: modelId,
				name: toModelName(m.name, modelId),
				api: resolved.api,
				provider: desc.providerId as ModelSpec<Api>["provider"],
				baseUrl: resolved.baseUrl,
				reasoning: m.reasoning === true,
				input: toInputCapabilities(m.modalities?.input),
				cost: {
					input: toNumber(m.cost?.input) ?? 0,
					output: toNumber(m.cost?.output) ?? 0,
					cacheRead: toNumber(m.cost?.cache_read) ?? 0,
					cacheWrite: toNumber(m.cost?.cache_write) ?? 0,
				},
				contextWindow: toPositiveNumber(m.limit?.context, desc.defaultContextWindow ?? null),
				maxTokens: toPositiveNumber(m.limit?.output, desc.defaultMaxTokens ?? null),
				...(m.int != null ? { int: m.int } : {}),
				...(m.tps != null ? { tps: m.tps } : {}),
				...(m.tool_call === false ? { supportsTools: false } : {}),
				...(desc.compat && { compat: desc.compat }),
				...(desc.headers && { headers: { ...desc.headers } }),
			};

			if (desc.transformModel) {
				const result = desc.transformModel(mapped, modelId, m);
				if (result === null) continue;
				if (Array.isArray(result)) {
					models.push(...result);
				} else {
					models.push(result);
				}
			} else {
				models.push(mapped);
			}
		}
	}
	return models;
}

const BEDROCK_GLOBAL_PREFIXES = [
	"anthropic.claude-fable-5",
	"anthropic.claude-mythos-5",
	"anthropic.claude-haiku-4-5",
	"anthropic.claude-sonnet-4",
	"anthropic.claude-opus-4-5",
	"amazon.nova-2-lite",
	"cohere.embed-v4",
	"twelvelabs.pegasus-1-2",
];

const BEDROCK_US_PREFIXES = [
	"amazon.nova-lite",
	"amazon.nova-micro",
	"amazon.nova-premier",
	"amazon.nova-pro",
	"anthropic.claude-3-7-sonnet",
	"anthropic.claude-opus-4-1",
	"anthropic.claude-opus-4-20250514",
	"deepseek.r1",
	"meta.llama3-2",
	"meta.llama3-3",
	"meta.llama4",
];

function bedrockCrossRegionId(id: string): string {
	if (BEDROCK_GLOBAL_PREFIXES.some(p => id.startsWith(p))) return `global.${id}`;
	if (BEDROCK_US_PREFIXES.some(p => id.startsWith(p))) return `us.${id}`;
	return id;
}

interface ApiResolutionRule {
	matches: (modelId: string, raw: ModelsDevModel) => boolean;
	resolved: { api: Api; baseUrl: string };
}

function resolveApiByRules(
	modelId: string,
	raw: ModelsDevModel,
	rules: readonly ApiResolutionRule[],
	fallback: { api: Api; baseUrl: string },
): { api: Api; baseUrl: string } {
	for (const rule of rules) {
		if (rule.matches(modelId, raw)) return rule.resolved;
	}
	return fallback;
}

function createOpenCodeApiResolution(
	basePath: string,
	idOverrides: Readonly<Record<string, Api>> = {},
): {
	defaultResolution: { api: Api; baseUrl: string };
	rules: ApiResolutionRule[];
} {
	const completionsBaseUrl = `${basePath}/v1`;

	const baseUrlForApi = (api: Api): string => (api === "anthropic-messages" ? basePath : completionsBaseUrl);
	const overrideRules: ApiResolutionRule[] = Object.entries(idOverrides).map(([id, api]) => ({
		matches: modelId => modelId === id,
		resolved: { api, baseUrl: baseUrlForApi(api) },
	}));
	return {
		defaultResolution: { api: "openai-completions", baseUrl: completionsBaseUrl },
		rules: [
			...overrideRules,
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/openai",
				resolved: { api: "openai-responses", baseUrl: completionsBaseUrl },
			},
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/anthropic",
				resolved: { api: "anthropic-messages", baseUrl: basePath },
			},
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/google",
				resolved: { api: "google-generative-ai", baseUrl: completionsBaseUrl },
			},
		],
	};
}

const OPENCODE_ZEN_API_RESOLUTION = createOpenCodeApiResolution(
	"https://opencode.ai/zen",
	OPENCODE_ZEN_API_ID_OVERRIDES,
);
const OPENCODE_GO_API_RESOLUTION = createOpenCodeApiResolution(
	"https://opencode.ai/zen/go",
	OPENCODE_GO_API_ID_OVERRIDES,
);

const COPILOT_BASE_URL = "https://api.githubcopilot.com";

const COPILOT_DEFAULT_RESOLUTION = {
	api: "openai-completions",
	baseUrl: COPILOT_BASE_URL,
} as const satisfies { api: Api; baseUrl: string };

const COPILOT_API_RESOLUTION_RULES: readonly ApiResolutionRule[] = [
	{
		matches: modelId => COPILOT_ANTHROPIC_MODEL_PATTERN.test(modelId),
		resolved: { api: "anthropic-messages", baseUrl: COPILOT_BASE_URL },
	},
	{
		matches: isCopilotResponsesModelId,
		resolved: { api: "openai-responses", baseUrl: COPILOT_BASE_URL },
	},
];

function simpleModelsDevDescriptor(
	modelsDevKey: string,
	providerId: string,
	api: Api,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return {
		modelsDevKey,
		providerId,
		api,
		baseUrl,
		...options,
	};
}

function openAiCompletionsDescriptor(
	modelsDevKey: string,
	providerId: string,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return simpleModelsDevDescriptor(modelsDevKey, providerId, "openai-completions", baseUrl, options);
}

function openAiResponsesDescriptor(
	modelsDevKey: string,
	providerId: string,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return simpleModelsDevDescriptor(modelsDevKey, providerId, "openai-responses", baseUrl, options);
}

function anthropicMessagesDescriptor(
	modelsDevKey: string,
	providerId: string,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return simpleModelsDevDescriptor(modelsDevKey, providerId, "anthropic-messages", baseUrl, options);
}

const GOOGLE_VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
const GOOGLE_VERTEX_OPENAI_BASE_URL =
	"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi";
const GOOGLE_VERTEX_ANTHROPIC_BASE_URL =
	"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/{model}:streamRawPredict";

function resolveGoogleVertexApi(modelId: string, raw: ModelsDevModel): { api: Api; baseUrl: string } {
	if (raw.provider?.npm === "@ai-sdk/google-vertex/anthropic") {
		return {
			api: "anthropic-messages",
			baseUrl: GOOGLE_VERTEX_ANTHROPIC_BASE_URL.replace("{model}", modelId),
		};
	}
	if (modelId.includes("/") || raw.provider?.npm === "@ai-sdk/openai-compatible") {
		return { api: "openai-completions", baseUrl: GOOGLE_VERTEX_OPENAI_BASE_URL };
	}
	return { api: "google-vertex", baseUrl: GOOGLE_VERTEX_BASE_URL };
}

const MODELS_DEV_PROVIDER_DESCRIPTORS_BEDROCK: readonly ModelsDevProviderDescriptor[] = [
	{
		modelsDevKey: "amazon-bedrock",
		providerId: "amazon-bedrock",
		api: "bedrock-converse-stream",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		filterModel: (id, m) => {
			if (m.tool_call !== true) return false;
			if (id.startsWith("ai21.jamba")) return false;
			if (id.startsWith("amazon.titan-text-express") || id.startsWith("mistral.mistral-7b-instruct-v0"))
				return false;
			return true;
		},
		transformModel: (model, modelId, m) => {
			const crossRegionId = bedrockCrossRegionId(modelId);
			const bedrockModel: ModelSpec<Api> = {
				...model,
				id: crossRegionId,
				name: toModelName(m.name, crossRegionId),
			};

			if (modelId.startsWith("anthropic.claude-")) {
				const displayName = toModelName(m.name, modelId);
				return [
					bedrockModel,
					{
						...bedrockModel,
						id: `eu.${modelId}`,
						name: `${displayName} (EU)`,
					},
					{
						...bedrockModel,
						id: `us-gov.${modelId}`,
						name: `${displayName} (GovCloud)`,
					},
				];
			}
			return bedrockModel;
		},
	},
];

const MODELS_DEV_PROVIDER_DESCRIPTORS_CORE: readonly ModelsDevProviderDescriptor[] = [
	anthropicMessagesDescriptor("anthropic", "anthropic", "https://api.anthropic.com", {
		filterModel: (id, m) => {
			if (m.tool_call !== true) return false;
			if (
				id.startsWith("claude-3-5-haiku") ||
				id.startsWith("claude-3-7-sonnet") ||
				id === "claude-3-opus-20240229" ||
				id === "claude-3-sonnet-20240229"
			)
				return false;
			return true;
		},
	}),

	simpleModelsDevDescriptor(
		"google",
		"google",
		"google-generative-ai",
		"https://generativelanguage.googleapis.com/v1beta",
	),

	simpleModelsDevDescriptor("openai", "openai", "openai-responses", "https://api.openai.com/v1"),

	openAiCompletionsDescriptor("groq", "groq", "https://api.groq.com/openai/v1"),

	openAiCompletionsDescriptor("cerebras", "cerebras", "https://api.cerebras.ai/v1"),

	openAiCompletionsDescriptor("togetherai", "together", "https://api.together.xyz/v1"),

	openAiCompletionsDescriptor("wandb", "coreweave", "https://api.inference.wandb.ai/v1", {
		transformModel: model => {
			if (!model.id.startsWith("openai/gpt-oss-")) {
				return model;
			}
			return {
				...model,
				reasoning: true,
				thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
			};
		},
	}),

	openAiCompletionsDescriptor("nvidia", "nvidia", "https://integrate.api.nvidia.com/v1", {
		defaultContextWindow: 131072,
	}),

	openAiResponsesDescriptor("xai", "xai", "https://api.x.ai/v1", {
		transformModel: model => applyXaiResponsesThinkingPolicy(model as ModelSpec<"openai-responses">),
	}),

	openAiCompletionsDescriptor("deepseek", "deepseek", "https://api.deepseek.com", {
		// V4.1 Flash dropped the generation digit: it ships as bare `deepseek-flash`.
		filterModel: (id, m) => m.tool_call === true && (id.startsWith("deepseek-v4") || id === "deepseek-flash"),
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",

			supportsToolChoice: false,

			extraBody: { thinking: { type: "enabled" } },

			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: true,
			requiresAssistantContentForToolCalls: true,
		},
	}),
];

const ZAI_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
// The `zai` provider is the GLM Coding Plan: native completions ride the coding-plan base (plan quota), not PAYG.
const ZAI_OPENAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

/** Z.AI serves GLM-5.3-Flash only on its native chat-completions API, not the Anthropic coding endpoint (#10539). */
export function resolveZaiApi(modelId: string): { api: "anthropic-messages" | "openai-completions"; baseUrl: string } {
	return modelId === "glm-5.3-flash"
		? { api: "openai-completions", baseUrl: ZAI_OPENAI_BASE_URL }
		: { api: "anthropic-messages", baseUrl: ZAI_ANTHROPIC_BASE_URL };
}

const MODELS_DEV_PROVIDER_DESCRIPTORS_CODING_PLANS: readonly ModelsDevProviderDescriptor[] = [
	anthropicMessagesDescriptor("zai", "zai", ZAI_ANTHROPIC_BASE_URL, { resolveApi: resolveZaiApi }),

	anthropicMessagesDescriptor("umans-ai", "umans", UMANS_BASE_URL),

	openAiCompletionsDescriptor("xiaomi", "xiaomi", "https://api.xiaomimimo.com/v1", {
		defaultContextWindow: 262144,
		defaultMaxTokens: 8192,
		compat: {
			supportsStore: false,
			thinkingFormat: "zai",
			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: true,
			allowsSyntheticReasoningContentForToolCalls: false,
		},
	}),

	openAiCompletionsDescriptor("minimax-coding-plan", "minimax-code", "https://api.minimax.io/v1", {
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			reasoningContentField: "reasoning_content",
		},
	}),
	openAiCompletionsDescriptor("minimax-cn-coding-plan", "minimax-code-cn", "https://api.minimaxi.com/v1", {
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			reasoningContentField: "reasoning_content",
		},
	}),

	openAiCompletionsDescriptor(
		"alibaba-coding-plan",
		"alibaba-coding-plan",
		"https://coding-intl.dashscope.aliyuncs.com/v1",
		{
			compat: {
				supportsDeveloperRole: false,
			},
		},
	),

	openAiCompletionsDescriptor(
		"zhipuai-coding-plan",
		"zhipu-coding-plan",
		"https://open.bigmodel.cn/api/coding/paas/v4",
		{
			compat: {
				thinkingFormat: "zai",
				reasoningContentField: "reasoning_content",
				supportsDeveloperRole: false,
			},
		},
	),
];

const filterActiveToolCallModels = (_id: string, m: ModelsDevModel): boolean => {
	if (m.tool_call !== true) return false;
	if (m.status === "deprecated") return false;
	return true;
};

// Vertex rejects maxOutputTokens=65536 for the Gemini 2.5 Flash-Lite line ("65536 (exclusive)").
const GOOGLE_VERTEX_GEMINI_25_FLASH_LITE_RE = /^gemini-2\.5-flash-lite(?:-|$)/;

const MODELS_DEV_PROVIDER_DESCRIPTORS_GOOGLE_VERTEX: readonly ModelsDevProviderDescriptor[] = [
	simpleModelsDevDescriptor("google-vertex", "google-vertex", "google-vertex", GOOGLE_VERTEX_BASE_URL, {
		filterModel: filterActiveToolCallModels,
		resolveApi: resolveGoogleVertexApi,
		transformModel: (model, modelId) =>
			GOOGLE_VERTEX_GEMINI_25_FLASH_LITE_RE.test(modelId) ? { ...model, maxTokens: 65_535 } : model,
	}),
];

const OPENCODE_MODELS_DEV_DESCRIPTORS: readonly ModelsDevProviderDescriptor[] = [
	openAiCompletionsDescriptor("opencode", "opencode-zen", "https://opencode.ai/zen/v1", {
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(
				modelId,
				raw,
				OPENCODE_ZEN_API_RESOLUTION.rules,
				OPENCODE_ZEN_API_RESOLUTION.defaultResolution,
			),
	}),
	openAiCompletionsDescriptor("opencode-go", "opencode-go", "https://opencode.ai/zen/go/v1", {
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(
				modelId,
				raw,
				OPENCODE_GO_API_RESOLUTION.rules,
				OPENCODE_GO_API_RESOLUTION.defaultResolution,
			),
	}),
];

const MODELS_DEV_PROVIDER_DESCRIPTORS_SPECIALIZED: readonly ModelsDevProviderDescriptor[] = [
	simpleModelsDevDescriptor("azure", "azure", "azure-openai-responses", "", {
		filterModel: (modelId, m) => {
			if (m.tool_call !== true) return false;

			return /^(gpt-|o1|o3|o4|codex|chatgpt)/.test(modelId);
		},
	}),

	anthropicMessagesDescriptor(
		"cloudflare-ai-gateway",
		"cloudflare-ai-gateway",
		CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	),
	// Workers AI models are served through the gateway's OpenAI-compatible `/compat` route.
	openAiCompletionsDescriptor(
		"cloudflare-workers-ai",
		"cloudflare-ai-gateway",
		CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
		{
			filterModel: filterActiveToolCallModels,
			transformModel: model => ({ ...model, id: `workers-ai/${model.id}` }),
		},
	),

	openAiCompletionsDescriptor("mistral", "mistral", "https://api.mistral.ai/v1"),

	...OPENCODE_MODELS_DEV_DESCRIPTORS,

	openAiCompletionsDescriptor("github-copilot", "github-copilot", COPILOT_BASE_URL, {
		defaultContextWindow: 128000,
		defaultMaxTokens: 8192,
		headers: { ...COPILOT_API_HEADERS },
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(modelId, raw, COPILOT_API_RESOLUTION_RULES, COPILOT_DEFAULT_RESOLUTION),
		transformModel: model => {
			if (model.api === "openai-completions") {
				return {
					...model,
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
					},
				};
			}
			return model;
		},
	}),

	anthropicMessagesDescriptor("minimax", "minimax", "https://api.minimax.io/anthropic"),
	anthropicMessagesDescriptor("minimax-cn", "minimax-cn", "https://api.minimaxi.com/anthropic"),

	openAiCompletionsDescriptor("huggingface", "huggingface", "https://router.huggingface.co/v1"),

	openAiCompletionsDescriptor("kilo", "kilo", "https://api.kilo.ai/api/gateway"),

	openAiCompletionsDescriptor("moonshotai", "moonshot", "https://api.moonshot.ai/v1"),

	openAiCompletionsDescriptor("nano-gpt", "nanogpt", "https://nano-gpt.com/api/v1"),

	openAiCompletionsDescriptor("synthetic", "synthetic", "https://api.synthetic.new/openai/v1"),

	openAiCompletionsDescriptor("venice", "venice", "https://api.venice.ai/api/v1", {
		transformModel: model => {
			const maxTokens = clampKimiK27CodeMaxTokens(model.id, model.maxTokens);
			return maxTokens === model.maxTokens ? model : { ...model, maxTokens };
		},
	}),

	simpleModelsDevDescriptor("ollama-cloud", "ollama-cloud", "ollama-chat", "https://ollama.com"),

	openAiCompletionsDescriptor(
		"xiaomi-token-plan-ams",
		"xiaomi-token-plan-ams",
		"https://token-plan-ams.xiaomimimo.com/v1",
	),
	openAiCompletionsDescriptor(
		"xiaomi-token-plan-cn",
		"xiaomi-token-plan-cn",
		"https://token-plan-cn.xiaomimimo.com/v1",
	),
	openAiCompletionsDescriptor(
		"xiaomi-token-plan-sgp",
		"xiaomi-token-plan-sgp",
		"https://token-plan-sgp.xiaomimimo.com/v1",
	),

	openAiCompletionsDescriptor("qwen-portal", "qwen-portal", "https://portal.qwen.ai/v1", {
		defaultContextWindow: 128000,
		defaultMaxTokens: 8192,
	}),

	openAiCompletionsDescriptor("zenmux", "zenmux", ZENMUX_OPENAI_BASE_URL, {
		filterModel: filterActiveToolCallModels,
		resolveApi: modelId => {
			if (modelId.startsWith("anthropic/")) {
				return { api: "anthropic-messages" as const, baseUrl: ZENMUX_ANTHROPIC_BASE_URL };
			}
			return { api: "openai-completions" as const, baseUrl: ZENMUX_OPENAI_BASE_URL };
		},
	}),
];

export const MODELS_DEV_PROVIDER_DESCRIPTORS: readonly ModelsDevProviderDescriptor[] = [
	...MODELS_DEV_PROVIDER_DESCRIPTORS_BEDROCK,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_GOOGLE_VERTEX,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_CORE,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_CODING_PLANS,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_SPECIALIZED,
];

const MODELS_DEV_DESCRIPTORS_BY_PROVIDER: Record<string, ModelsDevProviderDescriptor[]> = Object.create(null);
for (const descriptor of MODELS_DEV_PROVIDER_DESCRIPTORS) {
	const providerDescriptors = MODELS_DEV_DESCRIPTORS_BY_PROVIDER[descriptor.providerId];
	if (providerDescriptors) {
		providerDescriptors.push(descriptor);
	} else {
		MODELS_DEV_DESCRIPTORS_BY_PROVIDER[descriptor.providerId] = [descriptor];
	}
}

/** Providers whose bundled catalog can receive additive shared-catalog models at runtime. */
export const MODELS_DEV_CATALOG_PROVIDER_IDS: readonly string[] = Object.freeze(
	Object.keys(MODELS_DEV_DESCRIPTORS_BY_PROVIDER),
);

/**
 * Additive shared-catalog fallback for one known provider: new ids only, mapped through the provider's
 * catalog descriptors and the generator's row filter. Managers sharing a fetch implementation reuse its
 * conditional catalog session; each provider slice is cached independently.
 */
export function modelsDevCatalogFallback(
	providerId: string,
	fetchImpl?: FetchImpl,
	timeoutMs = DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS,
): ModelsDevFallback<Api> | undefined {
	const descriptors = MODELS_DEV_DESCRIPTORS_BY_PROVIDER[providerId];
	if (!descriptors) return undefined;
	return {
		additiveOnly: true,
		fetch: () => fetchRevalidatedWellKnownModelsWithTimeout(fetchImpl, timeoutMs),
		map: payload => (isRecord(payload) ? filterModelsDevCatalogRows(mapModelsDevToModels(payload, descriptors)) : []),
	};
}

export interface CharmHyperModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

/** `none` is Hyper's thinking-off switch, not a rung: it suppresses reasoning outright. */
const CHARM_HYPER_WIRE_EFFORT_NONE = "none";

/**
 * Gateway-published limits that are wrong. Hyper derives `max_output_tokens` as a flat fraction of the
 * context window (advisory, never enforced); these take a same-window peer's published cap. MiniMax-M3
 * carries the leaked 512K pricing-tier boundary instead of its documented 1M in / 128K out.
 */
const CHARM_HYPER_LIMIT_PATCHES: Readonly<Record<string, { contextWindow?: number; maxTokens?: number }>> = {
	"glm-5.1": { maxTokens: 20_275 },
	"minimax-m2.7": { maxTokens: 26_214 },
	"minimax-m3": { contextWindow: 1_000_000, maxTokens: 128_000 },
};

function charmHyperWireEfforts(reasoning: unknown): readonly string[] {
	if (!isRecord(reasoning) || !Array.isArray(reasoning.effort_levels)) return [];
	const values: string[] = [];
	for (const level of reasoning.effort_levels) {
		const value = isRecord(level) ? level.value : undefined;
		if (typeof value === "string" && !values.includes(value)) values.push(value);
	}
	return values;
}

function resolveCharmHyperThinking(reasoning: unknown, wireEfforts: readonly string[]): ThinkingConfig | undefined {
	const efforts = THINKING_EFFORTS.filter(effort => wireEfforts.includes(effort));
	if (efforts.length === 0) return undefined;
	const advertisedDefault = isRecord(reasoning) ? reasoning.default_effort_level : undefined;
	const defaultLevel = efforts.find(effort => effort === advertisedDefault);
	return { mode: "effort", efforts, ...(defaultLevel !== undefined && { defaultLevel }) };
}

// Free tiers and `cache_create: 0` are real zero rates, so zero passes through.
function toCharmHyperRate(value: unknown): number {
	const parsed = toNumber(value);
	return parsed !== undefined && parsed >= 0 ? parsed : 0;
}

function resolveCharmHyperCost(pricing: unknown): ModelSpec<"openai-completions">["cost"] {
	if (!isRecord(pricing)) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		input: toCharmHyperRate(pricing.input),
		output: toCharmHyperRate(pricing.output),
		cacheRead: toCharmHyperRate(pricing.cache_hit),
		cacheWrite: toCharmHyperRate(pricing.cache_create),
	};
}

/**
 * Rows without an `effort_levels` vocabulary stay non-reasoning even when the model thinks anyway
 * (glm-5, glm-5.1, kimi-k2-thinking, minimax-m2.7): the gateway accepts and ignores unadvertised
 * efforts, so any synthesized ladder would be silent no-op rungs. Streamed `reasoning_content` is
 * still displayed without a `model.reasoning` gate.
 */
function mapCharmHyperModel(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
): ModelSpec<"openai-completions"> {
	const wireEfforts = charmHyperWireEfforts(entry.reasoning);
	const thinking = resolveCharmHyperThinking(entry.reasoning, wireEfforts);
	const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined;
	const patch = CHARM_HYPER_LIMIT_PATCHES[defaults.id];
	const compat: OpenAICompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		maxTokensField: "max_tokens",
		thinkingFormat: "openai",
		reasoningContentField: "reasoning_content",
		...(thinking && wireEfforts.includes(CHARM_HYPER_WIRE_EFFORT_NONE) && { reasoningDisableMode: "none-effort" }),
	};
	return {
		...defaults,
		name: toModelName(entry.display_name, defaults.name),
		reasoning: thinking !== undefined,
		...(thinking && { thinking }),
		input: capabilities?.vision === true ? ["text", "image"] : ["text"],
		contextWindow: patch?.contextWindow ?? toPositiveNumber(entry.context_window, defaults.contextWindow),
		maxTokens: patch?.maxTokens ?? toPositiveNumber(entry.max_output_tokens, defaults.maxTokens),
		cost: resolveCharmHyperCost(entry.pricing),
		compat,
	};
}

/**
 * `/v1/models` is public and carries every row's limits, vision flag, effort vocabulary and live tariff,
 * so discovery runs with or without a key and the snapshot is authoritative. Deliberately never bundled.
 */
export function charmHyperModelManagerOptions(
	config?: CharmHyperModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const baseUrl = normalizeCharmHyperBaseUrl(config?.baseUrl);
	return {
		providerId: "charm-hyper",
		cacheProviderId: resolveModelCacheProviderId("charm-hyper", { baseUrl }),
		dynamicModelsAuthoritative: true,
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "charm-hyper",
				baseUrl,
				apiKey: config?.apiKey,
				mapModel: mapCharmHyperModel,
				fetch: config?.fetch,
			}),
	};
}
