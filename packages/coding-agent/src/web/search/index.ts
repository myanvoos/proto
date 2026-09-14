import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { formatCount, prompt, truncate } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../config/model-registry";
import { settings } from "../../config/settings";
import type { CustomTool, CustomToolContext, RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import webSearchSystemPrompt from "../../prompts/system/web-search.md" with { type: "text" };
import webSearchDescription from "../../prompts/tools/web-search.md" with { type: "text" };
import { discoverAuthStorage } from "../../session/auth-broker-config";
import type { ToolSession } from "../../tools";
import { formatAge } from "../../tools/render-utils";
import { throwIfAborted } from "../../tools/tool-errors";
import {
	formatSearchProviderFailure,
	formatSearchProviderFailures,
	getSearchProvider,
	getSearchProviderLabel,
	resolveProviderCandidates,
	type SearchProvider,
	type SearchProviderCandidate,
} from "./provider";
import { applyQueryConstraints, getQueryConstraintLabels, parseSearchQuery, type StructuredQuery } from "./query";
import {
	formatConstraintLine,
	formatSearchResultCount,
	renderSearchCall,
	renderSearchResult,
	type SearchRenderDetails,
	stripSearchReferenceSections,
} from "./render";
import {
	DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	MAX_WEB_SEARCH_TIMEOUT_SECONDS,
	mergeSearchReferences,
	type SearchConstraintApplication,
	SearchProviderError,
	type SearchProviderId,
	type SearchResponse,
} from "./types";

const webSearchSchema = type({
	query: "string",
	recency: "'day' | 'week' | 'month' | 'year'?",
	limit: "number?",
	max_tokens: "number?",
	temperature: "number?",
	num_search_results: "number?",
});

export type SearchToolParams = typeof webSearchSchema.infer;

export interface SearchQueryParams extends SearchToolParams {
	provider?: SearchProviderId | "auto";
}

export function formatForLLM(response: SearchResponse): string {
	const normalized = mergeSearchReferences(response);
	const parts: string[] = [];
	const hasReferences = normalized.sources.length > 0 || (normalized.citations?.length ?? 0) > 0;
	const answer = normalized.answer
		? hasReferences
			? stripSearchReferenceSections(normalized.answer)
			: normalized.answer.trim()
		: "";
	if (answer) parts.push(answer);

	const constraintLine = normalized.constraintApplications
		? formatConstraintLine(normalized.constraintApplications)
		: undefined;
	if (constraintLine) parts.push(constraintLine);

	if (normalized.sources.length > 0) {
		parts.push("\n## Sources");
		parts.push(formatSearchResultCount(normalized.sources.length, normalized.requestedResultCount));
		for (const [i, src] of normalized.sources.entries()) {
			const age = formatAge(src.ageSeconds) || src.publishedDate;
			const agePart = age ? ` (${age})` : "";
			parts.push(`[${i + 1}] ${src.title}${agePart}\n    ${src.url}`);
			if (src.snippet) parts.push(`    ${truncate(src.snippet, 240)}`);
		}
	}

	if (normalized.citations && normalized.citations.length > 0) {
		parts.push("\n## Citations");
		parts.push(formatCount("citation", normalized.citations.length));
		for (const [i, citation] of normalized.citations.entries()) {
			const title = citation.title || citation.url;
			const number = normalized.sources.length + i + 1;
			parts.push(`[${number}] ${title}\n    ${citation.url}`);
			if (citation.citedText) parts.push(`    ${truncate(citation.citedText, 240)}`);
		}
	}

	if (normalized.relatedQuestions && normalized.relatedQuestions.length > 0) {
		parts.push("\n## Related");
		parts.push(formatCount("question", normalized.relatedQuestions.length));
		for (const q of normalized.relatedQuestions) parts.push(`- ${q}`);
	}

	if (normalized.searchQueries && normalized.searchQueries.length > 0) {
		parts.push(`Search queries: ${normalized.searchQueries.length}`);
		for (const query of normalized.searchQueries.slice(0, 3)) parts.push(`- ${truncate(query, 120)}`);
	}

	return parts.join("\n");
}

function hasRenderableSearchContent(response: SearchResponse): boolean {
	if (response.answer?.trim()) return true;
	if (response.sources.length > 0) return true;
	if (response.citations?.length) return true;
	if (response.relatedQuestions?.some(question => question.trim())) return true;
	if (response.searchQueries?.some(query => query.trim())) return true;
	return false;
}

interface ExecuteSearchOptions {
	authStorage: AuthStorage;
	modelRegistry?: ModelRegistry;
	sessionId?: string;
	signal?: AbortSignal;
}

function buildConstraintApplications(
	parsedQuery: StructuredQuery,
	providerId: SearchProviderId,
	existing: readonly SearchConstraintApplication[] | undefined,
): SearchConstraintApplication[] {
	if (!parsedQuery.hasConstraints) return [];
	const existingByOperator = new Map((existing ?? []).map(application => [application.operator, application]));
	const nativeOperators = new Map<string, string>();
	if (providerId === "anthropic") {
		if (parsedQuery.sites.length > 0) {
			nativeOperators.set(parsedQuery.sites.map(site => `site:${site}`).join(" OR "), "allowed_domains");
		} else if (parsedQuery.excludedSites.length > 0) {
			nativeOperators.set(parsedQuery.excludedSites.map(site => `-site:${site}`).join(" "), "blocked_domains");
		}
	}
	return getQueryConstraintLabels(parsedQuery).map(operator => {
		const known = existingByOperator.get(operator);
		if (known) return { ...known };
		const nativeDetail = nativeOperators.get(operator);
		if (nativeDetail) return { operator, mode: "native", detail: nativeDetail };
		if (/^(?:-)?intext:|^lang:/i.test(operator)) return { operator, mode: "unsupported", relaxed: true };
		return { operator, mode: "post-filtered" };
	});
}

async function executeSearch(
	_toolCallId: string,
	params: SearchQueryParams,
	options: ExecuteSearchOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchRenderDetails }> {
	const { authStorage, modelRegistry, sessionId, signal } = options;
	const explicitProvider = params.provider;
	let candidates: SearchProviderCandidate[];
	if (explicitProvider && explicitProvider !== "auto") {
		candidates = [{ id: explicitProvider, explicit: true }];
	} else {
		candidates = resolveProviderCandidates();
	}

	const parsedQuery = parseSearchQuery(params.query);

	let antigravityEndpointMode: "auto" | "production" | "sandbox" | undefined;
	try {
		antigravityEndpointMode = settings.get("providers.antigravityEndpoint");
	} catch {
		antigravityEndpointMode = undefined;
	}

	let geminiModel: string | undefined;
	try {
		geminiModel = settings.get("providers.webSearchGeminiModel");
	} catch {
		geminiModel = undefined;
	}

	let timeoutMs = DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1_000;
	try {
		const configuredSeconds = settings.get("providers.webSearchTimeoutSeconds");
		if (Number.isFinite(configuredSeconds) && configuredSeconds > 0) {
			timeoutMs = Math.ceil(Math.min(configuredSeconds, MAX_WEB_SEARCH_TIMEOUT_SECONDS) * 1_000);
		}
	} catch {}

	const failures: Array<{ provider: Pick<SearchProvider, "id" | "label">; error: unknown }> = [];
	let availableProviderCount = 0;
	let lastProvider: Pick<SearchProvider, "id" | "label"> | undefined;
	for (const candidate of candidates) {
		let provider: SearchProvider | undefined;
		const providerMeta = { id: candidate.id, label: getSearchProviderLabel(candidate.id) };
		lastProvider = providerMeta;
		try {
			provider = await getSearchProvider(candidate.id);
			const available = candidate.explicit
				? await provider.isExplicitlyAvailable(authStorage)
				: await provider.isAvailable(authStorage);
			if (!available && !candidate.explicit) continue;
			if (!available && candidate.explicit) {
				throw new SearchProviderError(
					provider.id,
					`${provider.label} web search is unavailable. Configure its credentials or select the automatic provider chain.`,
				);
			}
			availableProviderCount++;
			lastProvider = provider;

			const response = await provider.search({
				query: params.query,
				parsedQuery,
				limit: params.limit,
				recency: params.recency,
				systemPrompt: webSearchSystemPrompt,
				maxOutputTokens: params.max_tokens,
				numSearchResults: params.num_search_results,
				temperature: params.temperature,
				signal,
				timeoutMs,
				authStorage,
				modelRegistry,
				sessionId,
				antigravityEndpointMode,
				geminiModel,
			});

			let finalResponse = mergeSearchReferences(response);
			const constraintApplications = buildConstraintApplications(
				parsedQuery,
				provider.id,
				finalResponse.constraintApplications,
			);
			const requestedResultCount = params.num_search_results ?? params.limit;
			if (requestedResultCount !== undefined) {
				finalResponse = { ...finalResponse, requestedResultCount };
			}
			if (parsedQuery.hasConstraints) {
				const filtered = applyQueryConstraints(finalResponse.sources, parsedQuery);
				const applications = constraintApplications.map(application =>
					filtered.dropped.includes(application.operator) ? { ...application, relaxed: true } : application,
				);
				finalResponse = { ...finalResponse, sources: filtered.sources, constraintApplications: applications };
			} else if (constraintApplications.length > 0) {
				finalResponse = { ...finalResponse, constraintApplications };
			}

			if (!hasRenderableSearchContent(finalResponse)) {
				throw new SearchProviderError(provider.id, `${provider.label} returned no renderable search content.`, 204);
			}

			const text = formatForLLM(finalResponse);

			return {
				content: [{ type: "text" as const, text }],
				details: { response: finalResponse },
			};
		} catch (error) {
			throwIfAborted(signal);
			failures.push({ provider: provider ?? providerMeta, error });
		}
	}

	if (availableProviderCount === 0 && failures.length === 0) {
		const message = "No web search provider configured.";
		return {
			content: [{ type: "text" as const, text: `Error: ${message}` }],
			details: { response: { provider: "none", sources: [] }, error: message },
		};
	}

	const lastFailure = failures[failures.length - 1];
	const baseMessage = lastFailure
		? formatSearchProviderFailure(lastFailure.error, lastFailure.provider)
		: `Unknown error from ${lastProvider?.label ?? "web search provider"}`;
	const message =
		failures.length > 1 ? `All web search providers failed: ${formatSearchProviderFailures(failures)}` : baseMessage;

	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: {
			response: { provider: lastFailure?.provider.id ?? lastProvider?.id ?? "none", sources: [] },
			error: message,
		},
	};
}

export async function runSearchQuery(
	params: SearchQueryParams,
	options: { authStorage?: AuthStorage; modelRegistry?: ModelRegistry; sessionId?: string; signal?: AbortSignal } = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchRenderDetails }> {
	const createdAuthStorage = options.authStorage || options.modelRegistry ? undefined : await discoverAuthStorage();
	const authStorage = options.authStorage ?? options.modelRegistry?.authStorage ?? createdAuthStorage;
	if (!authStorage) {
		throw new Error("Failed to initialize authentication storage");
	}
	const modelRegistry = options.modelRegistry ?? (createdAuthStorage ? new ModelRegistry(authStorage) : undefined);
	try {
		return await executeSearch("cli-web-search", params, {
			authStorage,
			modelRegistry,
			sessionId: options.sessionId,
			signal: options.signal,
		});
	} finally {
		createdAuthStorage?.close();
	}
}

export class WebSearchTool implements AgentTool<typeof webSearchSchema, SearchRenderDetails> {
	readonly name = "web_search";
	readonly label = "Web Search";
	readonly description: string;
	readonly parameters = webSearchSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly summary = "Search the web for up-to-date information";

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = prompt.render(webSearchDescription);
	}

	async execute(
		_toolCallId: string,
		params: SearchToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchRenderDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchRenderDetails>> {
		const authStorage = this.#session.authStorage ?? (await discoverAuthStorage());
		const sessionId = this.#session.getSessionId?.() ?? undefined;
		return executeSearch(_toolCallId, params, {
			authStorage,
			modelRegistry: this.#session.modelRegistry,
			sessionId,
			signal,
		});
	}
}

const webSearchCustomTool: CustomTool<typeof webSearchSchema, SearchRenderDetails> = {
	name: "web_search",
	label: "Web Search",
	description: prompt.render(webSearchDescription),
	parameters: webSearchSchema,

	async execute(
		toolCallId: string,
		params: SearchToolParams,
		_onUpdate,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	) {
		const authStorage = ctx.modelRegistry?.authStorage ?? (await discoverAuthStorage());
		const sessionId = ctx.sessionManager.getSessionId();
		return executeSearch(toolCallId, params, {
			authStorage,
			modelRegistry: ctx.modelRegistry,
			sessionId,
			signal,
		});
	},

	renderCall(args: SearchToolParams, options: RenderResultOptions, theme: Theme) {
		return renderSearchCall(args, options, theme);
	},

	renderResult(result, options: RenderResultOptions, theme: Theme, args) {
		return renderSearchResult(result, options, theme, args);
	},
};

export function getSearchTools(): CustomTool<any, any>[] {
	return [webSearchCustomTool];
}

export { getSearchProvider, setExcludedSearchProviders, setSearchProviderOrder } from "./provider";
export type { SearchProviderId as SearchProvider, SearchResponse } from "./types";
export { isSearchProviderId, isSearchProviderPreference } from "./types";
