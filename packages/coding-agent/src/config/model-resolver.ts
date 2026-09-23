import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, KnownProvider, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { modelMatchesHost } from "@oh-my-pi/pi-catalog/hosts";
import { buildModelProviderPriorityRank } from "@oh-my-pi/pi-catalog/identity";
import { stripThinkingVariantToken } from "@oh-my-pi/pi-catalog/identity/family";
import { type GeneratedProvider, getBundledModels, modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models";
import { resolveBareVariantAlias, resolveVariantAlias } from "@oh-my-pi/pi-catalog/variant-collapse";
import { fuzzyMatch } from "@oh-my-pi/pi-tui/fuzzy";
import { logger } from "@oh-my-pi/pi-utils";
import MODEL_PRIO from "../priority.json" with { type: "json" };
import { parseThinkingLevel, resolveThinkingLevelForModel } from "../thinking";
import { isAuthenticated, kNoAuth, type ModelRegistry } from "./model-registry";
import {
	DEFAULT_MODEL_ROLE_ALIAS,
	formatModelRoleAlias,
	getKnownRoleIds,
	LEGACY_MODEL_ROLE_ALIAS_PREFIX,
	MODEL_ROLE_ALIAS_PREFIX,
	MODEL_ROLE_IDS,
	type ModelRole,
} from "./model-roles";
import type { Settings } from "./settings";

function isKnownProvider(provider: string): provider is KnownProvider {
	return provider in DEFAULT_MODEL_PER_PROVIDER;
}

/**
 * With `hasConcreteCredential`, candidates narrow to concretely-authed providers when any exist, so an
 * ambient Bedrock/Vertex credential source never wins the startup default over the provider the user
 * signed into; a provider that is the only credentialed option is still picked.
 */
export function pickDefaultAvailableModel(
	availableModels: Model<Api>[],
	hasConcreteCredential?: (provider: string) => boolean,
): Model<Api> | undefined {
	let models = availableModels;
	if (hasConcreteCredential) {
		const concreteByProvider = new Map<string, boolean>();
		const concrete = availableModels.filter(model => {
			let isConcrete = concreteByProvider.get(model.provider);
			if (isConcrete === undefined) {
				isConcrete = hasConcreteCredential(model.provider);
				concreteByProvider.set(model.provider, isConcrete);
			}
			return isConcrete;
		});
		if (concrete.length > 0) models = concrete;
	}
	const firstDefault = models.find(
		model => isKnownProvider(model.provider) && DEFAULT_MODEL_PER_PROVIDER[model.provider] === model.id,
	);
	if (!firstDefault) return models[0];

	const providerPriority = buildModelProviderPriorityRank();
	const sharedDefaultMatches = models.filter(
		model =>
			model.id === firstDefault.id &&
			isKnownProvider(model.provider) &&
			DEFAULT_MODEL_PER_PROVIDER[model.provider] === model.id,
	);
	return [...sharedDefaultMatches].sort((a, b) => {
		const aRank = providerPriority.get(a.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		const bRank = providerPriority.get(b.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		if (aRank !== bRank) return aRank - bRank;
		return models.indexOf(a) - models.indexOf(b);
	})[0];
}

export interface ScopedModel {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	explicitThinkingLevel: boolean;
}

interface ThinkingSuffixOptions {
	allowMaxSuffix?: boolean;
}

interface ModelStringParseOptions extends ThinkingSuffixOptions {
	isLiteralModelId?: (provider: string, id: string) => boolean;
}

const MAX_THINKING_SUFFIX_OPTIONS: ThinkingSuffixOptions = { allowMaxSuffix: true };

function parseThinkingSuffix(value: string, options?: ThinkingSuffixOptions): ThinkingLevel | undefined {
	const level = parseThinkingLevel(value);
	if (level === ThinkingLevel.Max) return options?.allowMaxSuffix === true ? level : undefined;
	return level;
}

function splitThinkingSuffix(
	pattern: string,
	minColonIndex = -1,
	options?: ThinkingSuffixOptions,
): { base: string; level?: ThinkingLevel } {
	const colonIdx = pattern.lastIndexOf(":");
	if (colonIdx <= minColonIndex) return { base: pattern };
	const level = parseThinkingSuffix(pattern.slice(colonIdx + 1), options);
	return level ? { base: pattern.slice(0, colonIdx), level } : { base: pattern };
}

function matchingGlobModels(pattern: string, availableModels: readonly Model<Api>[]): Model<Api>[] {
	const glob = new Bun.Glob(pattern.toLowerCase());
	return availableModels.filter(model => {
		const fullId = `${model.provider}/${model.id}`;
		return glob.match(fullId.toLowerCase()) || glob.match(model.id.toLowerCase());
	});
}

function resolveGlobScopePattern(
	pattern: string,
	availableModels: readonly Model<Api>[],
): { models: Model<Api>[]; thinkingLevel?: ThinkingLevel; explicitThinkingLevel: boolean } {
	const strictSuffix = splitThinkingSuffix(pattern);
	if (strictSuffix.level !== undefined) {
		const thinkingLevel = strictSuffix.level;
		return {
			models: matchingGlobModels(strictSuffix.base, availableModels),
			thinkingLevel,
			explicitThinkingLevel: thinkingLevel !== undefined,
		};
	}

	const maxSuffix = splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS);
	if (maxSuffix.level !== undefined) {
		const literalMatches = matchingGlobModels(pattern, availableModels);
		if (literalMatches.length > 0) {
			return { models: literalMatches, thinkingLevel: undefined, explicitThinkingLevel: false };
		}
		const thinkingLevel = maxSuffix.level;
		return {
			models: matchingGlobModels(maxSuffix.base, availableModels),
			thinkingLevel,
			explicitThinkingLevel: thinkingLevel !== undefined,
		};
	}

	return {
		models: matchingGlobModels(pattern, availableModels),
		thinkingLevel: undefined,
		explicitThinkingLevel: false,
	};
}

export function parseModelString(
	modelStr: string,
	options?: ModelStringParseOptions,
): { provider: string; id: string; thinkingLevel?: ThinkingLevel } | undefined {
	const slashIdx = modelStr.indexOf("/");
	if (slashIdx <= 0) return undefined;
	const id = modelStr.slice(slashIdx + 1);
	const provider = modelStr.slice(0, slashIdx);

	const strict = splitThinkingSuffix(id);
	if (strict.level) return { provider, id: strict.base, thinkingLevel: strict.level };

	const maxAlias = splitThinkingSuffix(id, -1, options);
	if (maxAlias.level) {
		return options?.isLiteralModelId?.(provider, id) === true
			? { provider, id }
			: { provider, id: maxAlias.base, thinkingLevel: maxAlias.level };
	}
	return { provider, id };
}

export function formatModelString(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function getSingleRoutingOnly(routing: unknown): string | undefined {
	if (!routing || typeof routing !== "object" || !("only" in routing) || !Array.isArray(routing.only)) {
		return undefined;
	}
	if (routing.only.length !== 1) return undefined;
	const upstream = routing.only[0];
	return typeof upstream === "string" && upstream ? upstream : undefined;
}

function getSingleUpstreamRoute(model: Model<Api>): string | undefined {
	const compat = model.compat;
	if (!compat || typeof compat !== "object") return undefined;
	if (modelMatchesHost(model, "vercelAIGateway") && "vercelGatewayRouting" in compat) {
		return getSingleRoutingOnly(compat.vercelGatewayRouting);
	}
	if (modelMatchesHost(model, "openrouter") && "openRouterRouting" in compat) {
		return getSingleRoutingOnly(compat.openRouterRouting);
	}
	return undefined;
}

export function formatModelStringWithRouting(model: Model<Api>): string {
	const selector = formatModelString(model);
	const upstream = getSingleUpstreamRoute(model);
	return upstream ? `${selector}@${upstream}` : selector;
}

export function formatModelSelectorValue(selector: string, thinkingLevel: ThinkingLevel | undefined): string {
	return thinkingLevel && thinkingLevel !== ThinkingLevel.Inherit ? `${selector}:${thinkingLevel}` : selector;
}

function getOpenRouterRouteSuffix(modelId: string): { baseId: string; suffix: string } | undefined {
	const colonIdx = modelId.lastIndexOf(":");
	if (colonIdx === -1) {
		return undefined;
	}

	const suffix = modelId.slice(colonIdx + 1).trim();

	if (!suffix || parseThinkingSuffix(suffix, MAX_THINKING_SUFFIX_OPTIONS)) {
		return undefined;
	}

	return { baseId: modelId.slice(0, colonIdx), suffix };
}

function stripOpenRouterDateSuffix(modelId: string): string | undefined {
	const stripped = modelId.replace(/-\d{8}(?=$|:)/i, "");
	return stripped !== modelId ? stripped : undefined;
}

function getOpenRouterFallbackModelIds(modelId: string): string[] {
	const orderedCandidates: string[] = [];
	const queue = [modelId];
	const seen = new Set<string>();

	while (queue.length > 0) {
		const candidate = queue.shift();
		if (!candidate || seen.has(candidate)) {
			continue;
		}
		seen.add(candidate);
		orderedCandidates.push(candidate);

		const routedSuffix = getOpenRouterRouteSuffix(candidate);
		if (routedSuffix) {
			queue.push(routedSuffix.baseId);
		}

		const strippedDate = stripOpenRouterDateSuffix(candidate);
		if (strippedDate) {
			queue.push(strippedDate);
		}
	}

	return orderedCandidates;
}

function cloneModelWithRequestedId(model: Model<Api>, requestedId: string): Model<Api> {
	return {
		...model,
		id: requestedId,
		...(model.name === model.id ? { name: requestedId } : {}),
	};
}

const AMAZON_BEDROCK_PROVIDER = "amazon-bedrock";
const BEDROCK_INFERENCE_PROFILE_ARN =
	/^arn:aws(?:-[a-z]+)*:bedrock:[a-z0-9-]+:[0-9]*:(?:application-inference-profile|inference-profile)\/[a-z0-9][a-z0-9._:-]*$/i;

function hasBedrockInferenceProfileThinkingSuffix(modelId: string): boolean {
	const { base, level } = splitThinkingSuffix(modelId);
	return level !== undefined && BEDROCK_INFERENCE_PROFILE_ARN.test(base.trim());
}

function resolveBedrockInferenceProfileModelId(
	modelId: string,
	availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
	const requestedId = modelId.trim();
	if (hasBedrockInferenceProfileThinkingSuffix(requestedId) || !BEDROCK_INFERENCE_PROFILE_ARN.test(requestedId)) {
		return undefined;
	}

	const template = availableModels.find(model => model.provider.toLowerCase() === AMAZON_BEDROCK_PROVIDER);
	if (!template) return undefined;

	return buildModel({
		id: requestedId,
		name: "Bedrock inference profile",
		api: "bedrock-converse-stream",
		provider: AMAZON_BEDROCK_PROVIDER,
		baseUrl: template.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		...(template.headers ? { headers: template.headers } : {}),
		...(template.resolveHeaders ? { resolveHeaders: template.resolveHeaders } : {}),
		...(template.transport !== undefined ? { transport: template.transport } : {}),
		...(template.guardrailIdentifier !== undefined ? { guardrailIdentifier: template.guardrailIdentifier } : {}),
		...(template.guardrailVersion !== undefined ? { guardrailVersion: template.guardrailVersion } : {}),
		...(template.guardrailTrace !== undefined ? { guardrailTrace: template.guardrailTrace } : {}),
		...(template.requestMetadata !== undefined ? { requestMetadata: template.requestMetadata } : {}),
	});
}

function resolveBedrockInferenceProfileReference(
	provider: string,
	modelId: string,
	availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
	if (provider.toLowerCase() !== AMAZON_BEDROCK_PROVIDER) return undefined;
	return resolveBedrockInferenceProfileModelId(modelId, availableModels);
}

// Bare slug (`cerebras`) or tiered/regional slug (`google-ai-studio/priority`, `google-vertex/global/flex`).
const UPSTREAM_ROUTING_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

export function splitUpstreamRouting(pattern: string): { base: string; upstream: string } | undefined {
	const at = pattern.lastIndexOf("@");
	if (at <= 0) return undefined;
	const rest = pattern.slice(at + 1);
	const colon = rest.indexOf(":");
	const upstream = colon === -1 ? rest : rest.slice(0, colon);
	if (!UPSTREAM_ROUTING_SLUG.test(upstream)) return undefined;
	const trailing = colon === -1 ? "" : rest.slice(colon);
	return { base: pattern.slice(0, at) + trailing, upstream };
}

function supportsUpstreamRouting(model: Model<Api>): boolean {
	return modelMatchesHost(model, "openrouter") || modelMatchesHost(model, "vercelAIGateway");
}

function applyUpstreamRouting(model: Model<Api>, upstream: string): Model<Api> {
	const aggregatorModel = model as Model<"openai-completions">;
	const routing = { only: [upstream] };
	return buildModel({
		...model,
		compat: modelMatchesHost(model, "vercelAIGateway")
			? { ...aggregatorModel.compatConfig, vercelGatewayRouting: routing }
			: { ...aggregatorModel.compatConfig, openRouterRouting: routing },
	} as ModelSpec<Api>);
}

const kProviderModelIndex = Symbol("model-resolver.providerIndex");
const kProviderSpellingIndex = Symbol("model-resolver.providerSpellingIndex");
const kProviderWireRouteIndex = Symbol("model-resolver.wireRouteIndex");
type ModelsWithProviderIndex = readonly Model<Api>[] & {
	[kProviderModelIndex]?: Map<string, Model<Api> | null>;
	[kProviderSpellingIndex]?: Map<string, Model<Api> | null>;
	[kProviderWireRouteIndex]?: Map<string, Model<Api> | null>;
};

/**
 * Folds the dotted revision spelling aggregators use (`claude-fable-5.1`) onto the dashed first-party
 * spelling (`claude-fable-5-1`). Only digit-bounded dots are separators.
 */
function revisionSpellingKey(id: string): string {
	return id.toLowerCase().replace(/(?<=\d)\.(?=\d)/g, "-");
}

function buildProviderIndex(
	availableModels: readonly Model<Api>[],
	idKey: (id: string) => string,
): Map<string, Model<Api> | null> {
	const index = new Map<string, Model<Api> | null>();
	for (const m of availableModels) {
		const key = `${m.provider.toLowerCase()}\u0000${idKey(m.id)}`;
		if (index.has(key)) {
			index.set(key, null);
		} else {
			index.set(key, m);
		}
	}
	return index;
}

function getProviderModelIndex(availableModels: readonly Model<Api>[]): Map<string, Model<Api> | null> {
	const tagged = availableModels as ModelsWithProviderIndex;
	const cached = tagged[kProviderModelIndex];
	if (cached) return cached;
	const index = buildProviderIndex(availableModels, id => id.toLowerCase());
	tagged[kProviderModelIndex] = index;
	return index;
}

function getProviderSpellingIndex(availableModels: readonly Model<Api>[]): Map<string, Model<Api> | null> {
	const tagged = availableModels as ModelsWithProviderIndex;
	const cached = tagged[kProviderSpellingIndex];
	if (cached) return cached;
	const index = buildProviderIndex(availableModels, revisionSpellingKey);
	tagged[kProviderSpellingIndex] = index;
	return index;
}

/**
 * `provider\0wireId` → the logical model whose `thinking.effortRouting` targets it. Families collapsed at
 * discovery time (Devin) have no alias table, so their raw upstream uids stay selectable through this.
 * A wire id routed by two logical models maps to `null` and resolves to nothing.
 */
function getProviderWireRouteIndex(availableModels: readonly Model<Api>[]): Map<string, Model<Api> | null> {
	const tagged = availableModels as ModelsWithProviderIndex;
	const cached = tagged[kProviderWireRouteIndex];
	if (cached) return cached;
	const index = new Map<string, Model<Api> | null>();
	for (const m of availableModels) {
		const routing = m.thinking?.effortRouting;
		if (routing === undefined) continue;
		const providerKey = m.provider.toLowerCase();
		for (const wireId of Object.values(routing)) {
			if (wireId === undefined) continue;
			const key = `${providerKey}\u0000${wireId.toLowerCase()}`;
			const existing = index.get(key);
			if (existing === undefined) index.set(key, m);
			else if (existing !== null && existing !== m) index.set(key, null);
		}
	}
	tagged[kProviderWireRouteIndex] = index;
	return index;
}

export function resolveProviderModelReference(
	provider: string,
	modelId: string,
	availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
	const normalizedProvider = provider.trim().toLowerCase();
	const normalizedModelId = modelId.trim().toLowerCase();
	if (!normalizedProvider || !normalizedModelId) {
		return undefined;
	}

	const index = getProviderModelIndex(availableModels);
	const exact = index.get(`${normalizedProvider}\u0000${normalizedModelId}`);
	if (exact === null) {
		return undefined;
	}
	if (exact !== undefined) {
		return exact;
	}

	const variantAliasId =
		resolveVariantAlias(normalizedProvider, normalizedModelId) ?? stripThinkingVariantToken(normalizedModelId);
	if (variantAliasId) {
		const aliased = index.get(`${normalizedProvider}\u0000${variantAliasId.toLowerCase()}`);
		if (aliased) {
			return aliased;
		}
	}

	// The exact lookup above keeps a live raw model winning over the collapsed carrier.
	const routed = getProviderWireRouteIndex(availableModels).get(`${normalizedProvider}\u0000${normalizedModelId}`);
	if (routed) {
		return routed;
	}

	const bedrockInferenceProfile = resolveBedrockInferenceProfileReference(provider, modelId, availableModels);
	if (bedrockInferenceProfile) {
		return bedrockInferenceProfile;
	}

	// Resolve `anthropic/claude-fable-5.1` inside the named provider; falling through to the bare-id phase
	// would bind the verbatim aggregator id (OpenRouter's `anthropic/claude-fable-5.1`) instead.
	const spelled = getProviderSpellingIndex(availableModels).get(
		`${normalizedProvider}\u0000${revisionSpellingKey(normalizedModelId)}`,
	);
	if (spelled) {
		return spelled;
	}

	if (normalizedProvider !== "openrouter") {
		return undefined;
	}

	for (const fallbackId of getOpenRouterFallbackModelIds(modelId).slice(1)) {
		const fallback = index.get(`${normalizedProvider}\u0000${fallbackId.toLowerCase()}`);
		if (fallback === null) {
			return undefined;
		}
		if (fallback !== undefined) {
			return cloneModelWithRequestedId(fallback, modelId);
		}
	}

	return undefined;
}

interface ModelMatchPreferences {
	usageOrder?: string[];

	providerOrder?: readonly string[];

	deprioritizeProviders?: string[];
}

export type ModelLookupRegistry = Pick<ModelRegistry, "getAvailable">;
type CliModelRegistry = Pick<ModelRegistry, "getAll" | "getAvailable">;

interface ModelPreferenceContext {
	modelUsageRank: Map<string, number>;
	providerUsageRank: Map<string, number>;
	providerPriorityRank: Map<string, number>;
	deprioritizedProviders: Set<string>;
	modelOrder: Map<string, number>;
}

function buildPreferenceContext(
	availableModels: Model<Api>[],
	preferences: ModelMatchPreferences | undefined,
): ModelPreferenceContext {
	const modelUsageRank = new Map<string, number>();
	const providerUsageRank = new Map<string, number>();
	const usageOrder = preferences?.usageOrder ?? [];
	for (let i = 0; i < usageOrder.length; i += 1) {
		const key = usageOrder[i];
		if (!modelUsageRank.has(key)) {
			modelUsageRank.set(key, i);
		}
		const parsed = parseModelString(key);
		if (parsed && !providerUsageRank.has(parsed.provider)) {
			providerUsageRank.set(parsed.provider, i);
		}
	}
	const providerPriorityRank = buildModelProviderPriorityRank(preferences?.providerOrder);
	const deprioritizedProviders = new Set(preferences?.deprioritizeProviders ?? []);
	const modelOrder = new Map<string, number>();
	for (let i = 0; i < availableModels.length; i += 1) {
		modelOrder.set(formatModelString(availableModels[i]), i);
	}

	return { modelUsageRank, providerUsageRank, providerPriorityRank, deprioritizedProviders, modelOrder };
}

export function getModelMatchPreferences(
	settings?: Partial<Pick<Settings, "get" | "getStorage">>,
): ModelMatchPreferences {
	return {
		usageOrder: settings?.getStorage?.()?.getModelUsageOrder(),
		providerOrder: settings?.get?.("modelProviderOrder"),
	};
}

function mergeModelMatchPreferences(
	settings: Settings | undefined,
	preferences: ModelMatchPreferences | undefined,
): ModelMatchPreferences {
	const settingsPreferences = getModelMatchPreferences(settings);
	return {
		usageOrder: preferences?.usageOrder ?? settingsPreferences.usageOrder,
		providerOrder: preferences?.providerOrder ?? settingsPreferences.providerOrder,
		deprioritizeProviders: preferences?.deprioritizeProviders,
	};
}

function pickPreferredModel(candidates: Model<Api>[], context: ModelPreferenceContext): Model<Api> {
	if (candidates.length <= 1) return candidates[0];
	return [...candidates].sort((a, b) => {
		const aKey = formatModelString(a);
		const bKey = formatModelString(b);
		const aUsage = context.modelUsageRank.get(aKey);
		const bUsage = context.modelUsageRank.get(bKey);
		if (aUsage !== undefined || bUsage !== undefined) {
			return (aUsage ?? Number.POSITIVE_INFINITY) - (bUsage ?? Number.POSITIVE_INFINITY);
		}

		const aProviderPriority = context.providerPriorityRank.get(a.provider.toLowerCase());
		const bProviderPriority = context.providerPriorityRank.get(b.provider.toLowerCase());
		if (aProviderPriority !== undefined || bProviderPriority !== undefined) {
			return (aProviderPriority ?? Number.POSITIVE_INFINITY) - (bProviderPriority ?? Number.POSITIVE_INFINITY);
		}

		const aProviderUsage = context.providerUsageRank.get(a.provider);
		const bProviderUsage = context.providerUsageRank.get(b.provider);
		if (aProviderUsage !== undefined || bProviderUsage !== undefined) {
			return (aProviderUsage ?? Number.POSITIVE_INFINITY) - (bProviderUsage ?? Number.POSITIVE_INFINITY);
		}

		const aDeprioritized = context.deprioritizedProviders.has(a.provider);
		const bDeprioritized = context.deprioritizedProviders.has(b.provider);
		if (aDeprioritized !== bDeprioritized) {
			return aDeprioritized ? 1 : -1;
		}

		const aOrder = context.modelOrder.get(aKey) ?? 0;
		const bOrder = context.modelOrder.get(bKey) ?? 0;
		return aOrder - bOrder;
	})[0];
}

function isAlias(id: string): boolean {
	if (id.endsWith("-latest")) return true;

	const datePattern = /-\d{8}$/;
	return !datePattern.test(id);
}

function includeSyntheticAllowedModels(available: Model<Api>[], allowedModels: Iterable<Model<Api>>): Model<Api>[] {
	const allowedByKey = new Map<string, Model<Api>>();
	for (const model of allowedModels) {
		const key = formatModelString(model);
		if (!allowedByKey.has(key)) {
			allowedByKey.set(key, model);
		}
	}
	if (allowedByKey.size === 0) return [];

	const result: Model<Api>[] = [];
	for (const model of available) {
		if (allowedByKey.delete(formatModelString(model))) {
			result.push(model);
		}
	}

	result.push(...allowedByKey.values());
	return result;
}

function isProviderLockedCrossMatch(pattern: string, matchedModel: Model<Api>): boolean {
	const slashIdx = pattern.indexOf("/");
	if (slashIdx <= 0) {
		return false;
	}
	const provider = pattern.slice(0, slashIdx).toLowerCase();
	const modelId = revisionSpellingKey(pattern.slice(slashIdx + 1));
	if (matchedModel.provider.toLowerCase() === provider) {
		return false;
	}
	// A match on a provider with no bundled catalog is a user-configured custom provider: the literal id
	// is stated intent, not an aggregator shadow.
	if (getBundledModels(matchedModel.provider.toLowerCase() as GeneratedProvider).length === 0) {
		return false;
	}

	return getBundledModels(provider as GeneratedProvider).some(m => revisionSpellingKey(m.id) === modelId);
}

function findExactModelReferenceMatch(modelReference: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return undefined;
	}

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			return resolveProviderModelReference(provider, modelId, availableModels);
		}
	}
	return undefined;
}

function matchModel(
	modelPattern: string,
	availableModels: Model<Api>[],
	context: ModelPreferenceContext,
	options?: { exactOnly?: boolean },
): Model<Api> | undefined {
	const exactRefMatch = findExactModelReferenceMatch(modelPattern, availableModels);
	if (exactRefMatch) {
		return exactRefMatch;
	}

	const lowerPattern = modelPattern.toLowerCase();
	const exactMatches = availableModels.filter(m => m.id.toLowerCase() === lowerPattern);
	if (exactMatches.length > 0) {
		const unlockedMatches = exactMatches.filter(m => !isProviderLockedCrossMatch(modelPattern, m));
		if (unlockedMatches.length > 0) {
			return pickPreferredModel(unlockedMatches, context);
		}
		return undefined;
	}

	const bedrockInferenceProfile = resolveBedrockInferenceProfileModelId(modelPattern, availableModels);
	if (bedrockInferenceProfile) {
		return bedrockInferenceProfile;
	}

	const bareAlias = resolveBareVariantAlias(modelPattern);
	const bareAliasTargetId = bareAlias?.id ?? stripThinkingVariantToken(modelPattern);
	if (bareAliasTargetId) {
		const lowerAliasTarget = bareAliasTargetId.toLowerCase();
		const aliasMatches = availableModels.filter(m => m.id.toLowerCase() === lowerAliasTarget);
		if (aliasMatches.length > 0) {
			const preferred = bareAlias ? aliasMatches.filter(m => bareAlias.providers.includes(m.provider)) : [];
			return pickPreferredModel(preferred.length > 0 ? preferred : aliasMatches, context);
		}
	}

	if (options?.exactOnly) {
		return undefined;
	}

	const slashIndex = modelPattern.indexOf("/");
	if (slashIndex !== -1) {
		const provider = modelPattern.substring(0, slashIndex);
		const modelId = modelPattern.substring(slashIndex + 1);
		const lowerProvider = provider.toLowerCase();
		const providerModels = availableModels.filter(m => m.provider.toLowerCase() === lowerProvider);
		if (providerModels.length === 0) {
		} else {
			if (splitUpstreamRouting(modelId) && providerModels.some(supportsUpstreamRouting)) {
				return undefined;
			}
			const scored = providerModels
				.map(model => ({ model, match: fuzzyMatch(modelId, model.id) }))
				.filter(entry => entry.match.matches);
			if (scored.length === 0) {
				return undefined;
			}

			scored.sort((a, b) => {
				if (a.match.score !== b.match.score) return a.match.score - b.match.score;
				const aKey = formatModelString(a.model);
				const bKey = formatModelString(b.model);
				const aUsage = context.modelUsageRank.get(aKey) ?? Number.POSITIVE_INFINITY;
				const bUsage = context.modelUsageRank.get(bKey) ?? Number.POSITIVE_INFINITY;
				if (aUsage !== bUsage) return aUsage - bUsage;

				const aProviderUsage = context.providerUsageRank.get(a.model.provider) ?? Number.POSITIVE_INFINITY;
				const bProviderUsage = context.providerUsageRank.get(b.model.provider) ?? Number.POSITIVE_INFINITY;
				if (aProviderUsage !== bProviderUsage) return aProviderUsage - bProviderUsage;

				const aOrder = context.modelOrder.get(aKey) ?? 0;
				const bOrder = context.modelOrder.get(bKey) ?? 0;
				return aOrder - bOrder;
			});
			return scored[0]?.model;
		}
	}

	const matches = availableModels.filter(
		m => m.id.toLowerCase().includes(lowerPattern) || m.name?.toLowerCase().includes(lowerPattern),
	);

	if (matches.length === 0) {
		return undefined;
	}

	const aliases = matches.filter(m => isAlias(m.id));
	const datedVersions = matches.filter(m => !isAlias(m.id));

	if (aliases.length > 0) {
		return pickPreferredModel(aliases, context);
	}
	if (datedVersions.length === 0) return undefined;

	if (datedVersions.length === 1) {
		return datedVersions[0];
	}

	const sortedById = [...datedVersions].sort((a, b) => b.id.localeCompare(a.id));
	const topId = sortedById[0]?.id;
	if (!topId) return undefined;
	const topCandidates = sortedById.filter(model => model.id === topId);
	return pickPreferredModel(topCandidates, context);
}

interface ParsedModelResult {
	model: Model<Api> | undefined;

	thinkingLevel?: ThinkingLevel;

	upstream?: string;
	warning: string | undefined;
	explicitThinkingLevel: boolean;
}

function parseModelPatternWithContext(
	pattern: string,
	availableModels: Model<Api>[],
	context: ModelPreferenceContext,
	options?: { allowInvalidThinkingSelectorFallback?: boolean },
): ParsedModelResult {
	const exactMatch = matchModel(pattern, availableModels, context, { exactOnly: true });
	if (exactMatch) {
		return { model: exactMatch, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}

	const { base, level } = splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS);
	if (level) {
		const literalSuffixMatch = matchModel(pattern, availableModels, context);
		if (literalSuffixMatch?.id.toLowerCase().endsWith(`:${level}`)) {
			return {
				model: literalSuffixMatch,
				thinkingLevel: undefined,
				warning: undefined,
				explicitThinkingLevel: false,
			};
		}

		const result = parseModelPatternWithContext(base, availableModels, context, options);
		if (result.model) {
			const explicitThinkingLevel = !result.warning;
			return {
				model: result.model,
				thinkingLevel: explicitThinkingLevel ? level : undefined,
				warning: result.warning,
				explicitThinkingLevel,
			};
		}
		return result;
	}

	const fallbackMatch = matchModel(pattern, availableModels, context);
	if (fallbackMatch) {
		return { model: fallbackMatch, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}

	const lastColonIndex = pattern.lastIndexOf(":");
	if (lastColonIndex === -1) {
		return { model: undefined, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}
	const prefix = pattern.substring(0, lastColonIndex);
	const suffix = pattern.substring(lastColonIndex + 1);

	const allowFallback = options?.allowInvalidThinkingSelectorFallback ?? true;
	if (!allowFallback) {
		return { model: undefined, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}

	const result = parseModelPatternWithContext(prefix, availableModels, context, options);
	if (result.model) {
		return {
			model: result.model,
			thinkingLevel: undefined,
			warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
			explicitThinkingLevel: false,
		};
	}
	return result;
}

function matchPatternWithContext(
	pattern: string,
	availableModels: Model<Api>[],
	context: ModelPreferenceContext,
	options?: { allowInvalidThinkingSelectorFallback?: boolean },
): ParsedModelResult {
	const direct = parseModelPatternWithContext(pattern, availableModels, context, options);
	if (direct.model) return direct;

	const routing = splitUpstreamRouting(pattern);
	if (routing) {
		const routed = parseModelPatternWithContext(routing.base, availableModels, context, options);
		if (routed.model && supportsUpstreamRouting(routed.model)) {
			return { ...routed, model: applyUpstreamRouting(routed.model, routing.upstream), upstream: routing.upstream };
		}
	}
	return direct;
}

export function parseModelPattern(
	pattern: string,
	availableModels: Model<Api>[],
	preferences?: ModelMatchPreferences,
	options?: { allowInvalidThinkingSelectorFallback?: boolean },
): ParsedModelResult {
	return matchPatternWithContext(
		pattern,
		availableModels,
		buildPreferenceContext(availableModels, preferences),
		options,
	);
}

const DEFAULT_MODEL_ROLE = "default";
const MODEL_ROLE_ALIAS_PREFIXES = [MODEL_ROLE_ALIAS_PREFIX, LEGACY_MODEL_ROLE_ALIAS_PREFIX];

export interface ModelRoleLookup {
	getModelRole(role: ModelRole | string): string | undefined;
}

function isModelRole(role: string): role is ModelRole {
	return (MODEL_ROLE_IDS as string[]).includes(role);
}

function modelRoleAliasPrefixLength(value: string): number | undefined {
	if (value === DEFAULT_MODEL_ROLE_ALIAS || value.startsWith(`${DEFAULT_MODEL_ROLE_ALIAS}:`)) return 0;
	return MODEL_ROLE_ALIAS_PREFIXES.find(prefix => value.startsWith(prefix))?.length;
}

function getModelRoleAlias(value: string, settings?: ModelRoleLookup): string | undefined {
	const normalized = value.trim();
	const prefixLength = modelRoleAliasPrefixLength(normalized);
	if (prefixLength === undefined) return undefined;

	const candidate = normalized === DEFAULT_MODEL_ROLE_ALIAS ? DEFAULT_MODEL_ROLE : normalized.slice(prefixLength);
	if (isModelRole(candidate) || settings?.getModelRole(candidate) !== undefined) return candidate;
	return undefined;
}

function normalizeModelPatternList(value: string | string[] | undefined): string[] {
	if (!value) return [];
	const patterns = Array.isArray(value) ? value.flatMap(pattern => pattern.split(",")) : value.split(",");
	return patterns.map(pattern => pattern.trim()).filter(Boolean);
}

export function resolveExplicitModelRole(
	value: string | string[] | undefined,
	settings?: ModelRoleLookup,
): string | undefined {
	for (const pattern of normalizeModelPatternList(value)) {
		const prefixLength = modelRoleAliasPrefixLength(pattern);
		if (prefixLength === undefined) continue;
		const { base } = splitThinkingSuffix(pattern, prefixLength, MAX_THINKING_SUFFIX_OPTIONS);
		const role = getModelRoleAlias(base, settings);
		if (role) return role;
	}
	return undefined;
}

function isSessionInheritedAgentPattern(value: string): boolean {
	return (
		value === DEFAULT_MODEL_ROLE ||
		value === formatModelRoleAlias(DEFAULT_MODEL_ROLE) ||
		value === DEFAULT_MODEL_ROLE_ALIAS ||
		value === `${LEGACY_MODEL_ROLE_ALIAS_PREFIX}${DEFAULT_MODEL_ROLE}` ||
		value === formatModelRoleAlias("worker") ||
		value === `${LEGACY_MODEL_ROLE_ALIAS_PREFIX}worker`
	);
}

function shouldInheritDefaultBeforePriority(role: ModelRole): boolean {
	return role === "smol" || role === "slow" || role === "designer";
}

const ROLE_PRIORITY_ALIAS: Partial<Record<ModelRole, keyof typeof MODEL_PRIO>> = {
	advisor: "slow",
	tiny: "smol",
};

interface ConfiguredRoleFallback {
	role: ModelRole;
	/** Skip the target role's own default inheritance when it has no explicit configuration. */
	configuredOnly: boolean;
}

// An unset role resolves through another role before its built-in chain: tiny follows smol (configured, inherited,
// or built-in), while advisor follows only an explicitly configured slow so it never inherits the primary's model.
const ROLE_CONFIGURED_FALLBACK: Partial<Record<ModelRole, ConfiguredRoleFallback>> = {
	advisor: { role: "slow", configuredOnly: true },
	tiny: { role: "smol", configuredOnly: false },
};

function rolePriorityDefaults(role: ModelRole): string[] {
	const key = ROLE_PRIORITY_ALIAS[role] ?? (role as keyof typeof MODEL_PRIO);
	return normalizeModelPatternList(MODEL_PRIO[key]);
}

/** Expands role aliases inside a pattern list; an alias cycle falls back to the role's built-in chain. */
function resolveNestedRolePatterns(
	value: string,
	roleDefaults: string[],
	settings: ModelRoleLookup | undefined,
	visited: Set<string>,
): string[] {
	const resolved: string[] = [];
	for (const pattern of normalizeModelPatternList(value)) {
		const { base: aliasCandidate, level: thinkingLevel } = splitThinkingSuffix(
			pattern,
			modelRoleAliasPrefixLength(pattern) ?? LEGACY_MODEL_ROLE_ALIAS_PREFIX.length,
			MAX_THINKING_SUFFIX_OPTIONS,
		);
		const aliasRole = getModelRoleAlias(aliasCandidate, settings);
		if (!aliasRole) {
			resolved.push(pattern);
			continue;
		}
		if (visited.has(aliasRole)) {
			resolved.push(
				...(thinkingLevel
					? roleDefaults.map(defaultPattern => `${defaultPattern}:${thinkingLevel}`)
					: roleDefaults),
			);
			continue;
		}
		const recursed = resolveConfiguredRolePattern(pattern, settings, new Set(visited));
		if (recursed) resolved.push(...recursed);
	}
	return resolved;
}

function resolveDefaultInheritedPatterns(
	role: ModelRole,
	configuredDefault: string | undefined,
	roleDefaults: string[],
	settings: ModelRoleLookup | undefined,
	visited: Set<string>,
): string[] {
	if (!shouldInheritDefaultBeforePriority(role) || !configuredDefault) return [];
	return resolveNestedRolePatterns(configuredDefault, roleDefaults, settings, visited);
}

function resolveConfiguredRolePattern(
	value: string,
	settings?: ModelRoleLookup,
	visited: Set<string> = new Set(),
): string[] | undefined {
	const normalized = value.trim();
	if (!normalized) return undefined;

	const { base: aliasCandidate, level: thinkingLevel } = splitThinkingSuffix(
		normalized,
		modelRoleAliasPrefixLength(normalized) ?? LEGACY_MODEL_ROLE_ALIAS_PREFIX.length,
		MAX_THINKING_SUFFIX_OPTIONS,
	);
	const role = getModelRoleAlias(aliasCandidate, settings);
	if (!role) return [normalized];
	if (visited.has(role)) return undefined;
	visited.add(role);

	const configured = settings?.getModelRole(role)?.trim();
	const configuredDefault = settings?.getModelRole(DEFAULT_MODEL_ROLE)?.trim();
	const roleDefaults = isModelRole(role) ? rolePriorityDefaults(role) : [];
	const configuredFallback = isModelRole(role) ? ROLE_CONFIGURED_FALLBACK[role] : undefined;
	const fallbackPatterns =
		configured ||
		!configuredFallback ||
		(configuredFallback.configuredOnly && !settings?.getModelRole(configuredFallback.role)?.trim())
			? undefined
			: resolveConfiguredRolePattern(formatModelRoleAlias(configuredFallback.role), settings, new Set(visited));
	const resolved = configured
		? resolveNestedRolePatterns(configured, roleDefaults, settings, visited)
		: fallbackPatterns
			? fallbackPatterns
			: isModelRole(role)
				? resolveDefaultInheritedPatterns(role, configuredDefault, roleDefaults, settings, visited)
				: roleDefaults;
	if (resolved.length === 0) {
		resolved.push(...roleDefaults);
	}
	if (resolved.length === 0) {
		return undefined;
	}

	return thinkingLevel ? resolved.map(pattern => `${pattern}:${thinkingLevel}`) : resolved;
}

export function expandRoleAlias(value: string, settings?: ModelRoleLookup): string {
	const normalized = value.trim();
	if (normalized === DEFAULT_MODEL_ROLE) {
		return settings?.getModelRole("default") ?? value;
	}

	const resolved = resolveConfiguredRolePattern(value, settings)?.[0];
	return resolved ?? value;
}

export function resolveConfiguredModelPatterns(
	value: string | string[] | undefined,
	settings?: ModelRoleLookup,
): string[] {
	const patterns = normalizeModelPatternList(value);
	return patterns.flatMap(pattern => {
		const resolved = resolveConfiguredRolePattern(pattern, settings);
		return resolved ?? [];
	});
}
interface AgentModelPatternResolutionOptions {
	requestModel?: string | string[];
	settingsOverride?: string | string[];
	agentModel?: string | string[];
	settings?: Settings;
	activeModelPattern?: string;
	fallbackModelPattern?: string;
}

interface EffectiveAgentModelSelection {
	source?: string | string[];
	patterns: string[];
}

function resolveEffectiveAgentModelSelection(
	options: AgentModelPatternResolutionOptions,
): EffectiveAgentModelSelection {
	const { requestModel, settingsOverride, agentModel, settings, activeModelPattern, fallbackModelPattern } = options;

	const requestPatterns = resolveConfiguredModelPatterns(requestModel, settings);
	if (requestPatterns.length > 0) {
		return { source: requestModel, patterns: requestPatterns };
	}

	const overridePatterns = resolveConfiguredModelPatterns(settingsOverride, settings);
	if (overridePatterns.length > 0) {
		return { source: settingsOverride, patterns: overridePatterns };
	}

	const normalizedAgentPatterns = normalizeModelPatternList(agentModel);
	const configuredAgentPatterns = resolveConfiguredModelPatterns(agentModel, settings);
	const singleAgentPattern = normalizedAgentPatterns.length === 1 ? normalizedAgentPatterns[0] : undefined;
	const agentInheritsSessionModel = singleAgentPattern ? isSessionInheritedAgentPattern(singleAgentPattern) : false;
	if (configuredAgentPatterns.length > 0) {
		if (
			singleAgentPattern === formatModelRoleAlias("worker") ||
			singleAgentPattern === `${LEGACY_MODEL_ROLE_ALIAS_PREFIX}worker`
		) {
			return { source: agentModel, patterns: configuredAgentPatterns };
		}
		if (!agentInheritsSessionModel) return { source: agentModel, patterns: configuredAgentPatterns };
	}

	const fallback =
		activeModelPattern?.trim() || fallbackModelPattern?.trim() || settings?.getModelRole("default")?.trim() || "";
	return { patterns: resolveConfiguredModelPatterns(fallback, settings) };
}

interface AgentModelSelection {
	patterns: string[];

	role: string | undefined;
}

export function resolveAgentModelSelection(options: AgentModelPatternResolutionOptions): AgentModelSelection {
	const { source, patterns } = resolveEffectiveAgentModelSelection(options);
	return { patterns, role: resolveExplicitModelRole(source, options.settings) };
}

export function resolveAgentModelPatterns(options: AgentModelPatternResolutionOptions): string[] {
	return resolveEffectiveAgentModelSelection(options).patterns;
}

export interface AgentSpawnModelResolution {
	patterns: string[];

	role: string | undefined;

	/**
	 * Why the caller's explicit `model=` cannot be used: an unknown role alias, a pattern no
	 * available model matches, or a role model bank violation. Spawn callers reject the request
	 * with this text instead of starting a worker that has nothing to talk to.
	 */
	requestError: string | undefined;
}

const MAX_MODEL_SUGGESTIONS = 5;

function describeAvailableModelExamples(available: readonly Model<Api>[], requested: string): string {
	const base = splitThinkingSuffix(requested, -1, MAX_THINKING_SUFFIX_OPTIONS).base.toLowerCase();
	const provider = base.includes("/") ? base.slice(0, base.indexOf("/")) : undefined;
	const sameProvider = provider ? available.filter(model => model.provider.toLowerCase() === provider) : [];
	const pool = sameProvider.length > 0 ? sameProvider : available;
	const names = pool.slice(0, MAX_MODEL_SUGGESTIONS).map(formatModelString);
	const more = pool.length > names.length ? ` (+${pool.length - names.length} more)` : "";
	return `${names.join(", ")}${more}`;
}

/** The caller named a model; report why it is unusable before a worker is started on it. */
function describeUnusableRequestModel(
	requestModel: string | string[] | undefined,
	patterns: string[],
	modelRegistry: ModelLookupRegistry,
	settings: Settings | undefined,
): string | undefined {
	const requested = normalizeModelPatternList(requestModel);
	if (requested.length === 0) return undefined;
	const unknownRole = requested.find(
		pattern =>
			pattern.startsWith(MODEL_ROLE_ALIAS_PREFIX) &&
			getModelRoleAlias(
				splitThinkingSuffix(pattern, MODEL_ROLE_ALIAS_PREFIX.length, MAX_THINKING_SUFFIX_OPTIONS).base,
				settings,
			) === undefined,
	);
	if (unknownRole !== undefined) {
		const roles = settings ? getKnownRoleIds(settings) : (MODEL_ROLE_IDS as string[]);
		return `Unknown model role \`${unknownRole}\`. Use a role alias (${roles.map(formatModelRoleAlias).join(", ")}) or a concrete model id.`;
	}
	const available = modelRegistry.getAvailable();
	// An empty registry cannot judge a pattern — the session itself has no model to fall back on.
	if (available.length === 0) return undefined;
	if (resolveModelOverride(patterns, modelRegistry, settings).model) return undefined;
	return `Model \`${requested.join(", ")}\` did not match any available model. Available: ${describeAvailableModelExamples(available, requested[0] ?? "")}.`;
}

/**
 * Resolves the model for a spawned agent and enforces the role model bank: when the effective
 * role has a `modelRoleBank` configured, an explicit `model=` request must resolve into that
 * bank (the role's primary model is always allowed). Without a bank, any model is accepted.
 * The role survives a concrete `model=` request: it falls back to the role declared by the
 * agent/settings source when the request itself carries no role alias.
 */
export function resolveAgentSpawnModelSelection(
	options: AgentModelPatternResolutionOptions & { modelRegistry?: ModelLookupRegistry },
): AgentSpawnModelResolution {
	const settings = options.settings;
	const requestWon = resolveConfiguredModelPatterns(options.requestModel, settings).length > 0;
	const selection = resolveAgentModelSelection(options);
	const sourceRole = requestWon
		? (resolveExplicitModelRole(options.settingsOverride, settings) ??
			resolveExplicitModelRole(options.agentModel, settings))
		: selection.role;
	const role = selection.role ?? sourceRole;

	let requestError: string | undefined;
	if (requestWon && role) {
		const bank = settings?.getModelRoleBank(role);
		if (bank && bank.length > 0) {
			const candidates = [...bank];
			const primary = settings?.getModelRole(role);
			if (primary) candidates.push(primary);
			// Banks list models; a thinking suffix on the request or an entry is effort, not
			// identity — compare suffix-stripped base ids.
			const bankKey = (pattern: string): string =>
				splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS).base.toLowerCase();
			const allowed = new Set(
				candidates
					.map(entry => entry.trim())
					.filter(Boolean)
					.flatMap(entry => resolveConfiguredModelPatterns(entry, settings))
					.map(bankKey),
			);
			const violations = selection.patterns.filter(pattern => !allowed.has(bankKey(pattern)));
			if (violations.length > 0) {
				requestError = `Model ${violations.join(", ")} is not in the \`${role}\` role model bank. Available models: ${bank.join(", ")}.`;
			}
		}
	}
	if (!requestError && requestWon && options.modelRegistry) {
		requestError = describeUnusableRequestModel(
			options.requestModel,
			selection.patterns,
			options.modelRegistry,
			settings,
		);
	}
	return { patterns: selection.patterns, role, requestError };
}

export const DEFAULT_PREWALK_TARGET = "@smol";

interface AgentPrewalkResolutionOptions {
	settingsOverride?: string;

	agentPrewalk?: boolean | string;
}

export function resolveAgentPrewalkPattern(options: AgentPrewalkResolutionOptions): string | undefined {
	const agentPattern =
		typeof options.agentPrewalk === "string" && options.agentPrewalk.trim() ? options.agentPrewalk.trim() : undefined;
	const override = options.settingsOverride?.trim();
	if (override) {
		const lowered = override.toLowerCase();
		if (lowered === "off" || lowered === "false") return undefined;
		if (lowered === "on" || lowered === "true") return agentPattern ?? DEFAULT_PREWALK_TARGET;
		return override;
	}
	if (options.agentPrewalk === true) return DEFAULT_PREWALK_TARGET;
	return agentPattern;
}

interface AgentAdvisorResolutionOptions {
	settingsOverride?: string;

	agentAdvisor?: boolean | string;
}

interface AgentAdvisorSelection {
	model?: string;
}

export function resolveAgentAdvisorSelection(
	options: AgentAdvisorResolutionOptions,
): AgentAdvisorSelection | undefined {
	const agentPattern =
		typeof options.agentAdvisor === "string" && options.agentAdvisor.trim() ? options.agentAdvisor.trim() : undefined;
	const override = options.settingsOverride?.trim();
	if (override) {
		const lowered = override.toLowerCase();
		if (lowered === "off" || lowered === "false") return undefined;
		if (lowered === "on" || lowered === "true") return { model: agentPattern };
		return { model: override };
	}
	if (options.agentAdvisor === true) return {};
	return agentPattern ? { model: agentPattern } : undefined;
}

export interface ResolvedModelRoleValue {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;

	matchedPatternIndex?: number;
	explicitThinkingLevel: boolean;
	warning: string | undefined;
}

export function resolveModelRoleValue(
	roleValue: string | undefined,
	availableModels: Model<Api>[],
	options?: { settings?: Settings; roleLookup?: ModelRoleLookup; matchPreferences?: ModelMatchPreferences },
): ResolvedModelRoleValue {
	if (!roleValue) {
		return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
	}

	const normalized = roleValue.trim();
	if (!normalized || normalized === DEFAULT_MODEL_ROLE) {
		return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
	}

	const effectivePatterns = resolveConfiguredModelPatterns(normalized, options?.roleLookup ?? options?.settings);
	if (!effectivePatterns || effectivePatterns.length === 0) {
		return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
	}

	let warning: string | undefined;
	const matchPreferences = mergeModelMatchPreferences(options?.settings, options?.matchPreferences);

	const preferenceContext = buildPreferenceContext(availableModels, matchPreferences);
	for (const [patternIndex, effectivePattern] of effectivePatterns.entries()) {
		const resolved = matchPatternWithContext(effectivePattern, availableModels, preferenceContext);
		if (resolved.model) {
			return {
				model: resolved.model,
				matchedPatternIndex: patternIndex,
				thinkingLevel: resolved.explicitThinkingLevel
					? (resolveThinkingLevelForModel(resolved.model, resolved.thinkingLevel) ?? resolved.thinkingLevel)
					: resolved.thinkingLevel,
				explicitThinkingLevel: resolved.explicitThinkingLevel,
				warning: resolved.warning,
			};
		}
		if (!warning && resolved.warning) {
			warning = resolved.warning;
		}
	}

	return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning };
}

interface ExplicitThinkingSelectorOptions {
	isLiteralModelId?: (provider: string, id: string) => boolean;
}

function isLiteralModelSelector(value: string, options?: ExplicitThinkingSelectorOptions): boolean {
	const parsed = parseModelString(value);
	return parsed !== undefined && options?.isLiteralModelId?.(parsed.provider, parsed.id) === true;
}

export function extractExplicitThinkingSelector(
	value: string | undefined,
	settings?: Settings,
	options?: ExplicitThinkingSelectorOptions,
): ThinkingLevel | undefined {
	if (!value) return undefined;
	const normalized = value.trim();
	if (!normalized || normalized === DEFAULT_MODEL_ROLE) return undefined;

	const visited = new Set<string>();
	let current = normalized;
	while (!visited.has(current)) {
		visited.add(current);
		const rolePrefixLength = modelRoleAliasPrefixLength(current) ?? LEGACY_MODEL_ROLE_ALIAS_PREFIX.length;
		const strictSelector = splitThinkingSuffix(current, rolePrefixLength).level;
		if (strictSelector) {
			return strictSelector;
		}
		const maxSelector = splitThinkingSuffix(current, rolePrefixLength, MAX_THINKING_SUFFIX_OPTIONS).level;
		if (
			maxSelector &&
			(modelRoleAliasPrefixLength(current) !== undefined || !isLiteralModelSelector(current, options))
		) {
			return maxSelector;
		}
		const expanded = expandRoleAlias(current, settings).trim();
		if (!expanded || expanded === current) break;
		if (expanded === DEFAULT_MODEL_ROLE) return undefined;
		current = expanded;
	}

	return undefined;
}

export function resolveModelFromString(
	value: string,
	available: Model<Api>[],
	matchPreferences?: ModelMatchPreferences,
): Model<Api> | undefined {
	const exact = available.find(model => `${model.provider}/${model.id}` === value);
	if (exact) return exact;
	const parsed = parseModelString(value, {
		...MAX_THINKING_SUFFIX_OPTIONS,
		isLiteralModelId: (provider, id) => available.some(model => model.provider === provider && model.id === id),
	});
	if (parsed) {
		const parsedExact = available.find(model => model.provider === parsed.provider && model.id === parsed.id);
		if (parsedExact) return parsedExact;
	}
	return parseModelPattern(value, available, matchPreferences).model;
}

export function resolveModelFromSettings(options: {
	settings: Settings;
	availableModels: Model<Api>[];
	matchPreferences?: ModelMatchPreferences;
	roleOrder?: readonly ModelRole[];
}): Model<Api> | undefined {
	const { settings, availableModels, matchPreferences, roleOrder } = options;
	const roles = roleOrder ?? MODEL_ROLE_IDS;
	let sawConfiguredProviderQualifiedRole = false;
	for (const role of roles) {
		const configured = settings.getModelRole(role);
		if (!configured) continue;
		const expanded = expandRoleAlias(configured, settings).trim();
		if (expanded.includes("/")) {
			sawConfiguredProviderQualifiedRole = true;
		}
		const resolved = resolveModelFromString(expanded, availableModels, matchPreferences);
		if (resolved) return resolved;
	}
	return sawConfiguredProviderQualifiedRole ? undefined : availableModels[0];
}

export function resolveModelOverride(
	modelPatterns: string[],
	modelRegistry: ModelLookupRegistry,
	settings?: Settings,
): { model?: Model<Api>; thinkingLevel?: ThinkingLevel; explicitThinkingLevel: boolean; warning?: string } {
	if (modelPatterns.length === 0) return { explicitThinkingLevel: false };
	const availableModels = modelRegistry.getAvailable();
	const matchPreferences = getModelMatchPreferences(settings);
	let warning: string | undefined;
	for (const pattern of modelPatterns) {
		const {
			model,
			thinkingLevel,
			explicitThinkingLevel,
			warning: patternWarning,
		} = resolveModelRoleValue(pattern, availableModels, {
			settings,
			matchPreferences,
		});
		if (model) {
			return { model, thinkingLevel, explicitThinkingLevel, warning: patternWarning };
		}
		if (!warning && patternWarning) warning = patternWarning;
	}
	return { explicitThinkingLevel: false, warning };
}

export async function resolveModelOverrideWithAuthFallback(
	modelPatterns: string[],
	parentActiveModelPattern: string | undefined,
	modelRegistry: ModelLookupRegistry & Pick<ModelRegistry, "getApiKey">,
	settings?: Settings,
	sessionId?: string,
): Promise<{
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	explicitThinkingLevel: boolean;
	authFallbackUsed: boolean;
	warning?: string;
}> {
	const disabledProviders = new Set(settings?.get("disabledProviders"));
	let lookupRegistry: ModelLookupRegistry = modelRegistry;
	if (disabledProviders.size > 0) {
		const enabledModels = modelRegistry.getAvailable().filter(model => !disabledProviders.has(model.provider));
		lookupRegistry = { getAvailable: () => enabledModels };
	}
	const primary = resolveModelOverride(modelPatterns, lookupRegistry, settings);
	if (!primary.model || !parentActiveModelPattern) {
		return { ...primary, authFallbackUsed: false };
	}

	const primaryKey = await modelRegistry.getApiKey(primary.model, sessionId);
	if (primaryKey === kNoAuth || isAuthenticated(primaryKey)) {
		return { ...primary, authFallbackUsed: false };
	}

	const fallback = resolveModelOverride([parentActiveModelPattern], lookupRegistry, settings);
	if (!fallback.model) {
		return { ...primary, authFallbackUsed: false };
	}
	if (modelsAreEqual(fallback.model, primary.model)) {
		return { ...primary, authFallbackUsed: false };
	}
	const fallbackKey = await modelRegistry.getApiKey(fallback.model, sessionId);
	if (!isAuthenticated(fallbackKey)) {
		return { ...primary, authFallbackUsed: false };
	}

	return { ...fallback, authFallbackUsed: true, warning: primary.warning ?? fallback.warning };
}

export function resolveRoleSelection(
	roles: readonly string[],
	settings: Settings,
	availableModels: Model<Api>[],
): { model: Model<Api>; thinkingLevel?: ThinkingLevel } | undefined {
	const matchPreferences = getModelMatchPreferences(settings);
	for (const role of roles) {
		const resolved = resolveModelRoleValue(settings.getModelRole(role), availableModels, {
			settings,
			matchPreferences,
		});
		if (resolved.model) {
			return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
		}
	}
	return undefined;
}

export function resolveAdvisorRoleSelection(
	settings: Settings,
	availableModels: Model<Api>[],
): { model: Model<Api>; thinkingLevel?: ThinkingLevel } | undefined {
	const resolved = resolveModelRoleValue(formatModelRoleAlias("advisor"), availableModels, {
		settings,
		matchPreferences: getModelMatchPreferences(settings),
	});
	return resolved.model ? { model: resolved.model, thinkingLevel: resolved.thinkingLevel } : undefined;
}

export async function resolveModelScope(
	patterns: string[],
	modelRegistry: Pick<ModelRegistry, "getAvailable">,
	preferences?: ModelMatchPreferences,
	settings?: Settings,
	/** Lets a caller surface patterns that matched nothing; the log alone never reaches the user. */
	options?: { onUnmatchedPattern?: (pattern: string) => void },
): Promise<ScopedModel[]> {
	const availableModels = modelRegistry.getAvailable();
	const context = buildPreferenceContext(availableModels, preferences);
	const scopedModels: ScopedModel[] = [];
	const addScopedModel = (model: Model<Api>, thinkingLevel: ThinkingLevel | undefined, explicit: boolean) => {
		if (scopedModels.some(sm => modelsAreEqual(sm.model, model))) return;
		scopedModels.push({
			model,
			thinkingLevel: explicit
				? (resolveThinkingLevelForModel(model, thinkingLevel) ?? thinkingLevel)
				: thinkingLevel,
			explicitThinkingLevel: explicit,
		});
	};

	for (const pattern of patterns) {
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			const {
				models: matchingModels,
				thinkingLevel,
				explicitThinkingLevel,
			} = resolveGlobScopePattern(pattern, availableModels);

			if (matchingModels.length === 0) {
				logger.warn(`No models match pattern "${pattern}"`);
				options?.onUnmatchedPattern?.(pattern);
				continue;
			}

			for (const model of matchingModels) {
				addScopedModel(model, thinkingLevel, explicitThinkingLevel);
			}
			continue;
		}

		if (settings && modelRoleAliasPrefixLength(pattern) !== undefined) {
			const resolved = resolveModelRoleValue(pattern, availableModels, { settings, matchPreferences: preferences });
			if (resolved.warning) logger.warn(resolved.warning);
			if (!resolved.model) {
				logger.warn(`No models match pattern "${pattern}"`);
				options?.onUnmatchedPattern?.(pattern);
				continue;
			}
			addScopedModel(resolved.model, resolved.thinkingLevel, resolved.explicitThinkingLevel);
			continue;
		}

		const { model, thinkingLevel, warning, explicitThinkingLevel } = parseModelPatternWithContext(
			pattern,
			availableModels,
			context,
		);

		if (warning) {
			logger.warn(warning);
		}

		if (!model) {
			logger.warn(`No models match pattern "${pattern}"`);
			options?.onUnmatchedPattern?.(pattern);
			continue;
		}

		addScopedModel(model, thinkingLevel, explicitThinkingLevel);
	}

	return scopedModels;
}

export async function resolveAllowedModels(
	modelRegistry: Pick<ModelRegistry, "getAvailable">,
	settings: Settings | undefined,
	preferences?: ModelMatchPreferences,
): Promise<Model<Api>[]> {
	const available = modelRegistry.getAvailable();
	const patterns = settings?.get("enabledModels");
	if (!patterns || patterns.length === 0) {
		return available;
	}
	const scoped = await resolveModelScope(patterns, modelRegistry, preferences, settings);
	if (scoped.length === 0) {
		return [];
	}
	return includeSyntheticAllowedModels(
		available,
		scoped.map(entry => entry.model),
	);
}

export function filterAvailableModelsByEnabledPatterns(
	available: Model<Api>[],
	patterns: readonly string[],
	settings?: Settings,
): Model<Api>[] {
	if (patterns.length === 0) return available;

	const context = buildPreferenceContext(available, undefined);
	const allowedModels: Model<Api>[] = [];
	const addAllowed = (model: Model<Api>) => {
		allowedModels.push(model);
	};

	for (const pattern of patterns) {
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			for (const model of resolveGlobScopePattern(pattern, available).models) {
				addAllowed(model);
			}
			continue;
		}

		if (settings && modelRoleAliasPrefixLength(pattern) !== undefined) {
			const { model } = resolveModelRoleValue(pattern, available, { settings });
			if (model) addAllowed(model);
			continue;
		}

		const { model } = parseModelPatternWithContext(pattern, available, context);
		if (model) {
			addAllowed(model);
		}
	}

	return includeSyntheticAllowedModels(available, allowedModels);
}
function findExactCliModel(
	selector: string,
	allModels: Model<Api>[],
	availableModels: Model<Api>[],
	options?: { catalogFallback?: boolean },
): Model<Api> | undefined {
	const referenced = findExactModelReferenceMatch(selector, allModels);
	if (referenced) return referenced;

	const lower = selector.toLowerCase();
	const isFlatMatch = (model: Model<Api>) =>
		model.id.toLowerCase() === lower || formatModelString(model).toLowerCase() === lower;
	const preferred = availableModels.find(m => isFlatMatch(m) && !isProviderLockedCrossMatch(selector, m));
	if (preferred) return preferred;

	if (options?.catalogFallback === false) return undefined;
	return availableModels === allModels
		? undefined
		: allModels.find(m => isFlatMatch(m) && !isProviderLockedCrossMatch(selector, m));
}

export interface ResolveCliModelResult {
	model: Model<Api> | undefined;

	configuredPatterns?: string[];

	configuredRole?: string;

	configuredPatternIndex?: number;
	selector?: string;
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
	error: string | undefined;
}

export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	modelRegistry: CliModelRegistry;

	availableModels?: Model<Api>[];
	settings?: Settings;
	preferences?: ModelMatchPreferences;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, modelRegistry, settings, preferences, availableModels: preferredModels } = options;

	if (!cliModel) {
		return { model: undefined, selector: undefined, warning: undefined, error: undefined };
	}

	const allModels = modelRegistry.getAll();
	if (allModels.length === 0) {
		return {
			model: undefined,
			selector: undefined,
			warning: undefined,
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	const availableModels = preferredModels ?? modelRegistry.getAvailable();
	const providerMap = new Map<string, string>();
	for (const model of allModels) {
		providerMap.set(model.provider.toLowerCase(), model.provider);
	}

	let provider = cliProvider ? providerMap.get(cliProvider.toLowerCase()) : undefined;
	if (cliProvider && !provider) {
		return {
			model: undefined,
			selector: undefined,
			warning: undefined,
			error: `Unknown provider "${cliProvider}". Run "proto models" to see available providers/models.`,
		};
	}

	const trimmedModel = cliModel.trim();
	if (!provider) {
		const exact = findExactCliModel(trimmedModel, allModels, availableModels, { catalogFallback: false });
		if (exact) {
			return {
				model: exact,
				selector: formatModelString(exact),
				warning: undefined,
				thinkingLevel: undefined,
				error: undefined,
			};
		}
		const { base: exactBase, level: exactThinkingLevel } = splitThinkingSuffix(
			trimmedModel,
			-1,
			MAX_THINKING_SUFFIX_OPTIONS,
		);
		if (exactThinkingLevel) {
			const exactSuffixed = findExactCliModel(exactBase, allModels, availableModels, { catalogFallback: false });
			if (exactSuffixed) {
				return {
					model: exactSuffixed,
					selector: formatModelString(exactSuffixed),
					warning: undefined,
					thinkingLevel: exactThinkingLevel,
					error: undefined,
				};
			}
		}
	}
	let configuredPatterns: string[] | undefined;
	if (!cliProvider) {
		const { base: bareRoleName, level: bareRoleThinkingLevel } = splitThinkingSuffix(
			trimmedModel,
			-1,
			MAX_THINKING_SUFFIX_OPTIONS,
		);
		const roleSelector =
			modelRoleAliasPrefixLength(trimmedModel) !== undefined
				? trimmedModel
				: settings?.getModelRole(bareRoleName) !== undefined
					? `${formatModelRoleAlias(bareRoleName)}${bareRoleThinkingLevel ? `:${bareRoleThinkingLevel}` : ""}`
					: undefined;
		if (roleSelector) {
			const { base: roleAlias } = splitThinkingSuffix(
				roleSelector,
				modelRoleAliasPrefixLength(roleSelector) ?? -1,
				MAX_THINKING_SUFFIX_OPTIONS,
			);
			const configuredRole = getModelRoleAlias(roleAlias, settings);
			configuredPatterns = resolveConfiguredModelPatterns([roleSelector], settings);
			const availableResolved = resolveModelRoleValue(roleSelector, availableModels, {
				settings,
				matchPreferences: preferences,
			});
			const resolved = availableResolved.model
				? availableResolved
				: resolveModelRoleValue(roleSelector, allModels, {
						settings,
						matchPreferences: preferences,
					});
			if (resolved.model) {
				return {
					model: resolved.model,
					selector: formatModelString(resolved.model),
					configuredRole,
					configuredPatterns,
					configuredPatternIndex: resolved.matchedPatternIndex,
					thinkingLevel: resolved.thinkingLevel,
					warning: resolved.warning,
					error: undefined,
				};
			}
			if (configuredPatterns && configuredPatterns.length > 0) {
				return {
					model: undefined,
					configuredPatterns,
					configuredRole,
					selector: undefined,
					thinkingLevel: undefined,
					warning: resolved.warning,
					error: `Model "${trimmedModel}" not found. Run "proto models" to see available models.`,
				};
			}
		}
	}

	let pattern = trimmedModel;

	if (!provider) {
		const slashIndex = cliModel.indexOf("/");
		if (slashIndex !== -1) {
			const maybeProvider = cliModel.substring(0, slashIndex);
			const canonical = providerMap.get(maybeProvider.toLowerCase());
			if (canonical) {
				provider = canonical;
				pattern = cliModel.substring(slashIndex + 1);
			}
		}
	} else {
		const prefix = `${provider}/`;
		if (cliModel.toLowerCase().startsWith(prefix.toLowerCase())) {
			pattern = cliModel.substring(prefix.length);
		}
	}

	if (provider) {
		const exactProviderMatch = resolveProviderModelReference(provider, pattern, allModels);
		if (exactProviderMatch) {
			return {
				model: exactProviderMatch,
				selector: formatModelString(exactProviderMatch),
				warning: undefined,
				thinkingLevel: undefined,
				error: undefined,
			};
		}
	}

	const candidates = provider ? allModels.filter(model => model.provider === provider) : availableModels;
	// Keep the explicit provider on the pattern: the raw-id phase provider-locks `google/gemini-x` to the bundled
	// `google` provider unless the selector names the aggregator carrying it (`openrouter/google/gemini-x@upstream`).
	let parsed = parseModelPattern(provider ? `${provider}/${pattern}` : pattern, candidates, preferences, {
		allowInvalidThinkingSelectorFallback: false,
	});
	if (!parsed.model && !provider) {
		parsed = parseModelPattern(pattern, allModels, preferences, {
			allowInvalidThinkingSelectorFallback: false,
		});
	}
	const { model, thinkingLevel, warning, upstream } = parsed;

	if (!model) {
		const display = provider ? `${provider}/${pattern}` : cliModel;
		return {
			model: undefined,
			configuredPatterns,
			selector: undefined,
			thinkingLevel: undefined,
			warning,
			error: `Model "${display}" not found. Run "proto models" to see available models.`,
		};
	}

	let selector = provider ? formatModelString(model) : undefined;
	if (selector !== undefined && upstream) {
		selector = `${selector}@${upstream}`;
	}

	return {
		model,
		selector,
		thinkingLevel,
		warning,
		error: undefined,
	};
}
