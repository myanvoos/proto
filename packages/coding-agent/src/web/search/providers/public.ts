import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { formatSearchProviderFailures, getSearchProvider, isSearchProviderExcluded } from "../provider";
import type { SearchProviderId, SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { withHardTimeout } from "./utils";

const PUBLIC_ENGINE_IDS = [
	"startpage",
	"google",
	"duckduckgo",
	"ecosia",
	"mojeek",
] as const satisfies readonly SearchProviderId[];

const DEFAULT_NUM_RESULTS = 15;
const MAX_NUM_RESULTS = 30;

const SOFT_DEADLINE_MS = 5_000;

const HARD_DEADLINE_MS = 30_000;

interface PublicWebDeadlines {
	softMs?: number;
	hardMs?: number;
}

interface MergedSource {
	source: SearchSource;

	engines: number;

	bestRank: number;

	order: number;
}

function dedupKey(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		const host = url.hostname.toLowerCase().replace(/^www\./, "");
		let path = url.pathname;
		if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
		return `${host}${path}${url.search}`;
	} catch {
		return rawUrl;
	}
}

function mergeSources(merged: Map<string, MergedSource>, sources: readonly SearchSource[]): void {
	for (const [rank, source] of sources.entries()) {
		const key = dedupKey(source.url);
		const existing = merged.get(key);
		if (!existing) {
			merged.set(key, { source: { ...source }, engines: 1, bestRank: rank, order: merged.size });
			continue;
		}
		existing.engines += 1;
		if (rank < existing.bestRank) {
			existing.bestRank = rank;
			existing.source.title = source.title;
			existing.source.url = source.url;
		}

		if (source.snippet && source.snippet.length > (existing.source.snippet?.length ?? 0)) {
			existing.source.snippet = source.snippet;
		}
		existing.source.publishedDate ??= source.publishedDate;
		existing.source.ageSeconds ??= source.ageSeconds;
	}
}

export async function searchPublicWeb(
	params: SearchParams,
	deadlines: PublicWebDeadlines = {},
): Promise<SearchResponse> {
	const softMs = deadlines.softMs ?? SOFT_DEADLINE_MS;
	const hardMs = deadlines.hardMs ?? HARD_DEADLINE_MS;
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const engineIds = PUBLIC_ENGINE_IDS.filter(id => !isSearchProviderExcluded(id));
	if (engineIds.length === 0) {
		throw new SearchProviderError("public", "Every credential-free engine is excluded by settings.", 400);
	}

	const straggler = new AbortController();
	const signal = AbortSignal.any([withHardTimeout(params.signal, params.timeoutMs), straggler.signal]);

	const responses: (SearchResponse | undefined)[] = new Array(engineIds.length);
	const failures: { provider: { id: SearchProviderId; label: string }; error: unknown }[] = [];
	const firstSuccess = Promise.withResolvers<void>();
	const all = Promise.all(
		engineIds.map(async (id, index) => {
			try {
				const provider = await getSearchProvider(id);
				responses[index] = await provider.search({ ...params, signal });
				firstSuccess.resolve();
			} catch (error) {
				failures.push({ provider: { id, label: id }, error });
			}
		}),
	);

	await Promise.race([all, Bun.sleep(softMs)]);
	if (!responses.some(response => response !== undefined) && failures.length < engineIds.length) {
		await Promise.race([all, firstSuccess.promise, Bun.sleep(Math.max(0, hardMs - softMs))]);
	}
	straggler.abort();

	const merged = new Map<string, MergedSource>();
	for (const response of responses) {
		if (response) mergeSources(merged, response.sources);
	}

	if (merged.size === 0 && failures.length === engineIds.length) {
		throw new SearchProviderError(
			"public",
			`All public engines failed: ${formatSearchProviderFailures(failures)}`,
			503,
		);
	}

	const sources = [...merged.values()]
		.sort((a, b) => b.engines - a.engines || a.bestRank - b.bestRank || a.order - b.order)
		.slice(0, numResults)
		.map(entry => entry.source);

	return { provider: "public", sources };
}

export class PublicWebProvider extends SearchProvider {
	readonly id = "public";
	readonly label = "Public Web";

	isAvailable(_authStorage: AuthStorage): boolean {
		return false;
	}

	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchPublicWeb(params);
	}
}
