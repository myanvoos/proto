import { afterEach, beforeEach, expect, test } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { searchPerplexity } from "./perplexity";

let authStorage: AuthStorage;

beforeEach(async () => {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("perplexity", "test-key");
});

afterEach(() => {
	authStorage.close();
});

function completionResponse(searchResults: unknown[], citations: string[]): Response {
	const first = {
		id: "request-id",
		object: "chat.completion.chunk",
		model: "sonar-pro",
		search_results: searchResults,
		citations,
		choices: [{ index: 0, delta: { role: "assistant", content: "answer" }, finish_reason: null }],
	};
	const last = {
		id: "request-id",
		object: "chat.completion.chunk",
		model: "sonar-pro",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	};
	return new Response(`data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

async function runApiSearch(searchResults: unknown[], citations: string[]) {
	const fetchImpl: FetchImpl = async () => completionResponse(searchResults, citations);
	return searchPerplexity({ query: "merge", authStorage, fetch: fetchImpl });
}

test("Perplexity citation joins preserve order, duplicates, and the first matching result", async () => {
	const result = await runApiSearch(
		[
			{ url: "https://example.test/duplicate", title: "First", snippet: "first snippet" },
			{ url: "https://example.test/duplicate", title: "Second", snippet: "second snippet" },
			{ url: "https://example.test/other", title: "Other" },
		],
		["https://example.test/other", "https://example.test/duplicate", "https://example.test/duplicate"],
	);

	expect(result.sources.map(({ title, url, snippet }) => ({ title, url, snippet }))).toEqual([
		{ title: "Other", url: "https://example.test/other", snippet: undefined },
		{ title: "First", url: "https://example.test/duplicate", snippet: "first snippet" },
		{ title: "First", url: "https://example.test/duplicate", snippet: "first snippet" },
	]);
	expect(result.citations).toEqual([
		{ title: "Other", url: "https://example.test/other" },
		{ title: "First", url: "https://example.test/duplicate" },
		{ title: "First", url: "https://example.test/duplicate" },
	]);
});

test("Perplexity joins a large reversed citation list within a linear-time budget", async () => {
	const count = 20_000;
	const searchResults = Array.from({ length: count }, (_, index) => ({
		url: `https://example.test/${index}`,
		title: `Result ${index}`,
	}));
	const citations = searchResults.map(result => result.url).reverse();

	const started = performance.now();
	const result = await runApiSearch(searchResults, citations);
	const elapsedMs = performance.now() - started;

	expect(result.sources).toHaveLength(count);
	expect(result.sources[0]?.title).toBe(`Result ${count - 1}`);
	expect(result.sources.at(-1)?.title).toBe("Result 0");
	expect(elapsedMs).toBeLessThan(200);
});
