import { type ApiKey, type FetchImpl, withAuth } from "@oh-my-pi/pi-ai";
import type { Api, Model, RemoteCompactionConfig } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import {
	getBundledModelReferenceIndex,
	inheritReferenceThinking,
	isQwenModelId,
	resolveModelReference,
	stripBracketedModelIdAffixes,
} from "@oh-my-pi/pi-catalog/identity";
import {
	fetchLiteLLMRichModels,
	fetchLmStudioNativeModelMetadata,
	isSelectableLiteLLMModelMode,
	OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW,
	OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS,
	resolveLiteLLMApi,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec, OpenAICompat, ThinkingConfig } from "@oh-my-pi/pi-catalog/types";
import { parseServiceTierIds } from "@oh-my-pi/pi-catalog/utils";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ProviderDiscovery } from "./models-config-schema";

const DISCOVERY_DEFAULT_CONTEXT_WINDOW = OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW;
export const DISCOVERY_DEFAULT_MAX_TOKENS = OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS;

/** Discovery HTTP failure with a structured status. The `HTTP <status> from <url>` message is matched by the model hub. */
export class DiscoveryHttpError extends Error {
	readonly status: number;

	constructor(status: number, url: string) {
		super(`HTTP ${status} from ${url}`);
		this.name = "DiscoveryHttpError";
		this.status = status;
	}
}

/** 401/403: the endpoint is reachable but refused the credentials (or the keyless assumption). */
export function isDiscoveryAuthRejection(error: unknown): boolean {
	return error instanceof DiscoveryHttpError && (error.status === 401 || error.status === 403);
}

async function withTimeoutSignal<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		const error = new DOMException("The operation timed out.", "TimeoutError");
		controller.abort(error);
		timeout.reject(error);
	}, timeoutMs);
	try {
		return await Promise.race([fn(controller.signal), timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

const REMOTE_DISCOVERY_TIMEOUT_MS = 10_000;

export function discoveryProbeTimeoutMs(baseUrl: string, loopbackMs: number, customTimeoutMs?: number): number {
	if (typeof customTimeoutMs === "number" && customTimeoutMs > 0 && Number.isFinite(customTimeoutMs)) {
		return customTimeoutMs;
	}
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname;
	} catch {
		return loopbackMs;
	}
	hostname = hostname.replace(/^\[/, "").replace(/\]$/, "");
	const isLoopback =
		hostname === "localhost" || hostname === "0.0.0.0" || hostname === "::1" || /^127\./.test(hostname);
	return isLoopback ? loopbackMs : REMOTE_DISCOVERY_TIMEOUT_MS;
}

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_HOST_DEFAULT_PORT = "11434";

function normalizeOllamaHostEnv(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const candidate = trimmed.includes("://")
		? trimmed
		: trimmed.startsWith("//")
			? `http:${trimmed}`
			: trimmed.startsWith(":")
				? `http://127.0.0.1${trimmed}`
				: `http://${trimmed}`;
	try {
		const parsed = new URL(candidate);
		if (!parsed.hostname || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
			return undefined;
		}
		if (!parsed.port && parsed.protocol === "http:") {
			parsed.port = OLLAMA_HOST_DEFAULT_PORT;
		}
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return undefined;
	}
}

export function getImplicitOllamaBaseUrl(): string {
	const baseUrl = Bun.env.OLLAMA_BASE_URL?.trim();
	return baseUrl || normalizeOllamaHostEnv(Bun.env.OLLAMA_HOST) || DEFAULT_OLLAMA_BASE_URL;
}

export function getOllamaContextLengthOverride(): number | undefined {
	const value = Bun.env.OLLAMA_CONTEXT_LENGTH?.trim();
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const DISCOVERY_DEFAULT_MAX_TOKENS_ANTHROPIC = 8_192;

function discoveryDefaultMaxTokens(api: Api | undefined): number {
	return api === "anthropic-messages" ? DISCOVERY_DEFAULT_MAX_TOKENS_ANTHROPIC : DISCOVERY_DEFAULT_MAX_TOKENS;
}

export interface DiscoveryProviderConfig {
	provider: string;
	api: Api;
	baseUrl?: string;
	headers?: Record<string, string>;
	compat?: ModelSpec<Api>["compat"];
	remoteCompaction?: RemoteCompactionConfig<Api>;
	discovery: ProviderDiscovery;
	optional?: boolean;
	fallbackBaseUrls?: string[];
}

export interface DiscoveryContext {
	fetch: FetchImpl;

	getBearerApiKeyResolver(provider: string): Promise<ApiKey | undefined>;
}

type OllamaDiscoveredModelMetadata = {
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow?: number;
};

type LlamaCppDiscoveredServerMetadata = {
	contextWindow?: number;
	input?: ("text" | "image")[];
	maxTokens?: "contextWindow";
};

type DiscoveredModelRuntimeMetadata = {
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
};

type LlamaCppModelListEntry = {
	id: string;
	input?: ("text" | "image")[];
	runtimeContextWindow?: number;

	configuredContextWindow?: number;
	trainingContextWindow?: number;
};

function toPositiveNumberOrUndefined(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return undefined;
}

function toTokenLimitOrUndefined(value: unknown): number | undefined {
	const parsed = toPositiveNumberOrUndefined(value);
	return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isLlamaCppUnlimitedSentinel(value: unknown): boolean {
	if (typeof value === "number") {
		return value === -1;
	}
	if (typeof value === "string" && value.trim()) {
		return Number(value) === -1;
	}
	return false;
}

function extractLlamaCppMaxTokens(payload: Record<string, unknown>): "contextWindow" | undefined {
	const generationSettings = payload.default_generation_settings;
	const params = isRecord(generationSettings) ? generationSettings.params : undefined;
	const candidates = [
		isRecord(params) ? params.max_tokens : undefined,
		isRecord(params) ? params.n_predict : undefined,
		isRecord(generationSettings) ? generationSettings.max_tokens : undefined,
		isRecord(generationSettings) ? generationSettings.n_predict : undefined,
		payload.max_tokens,
		payload.n_predict,
	];
	return candidates.some(isLlamaCppUnlimitedSentinel) ? "contextWindow" : undefined;
}

function resolveLlamaCppMaxTokens(contextWindow: number, maxTokens: "contextWindow" | undefined): number {
	return maxTokens === "contextWindow"
		? contextWindow
		: Math.min(contextWindow, maxTokens ?? DISCOVERY_DEFAULT_MAX_TOKENS);
}

function extractOllamaRuntimeContextWindow(payload: Record<string, unknown>): number | undefined {
	const parameters = payload.parameters;
	if (typeof parameters !== "string") {
		return undefined;
	}
	const match = parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)\s*(?:$|\n)/m);
	return match ? toPositiveNumberOrUndefined(match[1]) : undefined;
}

function extractOllamaContextWindow(payload: Record<string, unknown>): number | undefined {
	const runtimeContextWindow = extractOllamaRuntimeContextWindow(payload);
	if (runtimeContextWindow !== undefined) {
		return runtimeContextWindow;
	}

	const modelInfo = payload.model_info;
	if (isRecord(modelInfo)) {
		for (const [key, value] of Object.entries(modelInfo)) {
			if (key === "context_length" || key.endsWith(".context_length")) {
				const contextWindow = toPositiveNumberOrUndefined(value);
				if (contextWindow !== undefined) {
					return contextWindow;
				}
			}
		}
	}

	return undefined;
}

function extractLlamaCppContextWindow(payload: Record<string, unknown>): number | undefined {
	const generationSettings = payload.default_generation_settings;
	if (isRecord(generationSettings)) {
		const contextWindow = toPositiveNumberOrUndefined(generationSettings.n_ctx);
		if (contextWindow !== undefined) {
			return contextWindow;
		}
	}
	return toPositiveNumberOrUndefined(payload.n_ctx);
}

function extractLlamaCppModelContextWindows(
	item: Record<string, unknown>,
): Pick<LlamaCppModelListEntry, "runtimeContextWindow" | "trainingContextWindow"> {
	const meta = item.meta;
	if (!isRecord(meta)) {
		return {};
	}
	return {
		runtimeContextWindow: toPositiveNumberOrUndefined(meta.n_ctx),
		trainingContextWindow: toPositiveNumberOrUndefined(meta.n_ctx_train),
	};
}

function extractLlamaCppModelInputCapabilities(item: Record<string, unknown>): ("text" | "image")[] | undefined {
	const architecture = item.architecture;
	if (!isRecord(architecture) || !Array.isArray(architecture.input_modalities)) {
		return undefined;
	}
	const modalities = new Set<string>();
	for (const modality of architecture.input_modalities) {
		if (typeof modality === "string") {
			modalities.add(modality.toLowerCase());
		}
	}
	return modalities.has("image") ? ["text", "image"] : ["text"];
}

function parseLlamaCppModelList(payload: unknown): LlamaCppModelListEntry[] {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		return [];
	}
	return payload.data.flatMap(item => {
		if (!isRecord(item) || typeof item.id !== "string" || !item.id) {
			return [];
		}
		return [
			{
				id: item.id,
				input: extractLlamaCppModelInputCapabilities(item),
				...extractLlamaCppModelContextWindows(item),
				configuredContextWindow: extractLlamaCppConfiguredContextWindow(item),
			},
		];
	});
}

const LLAMA_CPP_CTX_SIZE_FLAGS = new Set(["--ctx-size", "-c"]);

function extractLlamaCppCtxSizeFromArgs(value: unknown): number | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	for (let i = 0; i < value.length; i++) {
		const raw = value[i];
		if (typeof raw !== "string") continue;
		const eq = raw.indexOf("=");
		const flag = eq >= 0 ? raw.slice(0, eq) : raw;
		if (!LLAMA_CPP_CTX_SIZE_FLAGS.has(flag)) continue;
		const rawValue = eq >= 0 ? raw.slice(eq + 1) : value[i + 1];
		const parsed = toPositiveNumberOrUndefined(rawValue);
		if (parsed !== undefined) return parsed;
	}
	return undefined;
}

function extractLlamaCppCtxSizeFromIni(value: unknown): number | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const match = value.match(/(?:^|\n)\s*ctx-size\s*=\s*(-?\d+)\s*(?:$|\n)/);
	return match ? toPositiveNumberOrUndefined(match[1]) : undefined;
}

function extractLlamaCppConfiguredContextWindow(item: Record<string, unknown>): number | undefined {
	const status = item.status;
	if (!isRecord(status)) {
		return undefined;
	}
	const fromArgs = extractLlamaCppCtxSizeFromArgs(status.args);
	if (fromArgs !== undefined) {
		return fromArgs;
	}
	return extractLlamaCppCtxSizeFromIni(status.preset);
}

function extractLlamaCppInputCapabilities(payload: Record<string, unknown>): ("text" | "image")[] | undefined {
	const modalities = payload.modalities;
	if (!isRecord(modalities)) {
		return undefined;
	}
	return modalities.vision === true ? ["text", "image"] : ["text"];
}

export function discoverModelsByProviderType(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	switch (providerConfig.discovery.type) {
		case "ollama":
			return discoverOllamaModels(providerConfig, ctx);
		case "llama.cpp":
			return discoverLlamaCppModels(providerConfig, ctx);
		case "lm-studio":
		case "openai-models-list":
			return discoverOpenAIModelsList(providerConfig, ctx);
		case "proxy":
			return discoverProxyModels(providerConfig, ctx);
		case "litellm":
			return discoverLiteLLMModels(providerConfig, ctx);
	}
}

async function discoverOllamaModelMetadata(
	ctx: DiscoveryContext,
	endpoint: string,
	modelId: string,
	headers: Record<string, string> | undefined,
	customTimeoutMs?: number,
): Promise<OllamaDiscoveredModelMetadata | null> {
	const showUrl = `${endpoint}/api/show`;
	try {
		const payload = await withTimeoutSignal(discoveryProbeTimeoutMs(endpoint, 150, customTimeoutMs), async signal => {
			const response = await ctx.fetch(showUrl, {
				method: "POST",
				headers: { ...(headers ?? {}), "Content-Type": "application/json" },
				body: JSON.stringify({ model: modelId }),
				signal,
			});
			if (!response.ok) {
				return null;
			}
			return (await response.json()) as unknown;
		});
		if (!isRecord(payload)) {
			return null;
		}
		const contextWindow = extractOllamaContextWindow(payload);
		const capabilities = payload.capabilities;
		if (Array.isArray(capabilities)) {
			const normalized = new Set(
				capabilities.flatMap(capability => (typeof capability === "string" ? [capability.toLowerCase()] : [])),
			);
			const supportsVision = normalized.has("vision") || normalized.has("image");
			return {
				reasoning: normalized.has("thinking"),
				input: supportsVision ? ["text", "image"] : ["text"],
				contextWindow,
			};
		}
		if (!isRecord(capabilities)) {
			return {
				reasoning: true,
				input: ["text"],
				contextWindow,
			};
		}
		const supportsVision = capabilities.vision === true || capabilities.image === true;
		return {
			reasoning: capabilities.thinking === true,
			input: supportsVision ? ["text", "image"] : ["text"],
			contextWindow,
		};
	} catch {
		return null;
	}
}

export async function discoverOllamaModels(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const endpoint = normalizeOllamaBaseUrl(providerConfig.baseUrl);
	const tagsUrl = `${endpoint}/api/tags`;
	const headers = { ...(providerConfig.headers ?? {}) };
	const customTimeoutMs = providerConfig.discovery.timeoutMs;
	const payload = await withTimeoutSignal(discoveryProbeTimeoutMs(endpoint, 250, customTimeoutMs), async signal => {
		const response = await ctx.fetch(tagsUrl, {
			headers,
			signal,
		});
		if (!response.ok) {
			throw new DiscoveryHttpError(response.status, tagsUrl);
		}
		return (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
	});
	const entries = (payload.models ?? []).flatMap(item => {
		const id = item.model || item.name;
		return id ? [{ id, name: item.name || id }] : [];
	});
	const metadataById = new Map(
		await Promise.all(
			entries.map(
				async entry =>
					[
						entry.id,
						await discoverOllamaModelMetadata(ctx, endpoint, entry.id, headers, customTimeoutMs),
					] as const,
			),
		),
	);
	return entries.map(entry => {
		const metadata = metadataById.get(entry.id);
		return buildModel({
			id: entry.id,
			name: entry.name,
			api: providerConfig.api,
			provider: providerConfig.provider,
			baseUrl: `${endpoint}/v1`,
			reasoning: metadata?.reasoning ?? true,
			input: metadata?.input ?? ["text"],
			imageInputDecoder: "stb",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: metadata?.contextWindow ?? DISCOVERY_DEFAULT_CONTEXT_WINDOW,
			maxTokens: Math.min(metadata?.contextWindow ?? Number.POSITIVE_INFINITY, DISCOVERY_DEFAULT_MAX_TOKENS),
			headers: providerConfig.headers,
		} as ModelSpec<Api>);
	});
}

async function discoverLlamaCppServerMetadata(
	ctx: DiscoveryContext,
	baseUrl: string,
	headers: Record<string, string> | undefined,
	customTimeoutMs?: number,
): Promise<LlamaCppDiscoveredServerMetadata | null> {
	const propsUrl = `${toLlamaCppNativeBaseUrl(baseUrl)}/props`;
	try {
		const payload = await withTimeoutSignal(discoveryProbeTimeoutMs(baseUrl, 150, customTimeoutMs), async signal => {
			const response = await ctx.fetch(propsUrl, {
				headers,
				signal,
			});
			if (!response.ok) {
				return null;
			}
			return (await response.json()) as unknown;
		});
		if (!isRecord(payload)) {
			return null;
		}
		return {
			contextWindow: extractLlamaCppContextWindow(payload),
			maxTokens: extractLlamaCppMaxTokens(payload),
			input: extractLlamaCppInputCapabilities(payload),
		};
	} catch {
		return null;
	}
}

export function applyLlamaCppQwenThinking(model: Model<Api>): Model<Api> {
	if (!isQwenModelId(model.id)) return model;
	return buildModel({
		...model,
		api: "openai-completions",
		baseUrl: model.transport ? model.baseUrl : ensureLlamaCppV1BaseUrl(normalizeLlamaCppBaseUrl(model.baseUrl)),
		reasoning: true,
		compat: {
			...model.compatConfig,
			supportsReasoningParams: true,
			thinkingFormat: "qwen-chat-template",
			reasoningDisableMode: "qwen-template-false",
			qwenPreserveThinking: true,
		},
	} as unknown as ModelSpec<Api>);
}

export const LLAMA_CPP_DEFAULT_BASE_URLS = ["http://127.0.0.1:8080", "http://127.0.0.1:9931"] as const;

export async function discoverLlamaCppModels(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	try {
		return await discoverLlamaCppModelsAt(providerConfig, providerConfig.baseUrl, ctx);
	} catch (primaryError) {
		if (primaryError instanceof DiscoveryHttpError) throw primaryError;
		for (const baseUrl of providerConfig.fallbackBaseUrls ?? []) {
			try {
				return await discoverLlamaCppModelsAt(providerConfig, baseUrl, ctx);
			} catch (error) {
				if (error instanceof DiscoveryHttpError) throw error;
			}
		}
		throw primaryError;
	}
}

async function discoverLlamaCppModelsAt(
	providerConfig: DiscoveryProviderConfig,
	configuredBaseUrl: string | undefined,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const baseUrl = normalizeLlamaCppBaseUrl(configuredBaseUrl);
	const modelsUrl = `${baseUrl}/models`;

	const baseHeaders: Record<string, string> = { ...(providerConfig.headers ?? {}) };
	const customTimeoutMs = providerConfig.discovery.timeoutMs;
	const attempt = async (h: Record<string, string>) => {
		const [payload, metadata] = await Promise.all([
			withTimeoutSignal(discoveryProbeTimeoutMs(baseUrl, 250, customTimeoutMs), async signal => {
				const response = await ctx.fetch(modelsUrl, {
					headers: h,
					signal,
				});
				if (!response.ok) {
					throw new DiscoveryHttpError(response.status, modelsUrl);
				}

				return (await response.json()) as unknown;
			}),
			discoverLlamaCppServerMetadata(ctx, baseUrl, h, customTimeoutMs),
		]);
		return [payload, metadata] as const;
	};
	const apiKey = await ctx.getBearerApiKeyResolver(providerConfig.provider);
	const [payload, serverMetadata] = apiKey
		? await withAuth(apiKey, key => attempt({ ...baseHeaders, Authorization: `Bearer ${key}` }))
		: await attempt(baseHeaders);
	const models = parseLlamaCppModelList(payload);
	const discovered: Model<Api>[] = [];
	for (const item of models) {
		const { id } = item;
		if (!id) continue;
		const contextWindow =
			item.runtimeContextWindow ??
			item.configuredContextWindow ??
			serverMetadata?.contextWindow ??
			item.trainingContextWindow ??
			DISCOVERY_DEFAULT_CONTEXT_WINDOW;

		discovered.push(
			applyLlamaCppQwenThinking(
				buildModel({
					id,
					name: id,
					api: providerConfig.api,
					provider: providerConfig.provider,
					baseUrl: ensureLlamaCppV1BaseUrl(baseUrl),
					reasoning: false,
					input: item.input ?? serverMetadata?.input ?? ["text"],
					imageInputDecoder: "stb",
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow,
					maxTokens: resolveLlamaCppMaxTokens(contextWindow, serverMetadata?.maxTokens),
					headers: baseHeaders,
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
					},
				} as ModelSpec<Api>),
			),
		);
	}
	return discovered;
}

export async function discoverLlamaCppModelRuntimeMetadata(
	model: Pick<Model<Api>, "provider" | "id" | "baseUrl" | "headers">,
	ctx: DiscoveryContext,
	customTimeoutMs?: number,
): Promise<DiscoveredModelRuntimeMetadata | undefined> {
	const baseUrl = normalizeLlamaCppBaseUrl(model.baseUrl);

	const nativeBaseUrl = toLlamaCppNativeBaseUrl(baseUrl);
	const modelsUrl = `${nativeBaseUrl}/models`;
	const baseHeaders: Record<string, string> = { ...(model.headers ?? {}) };
	const attempt = async (headers: Record<string, string>) => {
		const [entries, serverMetadata] = await Promise.all([
			withTimeoutSignal(discoveryProbeTimeoutMs(nativeBaseUrl, 250, customTimeoutMs), async signal => {
				const response = await ctx.fetch(modelsUrl, {
					headers,
					signal,
				});
				if (!response.ok) {
					return undefined;
				}
				return parseLlamaCppModelList(await response.json());
			}),
			discoverLlamaCppServerMetadata(ctx, nativeBaseUrl, headers, customTimeoutMs),
		]);
		if (!entries) {
			return undefined;
		}
		const entry = entries.find(entry => entry.id === model.id);
		if (!entry) {
			return undefined;
		}
		const contextWindow =
			entry.runtimeContextWindow ??
			entry.configuredContextWindow ??
			serverMetadata?.contextWindow ??
			entry.trainingContextWindow;
		const input = entry.input ?? serverMetadata?.input;
		if (contextWindow === undefined) {
			return input === undefined ? undefined : { input };
		}
		return {
			contextWindow,
			maxTokens: resolveLlamaCppMaxTokens(contextWindow, serverMetadata?.maxTokens),
			...(input !== undefined ? { input } : {}),
		};
	};
	try {
		const apiKey = await ctx.getBearerApiKeyResolver(model.provider);
		return apiKey
			? await withAuth(apiKey, key => attempt({ ...baseHeaders, Authorization: `Bearer ${key}` }))
			: await attempt(baseHeaders);
	} catch {
		return undefined;
	}
}

export async function discoverLmStudioModelRuntimeMetadata(
	model: Pick<Model<Api>, "provider" | "id" | "baseUrl" | "headers" | "maxTokens">,
	ctx: DiscoveryContext,
	customTimeoutMs?: number,
): Promise<DiscoveredModelRuntimeMetadata | undefined> {
	const baseUrl = normalizeOpenAIModelsListBaseUrl(model.baseUrl);
	const timeoutMs = customTimeoutMs ?? 10_000;
	const baseHeaders: Record<string, string> = { ...(model.headers ?? {}) };
	const attempt = async (headers: Record<string, string>) => {
		const metadata = await withTimeoutSignal(timeoutMs, signal =>
			fetchLmStudioNativeModelMetadata(baseUrl, ctx.fetch, { headers, signal }),
		);
		const entry = metadata?.get(model.id);
		if (!entry) {
			return undefined;
		}
		const contextWindow = entry.contextWindow;
		if (contextWindow === undefined) {
			return entry.input === undefined ? undefined : { input: entry.input };
		}
		return {
			contextWindow,
			...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
			...(entry.input !== undefined ? { input: entry.input } : {}),
		};
	};
	try {
		const apiKey = await ctx.getBearerApiKeyResolver(model.provider);
		return apiKey
			? await withAuth(apiKey, key => attempt({ ...baseHeaders, Authorization: `Bearer ${key}` }))
			: await attempt(baseHeaders);
	} catch {
		return undefined;
	}
}

function extractOpenAIModelsListInputCapabilities(item: {
	input?: unknown;
	input_modalities?: unknown;
	architecture?: unknown;
	metadata?: unknown;
}): ("text" | "image")[] | undefined {
	const modalities = new Set<string>();
	const collect = (value: unknown): void => {
		if (!Array.isArray(value)) return;
		for (const entry of value) {
			if (typeof entry === "string") modalities.add(entry.toLowerCase());
		}
	};
	collect(item.input);
	collect(item.input_modalities);
	if (isRecord(item.architecture)) collect(item.architecture.input_modalities);
	if (isRecord(item.metadata)) collect(item.metadata.input_modalities);
	if (modalities.size === 0) return undefined;
	return modalities.has("image") ? ["text", "image"] : ["text"];
}

const ADVERTISED_REASONING_EFFORTS: readonly Effort[] = [
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
];

function advertisedReasoningEffort(value: unknown): Effort | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.toLowerCase();
	return (ADVERTISED_REASONING_EFFORTS as readonly string[]).includes(normalized) ? (normalized as Effort) : undefined;
}

/**
 * Parse the requested side of an advertised alias. Any omp level can be
 * requested, `minimal` included, so this reads the full thinking vocabulary;
 * the served side stays on the ladder vocabulary ({@link advertisedReasoningEffort}).
 */
function requestedReasoningEffort(value: string): Effort | undefined {
	const normalized = value.toLowerCase();
	return THINKING_EFFORTS.find(effort => effort === normalized);
}

function extractReasoningLevels(value: unknown): Effort[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const efforts: Effort[] = [];
	for (const entry of value) {
		const effort = isRecord(entry) ? advertisedReasoningEffort(entry.effort) : advertisedReasoningEffort(entry);
		if (effort !== undefined && !efforts.includes(effort)) efforts.push(effort);
	}
	if (efforts.length === 0) return undefined;
	// Report the canonical least-to-most order regardless of wire order.
	efforts.sort(
		(left, right) => ADVERTISED_REASONING_EFFORTS.indexOf(left) - ADVERTISED_REASONING_EFFORTS.indexOf(right),
	);
	return efforts;
}

/**
 * Discovery reads a `/v1/models` row's own reasoning ladder unless the provider
 * opts out with `discovery.advertisedReasoning: false`. An endpoint that
 * advertises tiers its route does not actually accept would otherwise get a
 * picker the wire rejects; opting out falls back to the bundled reference.
 */
function advertisedReasoningEnabled(providerConfig: DiscoveryProviderConfig): boolean {
	return providerConfig.discovery.advertisedReasoning !== false;
}

/** What a `/v1/models` row says about its own reasoning surface. */
type AdvertisedReasoning =
	/** The row states it does not reason. */
	| { kind: "none" }
	/**
	 * The row advertises an effort ladder, whether it also accepts `none`, and
	 * the aliases/lock facts that describe how requests land on it.
	 */
	| {
			kind: "ladder";
			efforts: Effort[];
			acceptsNone: boolean;
			defaultLevel?: Effort;
			effortMap?: Partial<Record<Effort, Effort>>;
			requiresEffort?: boolean;
	  };

/**
 * Read server-advertised reasoning support from an OpenAI-compatible
 * `/v1/models` row. codex-lb nests the Codex registry fields under `metadata`
 * (`supported_reasoning_levels: [{ effort }]`, `default_reasoning_level`);
 * other gateways may advertise the same fields top-level. A gateway that serves
 * a reduced tier set can also name where an unserved request lands
 * (`reasoning_effort_map: { medium: "high" }`) and state that reasoning cannot
 * be turned off (`reasoning_required: true`). Returns undefined when the row
 * says nothing usable about reasoning.
 *
 * An explicit non-reasoning declaration is reported as `{ kind: "none" }`
 * rather than `undefined`: the caller must be able to tell "this endpoint says
 * the model does not reason" (which outranks a reasoning-enabled bundled
 * reference) from "the endpoint is silent" (which leaves the reference in
 * charge). A stray ladder beside `reasoning: false` is ignored.
 */
function extractAdvertisedReasoning(item: {
	metadata?: unknown;
	supported_reasoning_levels?: unknown;
	default_reasoning_level?: unknown;
	reasoning?: unknown;
	reasoning_effort_map?: unknown;
	reasoning_required?: unknown;
}): AdvertisedReasoning | undefined {
	const metadata = isRecord(item.metadata) ? item.metadata : undefined;
	// codex-lb nests every reasoning field under `metadata`; read the denial from
	// the same place the ladder below comes from, or a nested `reasoning: false`
	// would keep the reference dial alive.
	if ((metadata?.reasoning ?? item.reasoning) === false) return { kind: "none" };
	const raw = metadata?.supported_reasoning_levels ?? item.supported_reasoning_levels;
	const efforts = extractReasoningLevels(raw);
	if (efforts === undefined) return undefined;
	const rawDefault = metadata?.default_reasoning_level ?? item.default_reasoning_level;
	const defaultLevel = advertisedReasoningEffort(rawDefault);
	const effortMap = extractReasoningEffortMap(metadata?.reasoning_effort_map ?? item.reasoning_effort_map);
	const requiresEffort = metadata?.reasoning_required ?? item.reasoning_required;
	return {
		kind: "ladder",
		efforts,
		// `none` is the wire off-switch rather than a tier, so it never enters
		// `efforts`; remembering that the endpoint listed it is what lets a
		// thinking-off request send `reasoning_effort: "none"` instead of being
		// clamped to the lowest tier.
		acceptsNone: advisoryEffortEntries(raw).includes("none"),
		...(defaultLevel !== undefined && efforts.includes(defaultLevel) ? { defaultLevel } : {}),
		...(effortMap !== undefined ? { effortMap } : {}),
		// Whether the endpoint rejects disabled or omitted thinking. `true` makes a
		// thinking-off request clamp to a real tier instead of dropping the field;
		// an explicit `false` is kept as well, so it outranks an identity default
		// (thinking-variant ids) that would otherwise lock reasoning on.
		...(typeof requiresEffort === "boolean" ? { requiresEffort } : {}),
	};
}

/** Raw effort strings a row lists, before the `Effort` vocabulary filters them. */
function advisoryEffortEntries(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(entry => {
		const raw = isRecord(entry) ? entry.effort : entry;
		return typeof raw === "string" ? [raw.toLowerCase()] : [];
	});
}

/**
 * Read a row's requested-effort → served-effort aliases. A gateway that serves a
 * reduced tier set states where an unsupported request lands (`{"medium":
 * "high"}` for a route that only accepts low/high/max), which is news neither
 * the ladder nor numeric clamping can produce. Requested keys use the full omp
 * vocabulary (`minimal` included); served values must be ladder tiers. `none` is
 * the off-switch rather than a tier and unknown names (`ultra`) have no omp
 * equivalent, so entries naming them are dropped.
 */
function extractReasoningEffortMap(value: unknown): Partial<Record<Effort, Effort>> | undefined {
	if (!isRecord(value)) return undefined;
	const effortMap: Partial<Record<Effort, Effort>> = {};
	for (const [rawRequested, rawServed] of Object.entries(value)) {
		const requested = requestedReasoningEffort(rawRequested);
		const served = advertisedReasoningEffort(rawServed);
		if (requested !== undefined && served !== undefined) effortMap[requested] = served;
	}
	return Object.keys(effortMap).length > 0 ? effortMap : undefined;
}

/**
 * Apply what the endpoint advertises for one of its own rows. The endpoint
 * states what it accepts on the wire, so its declaration outranks the reference
 * guess: a cross-provider reference carries no thinking at all, and a custom
 * provider's generic ladder drops provider-scoped tiers.
 *
 * OpenAI-shaped rows take the ladder in `effort` mode and drop a borrowed
 * `reasoningEffortMap` / `omitReasoningEffort`, since those describe another
 * host's wire (a reference that omits `reasoning_effort` would otherwise
 * suppress the advertised tier). An advertised `none` sets `none-effort` so a
 * thinking-off request sends the off-switch the endpoint listed rather than
 * the lowest tier.
 *
 * Anthropic-shaped rows keep their identity-derived mode — adaptive vs budget
 * is an Anthropic wire choice — and replace only the tiers.
 */
function withAdvertisedEfforts(
	spec: ModelSpec<Api>,
	advertised: AdvertisedReasoning | undefined,
	isAnthropic: boolean,
): ModelSpec<Api> {
	if (advertised === undefined) return spec;
	if (advertised.kind === "none") return withoutReasoning(spec, isAnthropic);
	// `defaultLevel` is not decoration: `pickInitialThinkingLevel` (sdk.ts) and
	// the model switcher read it ahead of the user's `defaultThinkingLevel`
	// setting, so pinning it to the ladder's first tier would start every gateway
	// model at its lowest effort and reset it on each model switch. Keep a
	// default the ladder actually contains — the row's own, else whatever the
	// catalog rule resolved — and only fall back when it falls outside the ladder.
	// `resolveModelPolicy` already folds the catalog rule's default in, so an
	// absent `advertised.defaultLevel` can still honor a rule default — but only
	// when the ladder contains it. The value is always set, because an absent one
	// would let `fillExplicitThinking` backfill the very level the ladder excludes.
	const inheritedDefault = buildModel(spec).thinking?.defaultLevel;
	const preferredDefault = advertised.defaultLevel ?? inheritedDefault;
	const defaultLevel =
		preferredDefault !== undefined && advertised.efforts.includes(preferredDefault)
			? preferredDefault
			: advertised.efforts[0];
	// `effortMap` / `requiresEffort` travel with the ladder because they are also
	// facts about this row's wire: the map says where an effort the endpoint does
	// not serve lands (a route that only accepts low/high/max answers `medium` as
	// `high`), and the flag says whether the endpoint rejects a thinking-off request.
	// `clampThinkingLevelForModel` reads the map before clamping by distance, and
	// the stream honours the flag.
	const thinking: ThinkingConfig = {
		mode: "effort",
		efforts: advertised.efforts,
		defaultLevel,
		...(advertised.effortMap !== undefined ? { effortMap: advertised.effortMap } : {}),
		...(advertised.requiresEffort !== undefined ? { requiresEffort: advertised.requiresEffort } : {}),
	};
	if (isAnthropic) {
		const mode = buildModel({ ...spec, reasoning: true }).thinking?.mode ?? "budget";
		return { ...spec, reasoning: true, thinking: { ...thinking, mode } };
	}
	return {
		...spec,
		reasoning: true,
		thinking,
		compat: {
			...stripBorrowedEffortCompat(spec),
			supportsReasoningEffort: true,
			...(advertised.acceptsNone ? { reasoningDisableMode: "none-effort" as const } : {}),
		},
	} as ModelSpec<Api>;
}

/**
 * Drop transport facts a bundled reference lent this row, because they describe
 * another host's wire: its `reasoningEffortMap` would rewrite tiers this
 * endpoint declared, and its `omitReasoningEffort` would suppress the very
 * field an advertised ladder enables.
 */
function stripBorrowedEffortCompat(spec: ModelSpec<Api>): OpenAICompat {
	const { reasoningEffortMap: _map, omitReasoningEffort: _omit, ...compat } = (spec.compat ?? {}) as OpenAICompat;
	return compat;
}

/**
 * Drop the reasoning surface for a row whose endpoint declares it does not
 * reason, overriding a reasoning-enabled bundled reference. The row's identity
 * still comes from the reference, but the dial it implied must not survive:
 * a model the deployment cannot reason with must not receive
 * `reasoning_effort`.
 */
function withoutReasoning(spec: ModelSpec<Api>, isAnthropic: boolean): ModelSpec<Api> {
	if (isAnthropic) return { ...spec, reasoning: false, thinking: undefined };
	return {
		...spec,
		reasoning: false,
		thinking: undefined,
		compat: { ...stripBorrowedEffortCompat(spec), supportsReasoningEffort: false },
	} as ModelSpec<Api>;
}

async function discoverOpenAIModelsList(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	// `injectV1: false` resolves `/models` against the configured base URL verbatim so discovery matches
	// the chat base on gateways rooted at a versioned path.
	const baseUrl =
		providerConfig.discovery.injectV1 === false
			? normalizeBareDiscoveryBaseUrl(providerConfig.baseUrl)
			: normalizeOpenAIModelsListBaseUrl(providerConfig.baseUrl);
	const modelsUrl = `${baseUrl}/models`;

	const baseHeaders: Record<string, string> = { ...(providerConfig.headers ?? {}) };
	const timeoutMs = providerConfig.discovery.timeoutMs ?? 10_000;
	const attempt = async (h: Record<string, string>) => {
		const nativeMetadataPromise =
			providerConfig.discovery.type === "lm-studio"
				? withTimeoutSignal(timeoutMs, signal =>
						fetchLmStudioNativeModelMetadata(baseUrl, ctx.fetch, { headers: h, signal }),
					)
				: Promise.resolve(null);
		const [payload, nativeMetadata] = await Promise.all([
			withTimeoutSignal(timeoutMs, async signal => {
				const res = await ctx.fetch(modelsUrl, {
					headers: h,
					signal,
				});
				if (!res.ok) {
					throw new DiscoveryHttpError(res.status, modelsUrl);
				}

				return (await res.json()) as {
					data?: Array<{
						id?: string;
						max_model_len?: unknown;
						context_length?: unknown;
						limits?: unknown;
						input?: unknown;
						input_modalities?: unknown;
						architecture?: unknown;
						mode?: unknown;
						metadata?: unknown;
						max_tokens?: unknown;
						max_output_tokens?: unknown;
						max_completion_tokens?: unknown;
						top_provider?: unknown;
						supported_reasoning_levels?: unknown;
						default_reasoning_level?: unknown;
						reasoning?: unknown;
						reasoning_effort_map?: unknown;
						reasoning_required?: unknown;
						service_tiers?: unknown;
					}>;
				};
			}),
			nativeMetadataPromise,
		]);
		return [payload, nativeMetadata] as const;
	};
	const apiKey = await ctx.getBearerApiKeyResolver(providerConfig.provider);
	const [payload, nativeMetadata] = apiKey
		? await withAuth(apiKey, key => attempt({ ...baseHeaders, Authorization: `Bearer ${key}` }))
		: await attempt(baseHeaders);
	const models = payload.data ?? [];
	const references = getBundledModelReferenceIndex();
	const discovered: Model<Api>[] = [];
	for (const item of models) {
		const id = item.id;
		if (!id) continue;
		if (providerConfig.discovery.type === "litellm" && !isSelectableLiteLLMModelMode(item.mode)) continue;
		const nativeMetadataForModel = nativeMetadata?.get(id);

		const reference = resolveModelReference(id, references) as ModelSpec<Api> | undefined;
		const referenceCompat = reference?.compat as OpenAICompat | undefined;
		const api =
			providerConfig.discovery.type === "litellm"
				? resolveLiteLLMApi(undefined, id, providerConfig.api)
				: providerConfig.api;
		const metadata = isRecord(item.metadata) ? item.metadata : undefined;
		const advertisedName = typeof metadata?.display_name === "string" ? metadata.display_name.trim() : "";
		const limits = isRecord(item.limits) ? item.limits : undefined;
		const maxInputTokens = toTokenLimitOrUndefined(limits?.max_input_tokens);
		const maxOutputTokens = toTokenLimitOrUndefined(limits?.max_output_tokens);
		const reportedLimitsContextWindow =
			maxInputTokens !== undefined &&
			maxOutputTokens !== undefined &&
			Number.isSafeInteger(maxInputTokens) &&
			Number.isSafeInteger(maxOutputTokens) &&
			Number.isSafeInteger(maxInputTokens + maxOutputTokens)
				? maxInputTokens + maxOutputTokens
				: undefined;
		const topProvider = isRecord(item.top_provider) ? item.top_provider : undefined;
		const reportedMaxTokens =
			maxOutputTokens ??
			toTokenLimitOrUndefined(topProvider?.max_completion_tokens) ??
			toTokenLimitOrUndefined(item.max_output_tokens) ??
			toTokenLimitOrUndefined(item.max_completion_tokens) ??
			toTokenLimitOrUndefined(item.max_tokens);
		const contextWindow =
			toPositiveNumberOrUndefined(item.max_model_len) ??
			toPositiveNumberOrUndefined(item.context_length) ??
			toPositiveNumberOrUndefined(metadata?.context_window) ??
			reportedLimitsContextWindow ??
			nativeMetadataForModel?.contextWindow ??
			reference?.contextWindow ??
			DISCOVERY_DEFAULT_CONTEXT_WINDOW;
		discovered.push(
			buildModel(
				withAdvertisedEfforts(
					{
						id,
						name: advertisedName || reference?.name || id,
						serviceTiers: parseServiceTierIds(item.service_tiers) ?? parseServiceTierIds(metadata?.service_tiers),
						api,
						provider: providerConfig.provider,
						baseUrl,
						reasoning: reference?.reasoning ?? true,
						thinking: inheritReferenceThinking(undefined, reference, providerConfig.provider),
						input: nativeMetadataForModel?.input ??
							extractOpenAIModelsListInputCapabilities(item) ??
							reference?.input ?? ["text"],
						...(providerConfig.discovery.type === "lm-studio" ? { imageInputDecoder: "stb" as const } : {}),

						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow,

						maxTokens: Math.min(
							reportedMaxTokens ?? reference?.maxTokens ?? discoveryDefaultMaxTokens(api),
							contextWindow,
						),
						headers: baseHeaders,
						compat: {
							supportsStore: false,
							supportsDeveloperRole: false,
							supportsReasoningEffort: referenceCompat?.supportsReasoningEffort ?? true,
							...(referenceCompat?.reasoningEffortMap
								? { reasoningEffortMap: referenceCompat.reasoningEffortMap }
								: {}),
							...(referenceCompat?.omitReasoningEffort !== undefined
								? { omitReasoningEffort: referenceCompat.omitReasoningEffort }
								: {}),
						},
					} as ModelSpec<Api>,
					advertisedReasoningEnabled(providerConfig) ? extractAdvertisedReasoning(item) : undefined,
					api === "anthropic-messages",
				),
			),
		);
	}
	return discovered;
}

export async function discoverLiteLLMModels(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const baseUrl = normalizeLiteLLMDiscoveryBaseUrl(providerConfig.baseUrl);
	const references = getBundledModelReferenceIndex();
	const resolveReference = (id: string) => resolveModelReference(id, references) as ModelSpec<Api> | undefined;
	const baseHeaders: Record<string, string> = { ...(providerConfig.headers ?? {}) };
	const timeoutMs = providerConfig.discovery.timeoutMs ?? 10_000;
	const attempt = async (h: Record<string, string>) => {
		let authError: DiscoveryHttpError | undefined;
		const authAwareFetch: FetchImpl = async (input, init) => {
			const response = await ctx.fetch(input, init);
			if (response.status === 401) {
				authError = new DiscoveryHttpError(response.status, String(input));
			}
			return response;
		};
		const models = await withTimeoutSignal(timeoutMs, signal =>
			fetchLiteLLMRichModels<Api>({
				api: providerConfig.api,
				provider: providerConfig.provider,
				baseUrl,
				headers: h,
				fetch: authAwareFetch,
				referenceResolver: resolveReference,
				resolveApi: (entry, id) => resolveLiteLLMApi(entry, id, providerConfig.api),
				signal,
			}),
		);
		if (authError && models === null) {
			throw authError;
		}
		return models;
	};
	const apiKey = await ctx.getBearerApiKeyResolver(providerConfig.provider);
	let richModels: ModelSpec<Api>[] | null;
	try {
		richModels = apiKey
			? await withAuth(apiKey, key => attempt({ ...baseHeaders, Authorization: `Bearer ${key}` }))
			: await attempt(baseHeaders);
	} catch {
		// Rich-metadata probes failed (auth, timeout, network). The cheap `/v1/models` fallback runs under
		// its own budget and usually still resolves the catalog; if it also fails, its error propagates.
		richModels = null;
	}
	if (richModels === null) {
		return discoverOpenAIModelsList({ ...providerConfig, baseUrl }, ctx);
	}
	return richModels.map(spec => buildModel({ ...spec, headers: baseHeaders }));
}

async function discoverProxyModels(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const baseUrl = normalizeOpenAIModelsListBaseUrl(providerConfig.baseUrl);
	const modelsUrl = `${baseUrl}/models`;

	const baseHeaders: Record<string, string> = { ...(providerConfig.headers ?? {}) };
	const timeoutMs = providerConfig.discovery.timeoutMs ?? 10_000;
	const attempt = async (h: Record<string, string>) =>
		withTimeoutSignal(timeoutMs, async signal => {
			const res = await ctx.fetch(modelsUrl, {
				headers: h,
				signal,
			});
			if (!res.ok) {
				throw new DiscoveryHttpError(res.status, modelsUrl);
			}

			return (await res.json()) as {
				data?: Array<{
					id?: string;
					name?: string;
					supported_endpoint_types?: string[];
					context_length?: number;
					metadata?: unknown;
					supported_reasoning_levels?: unknown;
					default_reasoning_level?: unknown;
					reasoning?: unknown;
					reasoning_effort_map?: unknown;
					reasoning_required?: unknown;
				}>;
			};
		});
	const apiKey = await ctx.getBearerApiKeyResolver(providerConfig.provider);
	const payload = apiKey
		? await withAuth(apiKey, key => attempt({ ...baseHeaders, Authorization: `Bearer ${key}` }))
		: await attempt(baseHeaders);
	const items = payload.data ?? [];
	const discovered: Model<Api>[] = [];
	for (const item of items) {
		const id = item.id;
		if (!id) continue;
		const endpoints = item.supported_endpoint_types ?? [];
		const api: Api | undefined = endpoints.includes("anthropic")
			? "anthropic-messages"
			: endpoints.includes("openai")
				? "openai-completions"
				: providerConfig.api;
		if (!api) continue;
		const isAnthropic = api === "anthropic-messages";
		const reference = resolveModelReference(id, getBundledModelReferenceIndex());
		const discoveryName = typeof item.name === "string" ? item.name.trim() : "";
		const displayName =
			(discoveryName && discoveryName !== id ? discoveryName : undefined) ??
			reference?.name ??
			stripBracketedModelIdAffixes(id) ??
			id;
		discovered.push(
			buildModel(
				withAdvertisedEfforts(
					{
						id,
						name: displayName,
						api,
						provider: providerConfig.provider,
						baseUrl,
						reasoning: reference?.reasoning ?? true,
						thinking: inheritReferenceThinking(undefined, reference, providerConfig.provider),
						input: reference?.input ?? ["text"],

						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },

						contextWindow:
							toPositiveNumberOrUndefined(item.context_length) ??
							reference?.contextWindow ??
							DISCOVERY_DEFAULT_CONTEXT_WINDOW,
						maxTokens: reference?.maxTokens ?? discoveryDefaultMaxTokens(api),
						headers: baseHeaders,

						compat: isAnthropic
							? undefined
							: {
									supportsStore: false,
									supportsDeveloperRole: false,
									supportsReasoningEffort: true,
								},
					} as ModelSpec<Api>,
					advertisedReasoningEnabled(providerConfig) ? extractAdvertisedReasoning(item) : undefined,
					isAnthropic,
				),
			),
		);
	}
	return discovered;
}

export function normalizeLlamaCppBaseUrl(baseUrl?: string): string {
	const defaultBaseUrl = "http://127.0.0.1:8080";
	const raw = baseUrl || defaultBaseUrl;
	try {
		const parsed = new URL(raw);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		return `${parsed.protocol}//${parsed.host}${trimmedPath}`;
	} catch {
		return raw;
	}
}

export function ensureLlamaCppV1BaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

function toLlamaCppNativeBaseUrl(baseUrl: string): string {
	try {
		const parsed = new URL(baseUrl);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = trimmedPath.endsWith("/v1") ? trimmedPath.slice(0, -3) || "/" : trimmedPath || "/";
		const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
		return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	} catch {
		return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
	}
}

export function normalizeLiteLLMDiscoveryBaseUrl(baseUrl?: string): string {
	return normalizeOpenAIModelsListBaseUrl(baseUrl ?? "http://localhost:4000/v1");
}

function normalizeOpenAIModelsListBaseUrl(baseUrl?: string): string {
	const defaultBaseUrl = "http://127.0.0.1:1234/v1";
	const raw = baseUrl || defaultBaseUrl;
	try {
		const parsed = new URL(raw);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = trimmedPath.endsWith("/v1") ? trimmedPath || "/v1" : `${trimmedPath}/v1`;
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		return raw;
	}
}

/** Configured base URL with trailing slashes, query, and hash dropped; never appends `/v1`. */
export function normalizeBareDiscoveryBaseUrl(baseUrl: string | undefined): string {
	const raw = baseUrl || "http://127.0.0.1:1234";
	try {
		const parsed = new URL(raw);
		return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/g, "")}`;
	} catch {
		return raw.replace(/\/+$/g, "");
	}
}

function normalizeOllamaBaseUrl(baseUrl?: string): string {
	const raw = baseUrl || DEFAULT_OLLAMA_BASE_URL;
	try {
		const parsed = new URL(raw);
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return DEFAULT_OLLAMA_BASE_URL;
	}
}
