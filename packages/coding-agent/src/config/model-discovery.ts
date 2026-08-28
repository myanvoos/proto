import { type ApiKey, type FetchImpl, withAuth } from "@oh-my-pi/pi-ai";
import type { Api, Model, RemoteCompactionConfig } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
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
	OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW,
	OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS,
	resolveLiteLLMApi,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec, OpenAICompat } from "@oh-my-pi/pi-catalog/types";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ProviderDiscovery } from "./models-config-schema";

const DISCOVERY_DEFAULT_CONTEXT_WINDOW = OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW;
export const DISCOVERY_DEFAULT_MAX_TOKENS = OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS;

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
				reasoning: false,
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
			throw new Error(`HTTP ${response.status} from ${tagsUrl}`);
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
			reasoning: metadata?.reasoning ?? false,
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

function isBonsaiQwenGguf(id: string): boolean {
	return /(?:ternary-)?bonsai-27b/i.test(id);
}

export function applyLlamaCppQwenThinking(model: Model<Api>): Model<Api> {
	if (!isQwenModelId(model.id) && !isBonsaiQwenGguf(model.id)) return model;
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

export async function discoverLlamaCppModels(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const baseUrl = normalizeLlamaCppBaseUrl(providerConfig.baseUrl);
	const modelsUrl = `${baseUrl}/models`;

	const baseHeaders: Record<string, string> = { ...(providerConfig.headers ?? {}) };
	let headers = baseHeaders;
	const customTimeoutMs = providerConfig.discovery.timeoutMs;
	const attempt = async (h: Record<string, string>) => {
		const [payload, metadata] = await Promise.all([
			withTimeoutSignal(discoveryProbeTimeoutMs(baseUrl, 250, customTimeoutMs), async signal => {
				const response = await ctx.fetch(modelsUrl, {
					headers: h,
					signal,
				});
				if (!response.ok) {
					throw new Error(`HTTP ${response.status} from ${modelsUrl}`);
				}
				headers = h;
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
					headers,
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
	if (modalities.size === 0) return undefined;
	return modalities.has("image") ? ["text", "image"] : ["text"];
}

async function discoverOpenAIModelsList(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const baseUrl = normalizeOpenAIModelsListBaseUrl(providerConfig.baseUrl);
	const modelsUrl = `${baseUrl}/models`;

	const baseHeaders: Record<string, string> = { ...(providerConfig.headers ?? {}) };
	let headers = baseHeaders;
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
					throw new Error(`HTTP ${res.status} from ${modelsUrl}`);
				}
				headers = h;
				return (await res.json()) as {
					data?: Array<{
						id?: string;
						max_model_len?: unknown;
						context_length?: unknown;
						input?: unknown;
						input_modalities?: unknown;
						architecture?: unknown;
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
		const nativeMetadataForModel = nativeMetadata?.get(id);

		const reference = resolveModelReference(id, references) as ModelSpec<Api> | undefined;
		const referenceCompat = reference?.compat as OpenAICompat | undefined;
		const api =
			providerConfig.discovery.type === "litellm"
				? resolveLiteLLMApi(undefined, id, providerConfig.api)
				: providerConfig.api;
		const contextWindow =
			toPositiveNumberOrUndefined(item.max_model_len) ??
			toPositiveNumberOrUndefined(item.context_length) ??
			nativeMetadataForModel?.contextWindow ??
			reference?.contextWindow ??
			DISCOVERY_DEFAULT_CONTEXT_WINDOW;
		discovered.push(
			buildModel({
				id,
				name: reference?.name ?? id,
				api,
				provider: providerConfig.provider,
				baseUrl,
				reasoning: reference?.reasoning ?? false,
				thinking: inheritReferenceThinking(undefined, reference, providerConfig.provider),
				input: nativeMetadataForModel?.input ??
					extractOpenAIModelsListInputCapabilities(item) ??
					reference?.input ?? ["text"],
				...(providerConfig.discovery.type === "lm-studio" ? { imageInputDecoder: "stb" as const } : {}),

				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow,

				maxTokens: Math.min(reference?.maxTokens ?? discoveryDefaultMaxTokens(api), contextWindow),
				headers,
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: referenceCompat?.supportsReasoningEffort ?? false,
					...(referenceCompat?.reasoningEffortMap
						? { reasoningEffortMap: referenceCompat.reasoningEffortMap }
						: {}),
					...(referenceCompat?.omitReasoningEffort !== undefined
						? { omitReasoningEffort: referenceCompat.omitReasoningEffort }
						: {}),
				},
			} as ModelSpec<Api>),
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
	let headers = baseHeaders;
	const timeoutMs = providerConfig.discovery.timeoutMs ?? 10_000;
	const attempt = async (h: Record<string, string>) => {
		headers = h;
		let authError: (Error & { status: number }) | undefined;
		const authAwareFetch: FetchImpl = async (input, init) => {
			const response = await ctx.fetch(input, init);
			if (response.status === 401) {
				authError = new Error(`HTTP ${response.status} from ${String(input)}`) as Error & { status: number };
				authError.status = response.status;
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
	} catch (error) {
		const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
		if (status !== 401) {
			throw error;
		}
		richModels = null;
	}
	if (!richModels || richModels.length === 0) {
		return discoverOpenAIModelsList({ ...providerConfig, baseUrl }, ctx);
	}
	return richModels.map(spec => buildModel({ ...spec, headers }));
}

async function discoverProxyModels(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const baseUrl = normalizeOpenAIModelsListBaseUrl(providerConfig.baseUrl);
	const modelsUrl = `${baseUrl}/models`;

	const baseHeaders: Record<string, string> = { ...(providerConfig.headers ?? {}) };
	let headers = baseHeaders;
	const timeoutMs = providerConfig.discovery.timeoutMs ?? 10_000;
	const attempt = async (h: Record<string, string>) =>
		withTimeoutSignal(timeoutMs, async signal => {
			const res = await ctx.fetch(modelsUrl, {
				headers: h,
				signal,
			});
			if (!res.ok) {
				throw new Error(`HTTP ${res.status} from ${modelsUrl}`);
			}
			headers = h;
			return (await res.json()) as {
				data?: Array<{ id?: string; name?: string; supported_endpoint_types?: string[]; context_length?: number }>;
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
			buildModel({
				id,
				name: displayName,
				api,
				provider: providerConfig.provider,
				baseUrl,
				reasoning: reference?.reasoning ?? false,
				thinking: inheritReferenceThinking(undefined, reference, providerConfig.provider),
				input: reference?.input ?? ["text"],

				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },

				contextWindow:
					toPositiveNumberOrUndefined(item.context_length) ??
					reference?.contextWindow ??
					DISCOVERY_DEFAULT_CONTEXT_WINDOW,
				maxTokens: reference?.maxTokens ?? discoveryDefaultMaxTokens(api),
				headers,

				compat: isAnthropic
					? undefined
					: {
							supportsStore: false,
							supportsDeveloperRole: false,
							supportsReasoningEffort: false,
						},
			} as ModelSpec<Api>),
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

function normalizeOllamaBaseUrl(baseUrl?: string): string {
	const raw = baseUrl || DEFAULT_OLLAMA_BASE_URL;
	try {
		const parsed = new URL(raw);
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return DEFAULT_OLLAMA_BASE_URL;
	}
}
