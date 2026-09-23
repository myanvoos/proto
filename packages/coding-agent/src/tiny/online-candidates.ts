import type { Api, Model } from "@oh-my-pi/pi-ai";
import { formatModelStringWithRouting, resolveModelOverride, resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import {
	expandDefaultRetryFallbackChains,
	findRetryFallbackCandidates,
	type RetryFallbackChains,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "../session/retry-fallback-chains";

/** Role-resolved model tried by online background tasks (session titles). */
export interface OnlineTinyCandidate {
	role: string;
	model: Model<Api>;
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

// Dedup key that keeps distinct `@upstream` routes of one model as separate candidates.
function candidateKey(model: Model<Api>): string {
	return formatModelStringWithRouting(model);
}

function createFallbackContext(
	chains: RetryFallbackChains,
	settings: Settings,
	availableModels: Model<Api>[],
): RetryFallbackResolutionContext {
	return {
		chains,
		getModelRole: role => settings.getModelRole(role),
		modelLookup: {
			find: (provider, id) => availableModels.find(model => model.provider === provider && model.id === id),
			hasProvider: provider => availableModels.some(model => model.provider === provider),
		},
	};
}

interface ExpandItem {
	role: string;
	model: Model<Api>;
	/** Selector that picks which chain key applies. */
	selector: string;
	roleHint?: string;
}

// Transitively expand retry fallbacks from `seeds` into `out`: landing on B also consults B's own chain, as session
// recovery does. Callers decide whether `context.chains` already merged role defaults.
function expandFallbackCandidates(
	seeds: ExpandItem[],
	context: RetryFallbackResolutionContext,
	settings: Settings,
	availableModels: Model<Api>[],
	seen: Set<string>,
	out: OnlineTinyCandidate[],
): void {
	const registryShim = { getAvailable: () => availableModels };
	const queue = [...seeds];
	const expanded = new Set<string>();
	while (queue.length > 0) {
		const { role, model, selector, roleHint } = queue.shift()!;
		const chainKey = resolveRetryFallbackChainKey(context, selector, model, roleHint);
		if (!chainKey) continue;
		const expandKey = `${chainKey}\0${candidateKey(model)}`;
		if (expanded.has(expandKey)) continue;
		expanded.add(expandKey);
		// The resolved provider/id is the chain primary: bare or fuzzy role selectors and `@upstream` suffixes must not
		// empty the chain or poison wildcards.
		for (const candidate of findRetryFallbackCandidates(context, chainKey, modelKey(model), model, {
			allowMissingPrimary: true,
		})) {
			// Resolve raw selectors (`@upstream`, fuzzy ids) the way turn recovery does, not by exact lookup only.
			const fallback =
				resolveModelOverride([candidate.raw], registryShim, settings).model ??
				context.modelLookup.find(candidate.provider, candidate.id);
			if (!fallback) continue;
			const key = candidateKey(fallback);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ role, model: fallback });
			queue.push({ role, model: fallback, selector: formatModelStringWithRouting(fallback) });
		}
	}
}

/**
 * Unique online models for lightweight background tasks: each requested role's primary, then the canonical
 * `retry.fallbackChains` expanded transitively. With `retry.modelFallback` off, only the first resolvable primary.
 */
export function collectOnlineTinyCandidates(
	roles: readonly string[],
	settings: Settings,
	availableModels: Model<Api>[],
): OnlineTinyCandidate[] {
	const seen = new Set<string>();
	const out: OnlineTinyCandidate[] = [];
	const fallbackEnabled = settings.get("retry.modelFallback") !== false;
	// Keep every role even when primaries coincide: their fallback chains can differ.
	const primaries: OnlineTinyCandidate[] = [];
	for (const role of roles) {
		const model = resolveRoleSelection([role], settings, availableModels)?.model;
		if (!model) continue;
		const key = candidateKey(model);
		if (!seen.has(key)) {
			seen.add(key);
			out.push({ role, model });
		}
		if (!fallbackEnabled) return out;
		primaries.push({ role, model });
	}

	const configuredChains = settings.get("retry.fallbackChains");
	if (!configuredChains || typeof configuredChains !== "object") return out;
	expandFallbackCandidates(
		primaries.map(({ role, model }) => ({
			role,
			model,
			selector: settings.getModelRole(role) ?? modelKey(model),
			roleHint: role,
		})),
		createFallbackContext(expandDefaultRetryFallbackChains(configuredChains, roles), settings, availableModels),
		settings,
		availableModels,
		seen,
		out,
	);
	return out;
}

/**
 * Expand one model's own `retry.fallbackChains` transitively, without merging role/`default` chains into it: the
 * session model appended after the title roles must consult only its model-keyed, wildcard, or matching-role keys.
 */
export function expandOnlineTinyModelFallbacks(
	model: Model<Api>,
	settings: Settings,
	availableModels: Model<Api>[],
): Model<Api>[] {
	if (settings.get("retry.modelFallback") === false) return [model];
	const configuredChains = settings.get("retry.fallbackChains");
	if (!configuredChains || typeof configuredChains !== "object") return [model];
	const out: OnlineTinyCandidate[] = [{ role: "current", model }];
	expandFallbackCandidates(
		[{ role: "current", model, selector: formatModelStringWithRouting(model) }],
		createFallbackContext(configuredChains, settings, availableModels),
		settings,
		availableModels,
		new Set([candidateKey(model)]),
		out,
	);
	return out.map(candidate => candidate.model);
}
