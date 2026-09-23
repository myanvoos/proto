/**
 * Catalog metric lookup (intelligence / speed scores) across provider id
 * dialects. The shared catalog scores a model once under its vendor id
 * (`claude-fable-5-1`); hosts re-spell it (`anthropic/claude-fable-5.1`,
 * `global.anthropic.claude-fable-5-1`, `claude-fable-5-1-high`), so an index
 * keyed by exact id leaves most of the picker blank.
 *
 * Resolution order, first hit wins:
 * 1. exact lowercased id;
 * 2. candidate ids derived from the wire id (namespace and dotted vendor/region
 *    prefixes, bracket affixes, date/`vN:0` suffixes, trailing markers)
 *    compared on a dot/colon-folded bare name, accepted only when the parsed
 *    identities agree.
 */
import type { Api, Model } from "../types";
import { bareModelId, type ParsedModel, parseKnownModel } from "./classify";
import { getReferenceCandidateIds } from "./reference";

/** Catalog-delivered intelligence score and output speed for one model. */
export interface CatalogMetrics {
	int?: number;
	tps?: number;
}

interface ScoredEntry extends CatalogMetrics {
	id: string;
}

/** Trailing tokens Bedrock-style ids append without changing the model: `-v1:0`, `-v2`, `:0`, `-20251001`, `-2026-04-23`. */
const STRIPPABLE_SUFFIX_PATTERN = /(?:-v\d+(?::\d+)?|:\d+|-\d{2,})$/;
/** Leading alphabetic dotted namespaces: `global.anthropic.`, `us-gov.`, `openai.`. */
const DOTTED_PREFIX_PATTERN = /^[a-z][a-z-]*\./;
const THINKING_VARIANT_PATTERN = /[-:]thinking$/i;

function canonicalKey(id: string): string {
	return bareModelId(id).toLowerCase().replace(/[.:]/g, "-");
}

function parsedIdentityKey(parsed: ParsedModel): string | undefined {
	if (parsed.family === "unknown") return undefined;
	return JSON.stringify(parsed);
}

/**
 * Whether a dialect-matched scored row may describe `modelId`: thinking lanes never borrow a
 * non-thinking score, and ids the classifier recognizes must parse to the same product line.
 */
function identitiesAgree(modelId: string, scoredId: string): boolean {
	if (THINKING_VARIANT_PATTERN.test(modelId) !== THINKING_VARIANT_PATTERN.test(scoredId)) return false;
	const modelKey = parsedIdentityKey(parseKnownModel(bareModelId(modelId).toLowerCase()));
	const scoredKey = parsedIdentityKey(parseKnownModel(bareModelId(scoredId).toLowerCase()));
	return modelKey === undefined || scoredKey === undefined || modelKey === scoredKey;
}

/** The catalog metrics a model carries, or undefined when it reports none. A zero speed is "unmeasured", not a score. */
export function catalogMetricsOf(model: Model<Api>): CatalogMetrics | undefined {
	const int = model.int != null && Number.isFinite(model.int) ? model.int : undefined;
	const tps = model.tps != null && Number.isFinite(model.tps) && model.tps > 0 ? model.tps : undefined;
	if (int === undefined && tps === undefined) return undefined;
	return { ...(int !== undefined ? { int } : {}), ...(tps !== undefined ? { tps } : {}) };
}

// Wire ids form a bounded set (bundled + discovered), so no eviction is needed.
const candidateCache = new Map<string, string[]>();

/** Candidate ids for `modelId`, least-stripped first, each already canonical-keyed. */
function metricCandidateKeys(modelId: string): string[] {
	const cached = candidateCache.get(modelId);
	if (cached) return cached;
	const keys: string[] = [];
	const seen = new Set<string>();
	const queue = getReferenceCandidateIds(modelId);
	for (let index = 0; index < queue.length; index++) {
		const candidate = queue[index].toLowerCase();
		const key = canonicalKey(candidate);
		if (!seen.has(key)) {
			seen.add(key);
			keys.push(key);
		}
		const bare = bareModelId(candidate);
		const withoutPrefix = bare.replace(DOTTED_PREFIX_PATTERN, "");
		if (withoutPrefix !== bare && withoutPrefix.length > 0) queue.push(withoutPrefix);
		const withoutSuffix = bare.replace(STRIPPABLE_SUFFIX_PATTERN, "");
		if (withoutSuffix !== bare && withoutSuffix.length > 0) queue.push(withoutSuffix);
	}
	candidateCache.set(modelId, keys);
	return keys;
}

/**
 * Index of catalog metrics over every scored model seen so far. Built per
 * discovery cycle by the model registry and per provider by the model manager;
 * `add` accumulates across providers so a proxy id resolves against any host's
 * scored row.
 */
export class CatalogMetricsIndex {
	#exact = new Map<string, CatalogMetrics>();
	#canonical = new Map<string, ScoredEntry>();

	constructor(models?: Iterable<Model<Api>>) {
		if (models) this.add(models);
	}

	get isEmpty(): boolean {
		return this.#exact.size === 0;
	}

	/** Record the metrics of every scored model; later rows fill fields earlier rows left unset. */
	add(models: Iterable<Model<Api>>): void {
		for (const model of models) {
			const metrics = catalogMetricsOf(model);
			if (!metrics) continue;
			const exactKey = model.id.toLowerCase();
			const existing = this.#exact.get(exactKey);
			this.#exact.set(exactKey, existing ? { ...metrics, ...existing } : metrics);

			const canonical = canonicalKey(model.id);
			const scored = this.#canonical.get(canonical);
			if (!scored) this.#canonical.set(canonical, { ...metrics, id: model.id });
			else if (scored.int === undefined || scored.tps === undefined) {
				this.#canonical.set(canonical, { ...metrics, ...scored });
			}
		}
	}

	/** Metrics for `model` by exact id, else by dialect-normalized id when the parsed identities agree. */
	resolve(model: Model<Api>): CatalogMetrics | undefined {
		const exact = this.#exact.get(model.id.toLowerCase());
		if (exact) return exact;
		for (const key of metricCandidateKeys(model.id)) {
			const scored = this.#canonical.get(key);
			if (scored && identitiesAgree(model.id, scored.id)) {
				return {
					...(scored.int !== undefined ? { int: scored.int } : {}),
					...(scored.tps !== undefined ? { tps: scored.tps } : {}),
				};
			}
		}
		return undefined;
	}
}

/**
 * Fill each model's `int`/`tps` from `index`. Returns the input array when no
 * model changed so callers can keep identity-based caches.
 */
export function applyCatalogMetrics<TApi extends Api>(
	models: Model<TApi>[],
	index: CatalogMetricsIndex,
): Model<TApi>[] {
	if (index.isEmpty) return models;
	let changed: Model<TApi>[] | undefined;
	for (let position = 0; position < models.length; position++) {
		const model = models[position];
		if (model.int != null && model.tps != null) continue;
		const metrics = index.resolve(model);
		if (!metrics) continue;
		const int = metrics.int ?? model.int;
		const tps = metrics.tps ?? model.tps;
		if (int === model.int && tps === model.tps) continue;
		changed ??= [...models];
		changed[position] = {
			...model,
			...(int != null ? { int } : {}),
			...(tps != null ? { tps } : {}),
		};
	}
	return changed ?? models;
}
