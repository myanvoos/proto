import { afterEach, beforeEach, expect, spyOn, test, vi } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import * as providerRegistry from "../provider";
import type { SearchProviderId, SearchResponse } from "../types";
import type { SearchParams, SearchProvider } from "./base";
import { searchPublicWeb } from "./public";

let authStorage: AuthStorage;

beforeEach(async () => {
	authStorage = await AuthStorage.create(":memory:");
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	authStorage.close();
});

function stubProvider(id: SearchProviderId, search: (params: SearchParams) => Promise<SearchResponse>): SearchProvider {
	return {
		id,
		label: id,
		isAvailable: () => true,
		isExplicitlyAvailable: () => true,
		search,
	};
}

test("an early empty engine does not abort a slower engine with results", async () => {
	const slower = Promise.withResolvers<SearchResponse>();
	const empty = stubProvider("startpage", async () => ({ provider: "startpage", sources: [] }));
	const result = stubProvider("google", () => slower.promise);
	const failed = (id: SearchProviderId) =>
		stubProvider(id, async () => {
			throw new Error(`${id} unavailable`);
		});
	const providers: Partial<Record<SearchProviderId, SearchProvider>> = {
		startpage: empty,
		google: result,
		duckduckgo: failed("duckduckgo"),
		ecosia: failed("ecosia"),
		mojeek: failed("mojeek"),
	};
	spyOn(providerRegistry, "isSearchProviderExcluded").mockReturnValue(false);
	spyOn(providerRegistry, "getSearchProvider").mockImplementation(async id => {
		const provider = providers[id];
		if (!provider) throw new Error(`unexpected provider: ${id}`);
		return provider;
	});

	vi.useFakeTimers();
	const pending = searchPublicWeb({ query: "results", systemPrompt: "", authStorage }, { softMs: 1, hardMs: 100 });
	await Promise.resolve();
	await Promise.resolve();
	vi.advanceTimersByTime(1);
	await Promise.resolve();
	slower.resolve({
		provider: "google",
		sources: [{ title: "Survived", url: "https://example.test/result" }],
	});

	await expect(pending).resolves.toMatchObject({
		provider: "public",
		sources: [{ title: "Survived", url: "https://example.test/result" }],
	});
});
