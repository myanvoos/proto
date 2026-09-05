import { USER_AGENT } from "@oh-my-pi/pi-utils";
import { parseKnownModel, semverEqual } from "../identity/classify";
import { getBundledModels } from "../models";
import { resolveOpenAIDaybreakStandardCost } from "../openai-pricing";
import type { FetchImpl, LongContextTokenCost, Model, ModelCost, ModelSpec } from "../types";
import { discoveryFetch, isRecord, toNumber, toPositiveNumberOrNull } from "../utils";
import { CODEX_BASE_URL } from "../wire/codex";

export const PI_CATALOG_BASE_URL = "https://pi.dev";
export const PI_CODEX_CATALOG_URL = `${PI_CATALOG_BASE_URL}/api/models/providers/openai-codex`;

const DEFAULT_CONTEXT_WINDOW = 272_000;
const DEFAULT_MAX_TOKENS = 128_000;

const GPT_5_6_CONTEXT_WINDOW = 372_000;

const GPT_5_6_1M_CONTEXT_WINDOW = 1_000_000;
const CODEX_GPT_5_6_1M_SLUGS: ReadonlySet<string> = new Set(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);

const CODEX_WORKER_SUFFIX = "-wm";
const CODEX_REMOTE_COMPACTION = {
	enabled: true,
	api: "openai-codex-responses",
	v2StreamingEnabled: true,
} as const;

export interface CodexModelDiscoveryOptions {
	catalogUrl?: string;

	signal?: AbortSignal;

	fetchFn?: FetchImpl;
}

export interface CodexModelDiscoveryResult {
	models: ModelSpec<"openai-codex-responses">[];
	etag?: string;
}

export async function fetchCodexModels(
	options: CodexModelDiscoveryOptions = {},
): Promise<CodexModelDiscoveryResult | null> {
	const fetchFn = discoveryFetch(options.fetchFn);
	const catalogUrl = normalizeCatalogUrl(options.catalogUrl);
	let response: Response;
	try {
		response = await fetchFn(catalogUrl, {
			method: "GET",
			headers: {
				Accept: "application/json",
				"User-Agent": USER_AGENT,
			},
			signal: options.signal,
		});
	} catch {
		return null;
	}

	if (!response.ok) {
		return null;
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return null;
	}

	const models = normalizeCodexModels(payload);
	if (models === null || models.length === 0) {
		return null;
	}

	const etag = getResponseEtag(response.headers);
	return etag ? { models, etag } : { models };
}

function normalizeCatalogUrl(value: string | undefined): string {
	const raw = value?.trim() || PI_CODEX_CATALOG_URL;
	try {
		return new URL(raw).toString();
	} catch {
		return PI_CODEX_CATALOG_URL;
	}
}

function normalizeCodexModels(payload: unknown): ModelSpec<"openai-codex-responses">[] | null {
	const entries = extractCatalogEntries(payload);
	if (entries === null) {
		return null;
	}

	const parsedEntries: ParsedCodexModelEntry[] = [];
	for (const entry of entries) {
		const parsed = parseCodexModelEntry(entry);
		if (parsed) {
			parsedEntries.push(parsed);
		}
	}

	const advertisedSlugs = new Set(parsedEntries.map(parsed => parsed.slug));
	const bundledCodexModelIds = getBundledCodexModelIds();
	const normalized: NormalizedCodexModel[] = [];
	for (const parsed of parsedEntries) {
		const canonicalSlug = plainCounterpartForWorkerSlug(parsed.slug, bundledCodexModelIds) ?? parsed.slug;
		normalized.push(buildNormalizedCodexModel(parsed, parsed.slug, canonicalSlug));
		const plainSlug = canonicalSlug !== parsed.slug ? canonicalSlug : null;
		if (plainSlug && !advertisedSlugs.has(plainSlug)) {
			normalized.push(buildNormalizedCodexModel(parsed, plainSlug, canonicalSlug));
		}
	}

	normalized.sort((left, right) => {
		if (left.priority !== right.priority) {
			return left.priority - right.priority;
		}
		return left.model.id.localeCompare(right.model.id);
	});

	return normalized.map(item => item.model);
}

function extractCatalogEntries(payload: unknown): unknown[] | null {
	if (Array.isArray(payload)) {
		return payload;
	}
	if (!isRecord(payload)) {
		return null;
	}

	const models = payload.models;
	if (Array.isArray(models)) {
		return models;
	}
	return Object.values(payload);
}

function getBundledCodexModelIds(): ReadonlySet<string> {
	const ids = new Set(getBundledModels("openai-codex").map(model => model.id));
	return ids;
}

function plainCounterpartForWorkerSlug(slug: string, bundledCodexModelIds: ReadonlySet<string>): string | null {
	if (!slug.endsWith(CODEX_WORKER_SUFFIX)) {
		return null;
	}
	const plain = slug.slice(0, -CODEX_WORKER_SUFFIX.length);
	return plain.length > 0 && bundledCodexModelIds.has(plain) ? plain : null;
}

interface NormalizedCodexModel {
	model: ModelSpec<"openai-codex-responses">;
	priority: number;
}

interface ParsedCodexModelEntry {
	slug: string;
	name: string;
	baseUrl: string;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean;
	input: ("text" | "image" | "audio" | "video")[];
	cost: ModelCost;
	preferWebsockets: boolean;
	useResponsesLite: boolean;
	toolMode: boolean;
	priority: number;
}

function parseCodexModelEntry(entry: unknown): ParsedCodexModelEntry | null {
	if (!isRecord(entry)) {
		return null;
	}

	const slug = toNonEmptyString(entry.id) ?? toNonEmptyString(entry.slug);
	if (!slug) {
		return null;
	}

	const api = toNonEmptyString(entry.api);
	if (api !== null && api !== "openai-codex-responses") {
		return null;
	}

	const visibility = toNonEmptyString(entry.visibility)?.toLowerCase();
	if (visibility === "hide" || visibility === "hidden") {
		return null;
	}

	return {
		slug,
		name: toNonEmptyString(entry.name) ?? slug,
		baseUrl: toNonEmptyString(entry.baseUrl) ?? CODEX_BASE_URL,
		contextWindow: toPositiveNumberOrNull(entry.contextWindow),
		maxTokens: toPositiveNumberOrNull(entry.maxTokens),
		reasoning: entry.reasoning === true || hasThinkingLevels(entry.thinkingLevelMap),
		input: normalizeInputModalities(entry.input),
		cost: normalizeModelCost(entry.cost),
		preferWebsockets: entry.preferWebsockets !== false,
		useResponsesLite: entry.useResponsesLite === true,
		toolMode: entry.toolMode === "code_mode_only" || entry.tool_mode === "code_mode_only",
		priority: toFiniteNumber(entry.priority) ?? Number.MAX_SAFE_INTEGER,
	};
}

function buildNormalizedCodexModel(
	parsed: ParsedCodexModelEntry,
	slug: string,
	canonicalSlug: string,
): NormalizedCodexModel {
	const bundledModel = getBundledModels("openai-codex").find(model => model.id === slug) as
		| Model<"openai-codex-responses">
		| undefined;
	const parsedKnown = parseKnownModel(canonicalSlug);
	const fallbackContextWindow =
		parsedKnown.family === "openai" && semverEqual(parsedKnown.version, "5.6")
			? GPT_5_6_CONTEXT_WINDOW
			: DEFAULT_CONTEXT_WINDOW;
	const reportedContextWindow = parsed.contextWindow ?? fallbackContextWindow;
	const contextWindow = CODEX_GPT_5_6_1M_SLUGS.has(canonicalSlug)
		? Math.max(reportedContextWindow, GPT_5_6_1M_CONTEXT_WINDOW)
		: reportedContextWindow;
	const maxTokens = Math.min(DEFAULT_MAX_TOKENS, parsed.maxTokens ?? contextWindow);
	const daybreakCost = resolveOpenAIDaybreakStandardCost(canonicalSlug);
	const cost = hasBillableCost(parsed.cost) ? parsed.cost : (daybreakCost ?? parsed.cost);

	return {
		priority: parsed.priority,
		model: {
			id: slug,
			name: parsed.name,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: parsed.baseUrl,
			reasoning: parsed.reasoning,
			input: parsed.input,
			cost,
			remoteCompaction: CODEX_REMOTE_COMPACTION,
			contextWindow,
			maxTokens,
			preferWebsockets: parsed.preferWebsockets,
			...(parsed.useResponsesLite || bundledModel?.useResponsesLite ? { useResponsesLite: true } : {}),
			...(parsed.toolMode || bundledModel?.toolMode ? { toolMode: "code_mode_only" as const } : {}),
			...(parsed.priority !== Number.MAX_SAFE_INTEGER
				? { priority: parsed.priority }
				: bundledModel?.priority !== undefined
					? { priority: bundledModel.priority }
					: {}),
			...(bundledModel?.applyPatchToolType ? { applyPatchToolType: bundledModel.applyPatchToolType } : {}),
			...(bundledModel?.compatConfig ? { compat: bundledModel.compatConfig } : {}),
		},
	};
}

function hasThinkingLevels(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}
	return Object.keys(value).some(key => key !== "off");
}

function normalizeInputModalities(value: unknown): ("text" | "image" | "audio" | "video")[] {
	if (!Array.isArray(value)) {
		return ["text"];
	}

	const supported = new Set<"text" | "image" | "audio" | "video">();
	for (const modality of value) {
		const normalized = toNonEmptyString(modality)?.toLowerCase();
		if (normalized === "text" || normalized === "image" || normalized === "audio" || normalized === "video") {
			supported.add(normalized);
		}
	}

	if (supported.size === 0) {
		return ["text"];
	}

	const canonical: ("text" | "image" | "audio" | "video")[] = ["text", "image", "audio", "video"];
	return canonical.filter(modality => supported.has(modality));
}

function normalizeModelCost(value: unknown): ModelCost {
	const source = isRecord(value) ? value : {};
	const cost: ModelCost = {
		input: toNonNegativeNumber(source.input) ?? 0,
		output: toNonNegativeNumber(source.output) ?? 0,
		cacheRead: toNonNegativeNumber(source.cacheRead) ?? 0,
		cacheWrite: toNonNegativeNumber(source.cacheWrite) ?? 0,
	};

	const longContext = normalizeLongContextCost(source.tiers, cost);
	if (longContext) {
		cost.longContext = longContext;
	}
	return cost;
}

function normalizeLongContextCost(value: unknown, fallback: ModelCost): LongContextTokenCost | undefined {
	const candidates: unknown[] = Array.isArray(value) ? value : [];
	let selected: LongContextTokenCost | undefined;
	for (const candidate of candidates) {
		if (!isRecord(candidate)) {
			continue;
		}
		const inputThreshold = toPositiveNumberOrNull(candidate.inputTokensAbove);
		if (inputThreshold === null) {
			continue;
		}
		const tier: LongContextTokenCost = {
			inputThreshold,
			input: toNonNegativeNumber(candidate.input) ?? fallback.input,
			output: toNonNegativeNumber(candidate.output) ?? fallback.output,
			cacheRead: toNonNegativeNumber(candidate.cacheRead) ?? fallback.cacheRead,
			cacheWrite: toNonNegativeNumber(candidate.cacheWrite) ?? fallback.cacheWrite,
		};
		if (!selected || tier.inputThreshold > selected.inputThreshold) {
			selected = tier;
		}
	}
	return selected;
}

function hasBillableCost(cost: ModelCost): boolean {
	return (
		cost.input !== 0 ||
		cost.output !== 0 ||
		cost.cacheRead !== 0 ||
		cost.cacheWrite !== 0 ||
		cost.longContext !== undefined
	);
}

function getResponseEtag(headers: Headers): string | undefined {
	const etag = headers.get("etag");
	if (!etag) {
		return undefined;
	}
	const trimmed = etag.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function toNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function toFiniteNumber(value: unknown): number | null {
	const parsed = toNumber(value);
	return parsed !== undefined && Number.isFinite(parsed) ? parsed : null;
}

function toNonNegativeNumber(value: unknown): number | undefined {
	const parsed = toNumber(value);
	return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}
