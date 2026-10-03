import { afterEach, beforeEach, expect, test } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { searchFirecrawl } from "./firecrawl";

let authStorage: AuthStorage;
const originalBaseUrl = process.env.FIRECRAWL_BASE_URL;

beforeEach(async () => {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("firecrawl", "test-key");
});

afterEach(() => {
	authStorage.close();
	if (originalBaseUrl === undefined) delete process.env.FIRECRAWL_BASE_URL;
	else process.env.FIRECRAWL_BASE_URL = originalBaseUrl;
});

async function requestedUrl(baseUrl: string): Promise<string> {
	process.env.FIRECRAWL_BASE_URL = baseUrl;
	let requested = "";
	const fetchImpl: FetchImpl = async input => {
		requested = input instanceof Request ? input.url : String(input);
		return Response.json({ success: true, data: { web: [] } });
	};
	await searchFirecrawl({ query: "merge", systemPrompt: "", authStorage, fetch: fetchImpl });
	return requested;
}

test("resolves self-hosted Firecrawl base URLs to a single-slash search endpoint", async () => {
	expect(await requestedUrl("http://localhost:3002")).toBe("http://localhost:3002/v2/search");
	expect(await requestedUrl("http://localhost:3002/")).toBe("http://localhost:3002/v2/search");
	expect(await requestedUrl("http://localhost:3002/v1")).toBe("http://localhost:3002/v1/search");
	expect(await requestedUrl("https://proxy.example/firecrawl/")).toBe("https://proxy.example/firecrawl/v2/search");
});
