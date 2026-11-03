import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { searchDeepSeek } from "./deepseek";

let authStorage: AuthStorage;
beforeEach(async () => {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("deepseek", "search-key");
});
afterEach(() => {
	vi.restoreAllMocks();
	authStorage.close();
});

test("DeepSeek translates domain, language and date directives and normalizes valid search results", async () => {
	let request: { query: string; count: number } | undefined;
	const authorization: (string | null)[] = [];
	const result = await searchDeepSeek({
		query: '"release notes" site:example.com/docs -site:ads.example lang:en-US after:2026-01-01 before:2026-02-01',
		limit: 100,
		systemPrompt: "",
		authStorage,
		fetch: async (url, init) => {
			expect(String(url)).toBe("https://api.deepseek.com/v1/tools/search");
			request = JSON.parse(String(init?.body));
			authorization.push(new Headers(init?.headers).get("authorization"));
			return Response.json({
				results: [
					{
						title: " A\n release ",
						url: "https://example.com/docs/release",
						summary: " Long\t summary ",
						snippet: "short",
						date: "2026-01-10",
					},
					{ url: "javascript:alert(1)", title: "bad" },
					{ url: "not a URL" },
				],
			});
		},
	});
	expect(authorization).toEqual(["Bearer search-key"]);
	expect(request).toMatchObject({ count: 50 });
	expect(request?.query).toBe(
		'"release notes" site:example.com -site:ads.example lang:en after:2026-01-01 before:2026-02-01',
	);
	expect(result.sources).toMatchObject([
		{
			title: "A release",
			url: "https://example.com/docs/release",
			snippet: "Long summary",
			publishedDate: "2026-01-10",
		},
	]);
	expect(result.sources).toHaveLength(1);
});

test("DeepSeek counts astral characters rather than UTF-16 units and refuses oversized queries before HTTP", async () => {
	let calls = 0;
	const params = {
		systemPrompt: "",
		authStorage,
		fetch: async () => {
			calls++;
			return Response.json({ results: [] });
		},
	};
	await searchDeepSeek({ ...params, query: "🦋".repeat(128) });
	await expect(searchDeepSeek({ ...params, query: "🦋".repeat(129) })).rejects.toThrow("128 characters");
	expect(calls).toBe(1);
});

test("DeepSeek query recency becomes a date while explicit after wins", async () => {
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-03T12:00:00Z"));
	const queries: string[] = [];
	const params = {
		systemPrompt: "",
		authStorage,
		recency: "week" as const,
		fetch: async (_url: string | URL | Request, init?: RequestInit) => {
			queries.push((JSON.parse(String(init?.body)) as { query: string }).query);
			return Response.json({ results: [] });
		},
	};
	await searchDeepSeek({ ...params, query: "news" });
	await searchDeepSeek({ ...params, query: "news after:2026-10-01" });
	expect(queries).toEqual(["news after:2026-10-27", "news after:2026-10-01"]);
});

test("DeepSeek surfaces authorization failures and invalid provider JSON", async () => {
	await expect(
		searchDeepSeek({
			query: "news",
			systemPrompt: "",
			authStorage,
			fetch: async () => new Response("invalid credentials", { status: 401 }),
		}),
	).rejects.toMatchObject({ provider: "deepseek", status: 401 });
	await expect(
		searchDeepSeek({ query: "news", systemPrompt: "", authStorage, fetch: async () => new Response("not json") }),
	).rejects.toThrow("invalid JSON");
});
