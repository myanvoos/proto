import { expect, spyOn, test } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { formatForLLM, runSearchQuery } from "./index";
import * as providerModule from "./provider";
import { setExcludedSearchProviders, setSearchProviderOrder } from "./provider";
import { parseAnthropicResponse } from "./providers/anthropic";
import type { SearchProvider } from "./providers/base";
import type { AnthropicApiResponse, SearchResponse } from "./types";

function anthropicFixture(): AnthropicApiResponse {
	return {
		id: "msg_fixture",
		model: "claude-haiku-4-5",
		usage: {
			input_tokens: 10,
			output_tokens: 30,
			server_tool_use: { web_search_requests: 1 },
		},
		content: [
			{
				type: "text",
				text: "Let me search for more specific information about this.",
			},
			{
				type: "server_tool_use",
				name: "web_search",
				input: { query: "example" },
			},
			{
				type: "web_search_tool_result",
				content: [
					{
						type: "web_search_result",
						title: "Example",
						url: "https://example.com/result",
						encrypted_content: "fixture",
						page_age: null,
					},
				],
			},
			{
				type: "text",
				text: "Based on the search results, I can provide you with information about this.",
			},
			{
				type: "text",
				text: "The answer frames",
			},
			{
				type: "text",
				text: ".",
			},
		],
	};
}

test("Anthropic search drops adjacent narration but keeps the synthesized answer", () => {
	const response = parseAnthropicResponse(anthropicFixture());

	expect(response.answer).toBe("The answer frames.");
	expect(response.answer).not.toContain("\n\n.");
	expect(response.answer).not.toContain("Let me search");
	expect(response.answer).not.toContain("Based on the search results");
});

test("search formatting merges citation URLs into sources and keeps global numbering", () => {
	const response: SearchResponse = {
		provider: "anthropic",
		answer: "An answer.\n\n## Sources\n[1] Old source\nhttps://old.example/source",
		sources: [
			{ title: "First", url: "https://example.com/result/" },
			{ title: "First duplicate", url: "https://example.com/result#other" },
		],
		citations: [
			{
				title: "First citation",
				url: "https://example.com/result/#fragment",
				citedText: "The cited snippet.",
			},
			{ title: "Second citation", url: "https://other.example/result#fragment" },
		],
		requestedResultCount: 4,
	};

	const text = formatForLLM(response);

	expect(text).toContain("## Sources");
	expect((text.match(/## Sources/g) ?? []).length).toBe(1);
	expect(text).toContain("1 source (provider returned 1 of 4 requested)");
	expect(text).toContain("The cited snippet.");
	expect(text).not.toContain("First duplicate");
	expect(text).toContain("## Citations");
	expect(text).toContain("[2] Second citation");
	expect(text).not.toContain("[1] First citation");
});

test("search formatting reports native and post-filtered constraints", () => {
	const text = formatForLLM({
		provider: "anthropic",
		answer: "An answer.",
		sources: [],
		constraintApplications: [
			{ operator: "site:github.com", mode: "native", detail: "allowed_domains" },
			{ operator: "after:2025-01-01", mode: "post-filtered" },
		],
	});

	expect(text).toContain("Constraints: site:github.com (native allowed_domains), after:2025-01-01 (post-filtered)");
});

test("search formatting reports a relaxed post-filter constraint", () => {
	const text = formatForLLM({
		provider: "anthropic",
		answer: "An answer.",
		sources: [],
		constraintApplications: [{ operator: "after:2025-01-01", mode: "post-filtered", relaxed: true }],
	});

	expect(text).toContain("relaxed after:2025-01-01, no results matched");
});

test("search formatting reports when a native constraint is relaxed", () => {
	const text = formatForLLM({
		provider: "anthropic",
		answer: "An answer.",
		sources: [],
		constraintApplications: [
			{ operator: "site:github.com", mode: "native", detail: "allowed_domains", relaxed: true },
		],
	});

	expect(text).toContain("relaxed site:github.com, no results matched");
});

test("automatic search stops slow providers at one shared deadline", async () => {
	const calls: string[] = [];
	const slowProviders: Record<string, SearchProvider> = {};
	for (const id of ["perplexity", "gemini", "anthropic"] as const) {
		slowProviders[id] = {
			id,
			label: id,
			isAvailable: () => true,
			isExplicitlyAvailable: () => true,
			search: async params => {
				calls.push(`${id}:${params.timeoutMs}`);
				// Deliberately ignore the provider signal: the chain itself must enforce its deadline.
				return Promise.withResolvers<SearchResponse>().promise;
			},
		} as SearchProvider;
	}

	const providerSpy = spyOn(providerModule, "getSearchProvider").mockImplementation(async id => {
		const provider = slowProviders[id];
		if (!provider) throw new Error(`unexpected provider ${id}`);
		return provider;
	});
	setSearchProviderOrder(["perplexity", "gemini", "anthropic"]);
	setExcludedSearchProviders([]);

	try {
		const started = performance.now();
		const result = await runSearchQuery(
			{ query: "slow provider regression", provider: "auto" },
			{ authStorage: {} as AuthStorage, timeoutMs: 50 },
		);
		const elapsed = performance.now() - started;

		expect(elapsed).toBeLessThan(300);
		expect(calls[0]?.startsWith("perplexity:")).toBe(true);
		expect(result.details.error).toBeDefined();
	} finally {
		providerSpy.mockRestore();
		setSearchProviderOrder([]);
		setExcludedSearchProviders([]);
	}
});
