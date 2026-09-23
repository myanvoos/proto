import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import {
	formatModelSelectorValue,
	formatModelString,
	formatModelStringWithRouting,
	parseModelString,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { resolveThinkingLevelForModel } from "../thinking";

export type RetryFallbackChains = Record<string, string[]>;

export type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

export interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel | undefined;
}

interface RetryFallbackModelLookup {
	find(provider: string, id: string): Model | undefined;
	hasProvider(provider: string): boolean;
}

export interface RetryFallbackResolutionContext {
	chains: RetryFallbackChains;
	getModelRole(role: string): string | undefined;
	modelLookup: RetryFallbackModelLookup;
}

export interface ActiveRetryFallbackState {
	role: string;
	originalSelector: string;
	originalThinkingLevel: ThinkingLevel | undefined;
	lastAppliedFallbackThinkingLevel: ThinkingLevel | undefined;
	pinned: boolean;

	served?: boolean;
}

export interface ServingModel {
	selector: string;

	isFallback: boolean;
}

const RETRY_BACKOFF_MAX_DELAY_MS = 8_000;
const RETRY_BACKOFF_JITTER_RATIO = 0.25;

export function calculateRetryBackoffDelayMs(baseDelayMs: number, attempt: number): number {
	const cappedDelayMs = Math.min(Math.max(0, baseDelayMs) * 2 ** Math.max(0, attempt - 1), RETRY_BACKOFF_MAX_DELAY_MS);
	const jitter = 1 - Math.random() * RETRY_BACKOFF_JITTER_RATIO;
	return cappedDelayMs * jitter;
}

export function parseRetryFallbackSelector(
	selector: string,
	modelLookup?: Pick<RetryFallbackModelLookup, "find">,
): RetryFallbackSelector | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const parsed = parseModelString(trimmed, {
		allowMaxSuffix: true,
		isLiteralModelId: (provider, id) => modelLookup?.find(provider, id) !== undefined,
	});
	if (!parsed) return undefined;
	return {
		raw: trimmed,
		provider: parsed.provider,
		id: parsed.id,
		thinkingLevel: parsed.thinkingLevel,
	};
}

function isRetryFallbackModelKey(key: string): boolean {
	return key.includes("/");
}

function isRetryFallbackWildcardKey(key: string): boolean {
	return key.endsWith("/*");
}

function parseRetryFallbackWildcard(
	key: string,
	isKnownProvider: (provider: string) => boolean,
): { provider: string; idPrefix: string | undefined } {
	const template = key.slice(0, -2);
	const slash = template.indexOf("/");
	if (slash < 0 || isKnownProvider(template)) return { provider: template, idPrefix: undefined };
	return { provider: template.slice(0, slash), idPrefix: template.slice(slash + 1) };
}

export function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
	return formatModelSelectorValue(formatModelStringWithRouting(model), thinkingLevel);
}

function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}

export function isKnownProvider(modelRegistry: ModelRegistry, provider: string): boolean {
	return modelRegistry.hasProvider(provider);
}

export function expandDefaultRetryFallbackChains(
	configuredChains: RetryFallbackChains,
	roleNames: readonly string[],
): RetryFallbackChains {
	const chains: RetryFallbackChains = { ...configuredChains };
	const defaultChain = chains.default;
	if (!Array.isArray(defaultChain)) return chains;
	for (const role of roleNames) {
		if (role !== "default" && chains[role] === undefined) chains[role] = defaultChain;
	}
	return chains;
}

export function getRetryFallbackChains(settings: Settings): RetryFallbackChains {
	const configuredChains = settings.get("retry.fallbackChains");
	if (!configuredChains || typeof configuredChains !== "object") return {};
	return expandDefaultRetryFallbackChains(configuredChains, Object.keys(settings.getModelRoles()));
}

// `isDiscoveryPending` suppresses "unknown model" for selectors whose discovery provider has not populated the
// registry yet; callers re-check once discovery settles. Logging is the caller's job so a re-run does not double-log.
export function validateRetryFallbackChains(
	settings: Settings,
	modelRegistry: ModelRegistry,
	report: (message: string) => void,
	options: { isDiscoveryPending?: (provider: string) => boolean } = {},
): void {
	const configuredChains = settings.get("retry.fallbackChains");
	if (configuredChains === undefined) return;
	const isDiscoveryPending = options.isDiscoveryPending ?? (() => false);
	if (!configuredChains || typeof configuredChains !== "object" || Array.isArray(configuredChains)) {
		report("retry.fallbackChains must be a mapping of role names or model selectors to selector arrays.");
		return;
	}

	for (const key in configuredChains) {
		const chain = configuredChains[key];
		const keyKind = isRetryFallbackModelKey(key) ? "model" : "role";
		if (keyKind === "model") {
			if (isRetryFallbackWildcardKey(key)) {
				const { provider } = parseRetryFallbackWildcard(key, candidate =>
					isKnownProvider(modelRegistry, candidate),
				);
				if (!isKnownProvider(modelRegistry, provider)) {
					report(`retry.fallbackChains wildcard key references unknown provider: ${key}`);
				}
			} else {
				const parsedKey = parseRetryFallbackSelector(key, modelRegistry);
				if (!parsedKey) {
					report(`Invalid model selector key in retry.fallbackChains: ${key}`);
				} else if (
					!modelRegistry.find(parsedKey.provider, parsedKey.id) &&
					!isDiscoveryPending(parsedKey.provider)
				) {
					report(`retry.fallbackChains key references unknown model: ${key}`);
				}
			}
		}
		if (!Array.isArray(chain)) {
			report(`Fallback chain for ${keyKind} '${key}' must be an array of selector strings.`);
			continue;
		}
		for (const selectorStr of chain) {
			if (typeof selectorStr !== "string") {
				report(`Fallback chain for ${keyKind} '${key}' contains a non-string selector.`);
				continue;
			}
			if (isRetryFallbackWildcardKey(selectorStr)) {
				const { provider } = parseRetryFallbackWildcard(selectorStr, candidate =>
					isKnownProvider(modelRegistry, candidate),
				);
				if (!isKnownProvider(modelRegistry, provider)) {
					report(`Fallback chain for ${keyKind} '${key}' references unknown provider: ${selectorStr}`);
				}
				continue;
			}
			const parsed = parseRetryFallbackSelector(selectorStr, modelRegistry);
			if (!parsed) {
				report(`Invalid fallback selector format in ${keyKind} '${key}': ${selectorStr}`);
				continue;
			}
			if (!modelRegistry.find(parsed.provider, parsed.id) && !isDiscoveryPending(parsed.provider)) {
				report(`Fallback chain for ${keyKind} '${key}' references unknown model: ${selectorStr}`);
			}
		}
	}
}

export function getRetryFallbackRevertPolicy(settings: Settings): RetryFallbackRevertPolicy {
	return settings.get("retry.fallbackRevertPolicy") === "never" ? "never" : "cooldown-expiry";
}

function getRetryFallbackPrimarySelector(
	context: RetryFallbackResolutionContext,
	chainKey: string,
): RetryFallbackSelector | undefined {
	if (isRetryFallbackWildcardKey(chainKey)) return undefined;
	if (isRetryFallbackModelKey(chainKey)) return parseRetryFallbackSelector(chainKey, context.modelLookup);
	const configuredSelector = context.getModelRole(chainKey);
	return configuredSelector ? parseRetryFallbackSelector(configuredSelector, context.modelLookup) : undefined;
}

type SelectorMatchKind = "exact" | "normalized" | "base" | "none";

/**
 * Classify a chain key's primary against the current selector on parsed values, so effort
 * aliases (`hi`) match their canonical form. `normalized`: both efforts clamp to the same
 * level on the active model (`max` vs `high` on a high-capped model). `base`: a suffixless
 * key matches the model at any effort. A distinct explicit effort never matches.
 */
function selectorMatchKind(
	primary: RetryFallbackSelector | undefined,
	current: RetryFallbackSelector,
	currentPlain: RetryFallbackSelector | undefined,
	currentModel: Model | null | undefined,
): SelectorMatchKind {
	if (!primary) return "none";
	let matchedCurrent: RetryFallbackSelector | undefined;
	if (primary.provider === current.provider && primary.id === current.id) {
		matchedCurrent = current;
	} else if (currentPlain && primary.provider === currentPlain.provider && primary.id === currentPlain.id) {
		matchedCurrent = currentPlain;
	}
	if (!matchedCurrent) return "none";
	if (primary.thinkingLevel === matchedCurrent.thinkingLevel) return "exact";
	if (primary.thinkingLevel === undefined) return "base";
	if (
		currentModel &&
		resolveThinkingLevelForModel(currentModel, primary.thinkingLevel) ===
			resolveThinkingLevelForModel(currentModel, matchedCurrent.thinkingLevel)
	) {
		return "normalized";
	}
	return "none";
}

export function resolveRetryFallbackChainKey(
	context: RetryFallbackResolutionContext,
	currentSelector: string,
	currentModel?: Model | null,
	roleHint?: string,
): string | undefined {
	const parsedConfigured = parseRetryFallbackSelector(currentSelector, context.modelLookup);
	const currentPlainSelector = currentModel
		? formatModelSelectorValue(formatModelString(currentModel), parsedConfigured?.thinkingLevel)
		: undefined;
	const parsedCurrent =
		parsedConfigured ??
		(currentPlainSelector ? parseRetryFallbackSelector(currentPlainSelector, context.modelLookup) : undefined);
	if (!parsedCurrent) {
		if (roleHint && Array.isArray(context.chains[roleHint])) return roleHint;
		return undefined;
	}
	const parsedPlainCurrent =
		currentPlainSelector && currentPlainSelector !== currentSelector
			? (parseRetryFallbackSelector(currentPlainSelector, context.modelLookup) ?? parsedCurrent)
			: undefined;

	// Exact effort beats model-normalized effort, which beats a suffixless key, regardless of key order.
	let normalizedModelKey: string | undefined;
	let baseModelKey: string | undefined;
	for (const key in context.chains) {
		if (!isRetryFallbackModelKey(key) || isRetryFallbackWildcardKey(key)) continue;
		const kind = selectorMatchKind(
			getRetryFallbackPrimarySelector(context, key),
			parsedCurrent,
			parsedPlainCurrent,
			currentModel,
		);
		if (kind === "exact") return key;
		if (kind === "normalized") normalizedModelKey ??= key;
		if (kind === "base") baseModelKey ??= key;
	}
	if (normalizedModelKey) return normalizedModelKey;
	if (baseModelKey) return baseModelKey;

	let wildcardMatch: string | undefined;
	let wildcardPrefixLength = -1;
	for (const key in context.chains) {
		if (!isRetryFallbackWildcardKey(key) || !Array.isArray(context.chains[key])) continue;
		const { provider, idPrefix } = parseRetryFallbackWildcard(key, provider =>
			context.modelLookup.hasProvider(provider),
		);
		if (provider !== parsedCurrent.provider) continue;
		if (idPrefix !== undefined && !parsedCurrent.id.startsWith(`${idPrefix}/`)) continue;
		const prefixLength = idPrefix?.length ?? 0;
		if (prefixLength > wildcardPrefixLength) {
			wildcardMatch = key;
			wildcardPrefixLength = prefixLength;
		}
	}
	if (wildcardMatch) return wildcardMatch;

	if (roleHint && Array.isArray(context.chains[roleHint])) return roleHint;
	let matchedRole: string | undefined;
	for (const key in context.chains) {
		if (isRetryFallbackModelKey(key)) continue;
		if (
			selectorMatchKind(
				getRetryFallbackPrimarySelector(context, key),
				parsedCurrent,
				parsedPlainCurrent,
				currentModel,
			) !== "none"
		) {
			if (key === "default") return "default";
			matchedRole ??= key;
		}
	}
	if (matchedRole) return matchedRole;

	// The default chain applies even when its role primary is a different model than the live one
	// (e.g. after /model), so a retry past maxDelayMs still reaches a fallback.
	const defaultChain = context.chains.default;
	if (Array.isArray(defaultChain) && defaultChain.length > 0) return "default";
	return undefined;
}

function parseRetryFallbackChainEntry(
	context: RetryFallbackResolutionContext,
	entry: string,
	current: RetryFallbackSelector | undefined,
): RetryFallbackSelector | undefined {
	if (!isRetryFallbackWildcardKey(entry)) return parseRetryFallbackSelector(entry, context.modelLookup);
	if (!current) return undefined;
	const { provider, idPrefix } = parseRetryFallbackWildcard(entry, candidate =>
		context.modelLookup.hasProvider(candidate),
	);
	const bareId = current.id.slice(current.id.lastIndexOf("/") + 1);
	let id: string;
	if (idPrefix !== undefined) {
		id = `${idPrefix}/${bareId}`;
	} else if (
		bareId !== current.id &&
		!context.modelLookup.find(provider, current.id) &&
		context.modelLookup.find(provider, bareId)
	) {
		id = bareId;
	} else {
		id = current.id;
	}
	return { raw: `${provider}/${id}`, provider, id, thinkingLevel: undefined };
}

function getRetryFallbackEffectiveChain(
	context: RetryFallbackResolutionContext,
	chainKey: string,
	currentSelector: string,
	currentModel: Model | null | undefined,
	allowMissingPrimary: boolean,
): RetryFallbackSelector[] {
	const parsedConfigured = parseRetryFallbackSelector(currentSelector, context.modelLookup);
	const parsedCurrent =
		parsedConfigured ??
		(currentModel
			? parseRetryFallbackSelector(
					formatModelSelectorValue(formatModelString(currentModel), undefined),
					context.modelLookup,
				)
			: undefined);
	const seen = new Set<string>();
	const chain: RetryFallbackSelector[] = [];
	if (isRetryFallbackWildcardKey(chainKey)) {
		if (parsedCurrent) {
			chain.push(parsedCurrent);
			seen.add(parsedCurrent.raw);
		}
	} else {
		const primarySelector = getRetryFallbackPrimarySelector(context, chainKey);
		if (primarySelector) {
			chain.push(primarySelector);
			seen.add(primarySelector.raw);
		} else if ((chainKey === "default" || allowMissingPrimary) && parsedCurrent) {
			chain.push(parsedCurrent);
			seen.add(parsedCurrent.raw);
		} else if (!allowMissingPrimary) {
			return [];
		}
	}
	for (const selector of context.chains[chainKey] ?? []) {
		const parsed = parseRetryFallbackChainEntry(context, selector, parsedCurrent);
		if (!parsed || seen.has(parsed.raw)) continue;
		seen.add(parsed.raw);
		chain.push(parsed);
	}
	return chain;
}

export function findRetryFallbackCandidates(
	context: RetryFallbackResolutionContext,
	chainKey: string,
	currentSelector: string,
	currentModel?: Model | null,
	options?: { allowMissingPrimary?: boolean; wrapAround?: boolean },
): RetryFallbackSelector[] {
	const chain = getRetryFallbackEffectiveChain(
		context,
		chainKey,
		currentSelector,
		currentModel,
		options?.allowMissingPrimary === true,
	);
	const parsedConfigured = parseRetryFallbackSelector(currentSelector, context.modelLookup);
	const currentPlainSelector = currentModel
		? formatModelSelectorValue(formatModelString(currentModel), parsedConfigured?.thinkingLevel)
		: undefined;
	const parsedCurrent =
		parsedConfigured ??
		(currentPlainSelector ? parseRetryFallbackSelector(currentPlainSelector, context.modelLookup) : undefined);
	if (!parsedCurrent) return chain;
	if (chain.length <= 1) return [];
	const currentBaseSelector = formatRetryFallbackBaseSelector(parsedCurrent);
	const currentPlainBaseSelector =
		parsedCurrent && currentPlainSelector && currentPlainSelector !== currentSelector
			? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(currentPlainSelector) ?? parsedCurrent)
			: undefined;
	const exactIndex = chain.findIndex(
		selector => selector.raw === currentSelector || selector.raw === currentPlainSelector,
	);
	const currentIndex =
		exactIndex >= 0
			? exactIndex
			: chain.findIndex(selector => {
					const selectorBase = formatRetryFallbackBaseSelector(selector);
					return selectorBase === currentBaseSelector || selectorBase === currentPlainBaseSelector;
				});
	// A live model outside the chain (e.g. after /model) may fall back to every entry.
	if (currentIndex < 0) return chain;
	const candidatesAfter = chain.slice(currentIndex + 1);
	return options?.wrapAround ? [...candidatesAfter, ...chain.slice(0, currentIndex)] : candidatesAfter;
}
