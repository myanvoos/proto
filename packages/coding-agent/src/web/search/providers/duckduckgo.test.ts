import { expect, test } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { searchDuckDuckGo } from "./duckduckgo";

test("DuckDuckGo advertising redirects cannot displace an organic result at the result limit", async () => {
	const hrefs = [
		"/y.js?uddg=https%3A%2F%2Fad.test",
		"https://www.duckduckgo.com/y.js?ad=1",
		"//duckduckgo.com/y.js?ad=2",
		"//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Forganic",
	];
	const html = hrefs
		.map(
			(href, i) =>
				`<div class="result"><a class="result__a" href="${href}">Result ${i}</a><a class="result__snippet">Snippet</a></div>`,
		)
		.join("");
	const result = await searchDuckDuckGo({
		query: "news",
		systemPrompt: "",
		authStorage: {} as AuthStorage,
		limit: 1,
		fetch: async () => new Response(html),
	});
	expect(result.sources).toMatchObject([{ title: "Result 3", url: "https://example.test/organic" }]);
	expect(result.sources).toHaveLength(1);
});
