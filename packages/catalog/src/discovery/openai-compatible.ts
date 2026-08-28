import { type } from "@oh-my-pi/omptype";
import type { Api, FetchImpl, ModelSpec, Provider } from "../types";
import { discoveryFetch } from "../utils";

const MODELS_PATH = "/models";

export const DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS = 10_000;

async function withOpenAICompatibleDiscoveryTimeout<T>(
	timeoutMs: number,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
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

export interface OpenAICompatibleModelRecord {
	id?: unknown;
	name?: unknown;
	object?: unknown;
	owned_by?: unknown;
	[key: string]: unknown;
}

export interface OpenAICompatibleModelsEnvelope {
	data?: unknown;
	models?: unknown;
	result?: unknown;
	items?: unknown;
	[key: string]: unknown;
}

const openAICompatibleModelRecordSchema = type({
	id: "string >= 1",
	"name?": "string | null",
	"object?": "unknown",
	"owned_by?": "unknown",
});

const openAICompatibleModelsEnvelopeSchema = type({
	"data?": "unknown",
	"models?": "unknown",
	"result?": "unknown",
	"items?": "unknown",
});

const openAICompatibleModelsPayloadSchema = type("unknown[]").or(openAICompatibleModelsEnvelopeSchema);

type ParsedOpenAICompatibleModelRecord = typeof openAICompatibleModelRecordSchema.infer;

export interface OpenAICompatibleModelMapperContext<TApi extends Api> {
	api: TApi;
	provider: Provider;
	baseUrl: string;
}

export interface FetchOpenAICompatibleModelsOptions<TApi extends Api> {
	api: TApi;

	provider: Provider;

	baseUrl: string;

	apiKey?: string;

	headers?: Record<string, string>;

	signal?: AbortSignal;

	timeoutMs?: number;

	fetch?: FetchImpl;

	filterModel?: (entry: OpenAICompatibleModelRecord, model: ModelSpec<TApi>) => boolean;

	mapModel?: (
		entry: OpenAICompatibleModelRecord,
		defaults: ModelSpec<TApi>,
		context: OpenAICompatibleModelMapperContext<TApi>,
	) => ModelSpec<TApi> | null;
}

export async function fetchOpenAICompatibleModels<TApi extends Api>(
	options: FetchOpenAICompatibleModelsOptions<TApi>,
): Promise<ModelSpec<TApi>[] | null> {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	if (!baseUrl) {
		return null;
	}

	const requestHeaders: Record<string, string> = {
		Accept: "application/json",
		...options.headers,
	};
	if (options.apiKey) {
		requestHeaders.Authorization = `Bearer ${options.apiKey}`;
	}

	const fetchImpl = discoveryFetch(options.fetch);
	const fetchPayload = async (signal?: AbortSignal): Promise<unknown | null> => {
		let response: Response;
		try {
			response = await fetchImpl(`${baseUrl}${MODELS_PATH}`, {
				method: "GET",
				headers: requestHeaders,
				signal,
			});
		} catch {
			return null;
		}

		if (!response.ok) {
			return null;
		}

		try {
			return await response.json();
		} catch {
			return null;
		}
	};
	const payload =
		options.signal !== undefined
			? await fetchPayload(options.signal)
			: await withOpenAICompatibleDiscoveryTimeout(
					options.timeoutMs ?? DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS,
					fetchPayload,
				);
	if (payload === null) {
		return null;
	}

	const entries = extractModelEntries(payload);
	if (entries === null) {
		return null;
	}

	const context: OpenAICompatibleModelMapperContext<TApi> = {
		api: options.api,
		provider: options.provider,
		baseUrl,
	};

	const deduped = new Map<string, ModelSpec<TApi>>();
	for (const entry of entries) {
		const defaults: ModelSpec<TApi> = {
			id: entry.id,
			name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
			api: options.api,
			provider: options.provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: null,
		};

		const mapped = options.mapModel ? options.mapModel(entry, defaults, context) : defaults;
		if (!mapped || typeof mapped.id !== "string" || mapped.id.length === 0) {
			continue;
		}
		if (options.filterModel && !options.filterModel(entry, mapped)) {
			continue;
		}
		deduped.set(mapped.id, mapped);
	}

	return Array.from(deduped.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	if (!trimmed) {
		return "";
	}
	return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function extractModelEntries(payload: unknown): ParsedOpenAICompatibleModelRecord[] | null {
	return extractModelEntriesFromNode(payload);
}

function extractModelEntriesFromNode(node: unknown): ParsedOpenAICompatibleModelRecord[] | null {
	const parsedPayload = openAICompatibleModelsPayloadSchema(node);
	if (parsedPayload instanceof type.errors) {
		return null;
	}
	if (Array.isArray(parsedPayload)) {
		const parsedEntries = parsedPayload
			.map(entry => openAICompatibleModelRecordSchema(entry))
			.flatMap(entry => (entry instanceof type.errors ? [] : [entry]));
		return parsedEntries;
	}
	for (const candidate of [parsedPayload.data, parsedPayload.models, parsedPayload.result, parsedPayload.items]) {
		if (candidate === undefined) {
			continue;
		}
		const nested = extractModelEntriesFromNode(candidate);
		if (nested !== null) {
			return nested;
		}
	}

	return null;
}
