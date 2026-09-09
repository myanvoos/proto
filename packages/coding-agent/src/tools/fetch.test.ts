import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Settings } from "../config/settings";
import { renderHtmlToText } from "./fetch";

const originalJinaApiKey = Bun.env.JINA_API_KEY;

const jinaSettings = {
	get(key: string): unknown {
		if (key === "providers.fetch") return "jina";
		return undefined;
	},
} as unknown as Settings;

function restoreJinaApiKey(): void {
	if (originalJinaApiKey === undefined) {
		delete Bun.env.JINA_API_KEY;
	} else {
		Bun.env.JINA_API_KEY = originalJinaApiKey;
	}
}

afterEach(() => {
	restoreJinaApiKey();
});

async function requestJinaHeaders(): Promise<Headers> {
	const transport = {
		fetch: async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
			new Response(`Markdown Content:\n${"Reader content ".repeat(20)}`, { status: 200 }),
	};
	const fetchSpy = spyOn(transport, "fetch");

	const result = await renderHtmlToText(
		"https://example.com/article",
		"",
		1,
		jinaSettings,
		undefined,
		null,
		transport.fetch,
	);

	expect(result.method).toBe("jina");
	expect(fetchSpy).toHaveBeenCalledTimes(1);
	const requestInit = fetchSpy.mock.calls[0]?.[1];
	expect(requestInit).toBeDefined();
	return new Headers(requestInit?.headers);
}

describe("Jina Reader authentication", () => {
	test("sends the configured environment API key as a bearer credential", async () => {
		Bun.env.JINA_API_KEY = "jina-test-key";

		const headers = await requestJinaHeaders();

		expect(headers.get("authorization")).toBe("Bearer jina-test-key");
	});

	test("keeps anonymous requests free of an authorization header", async () => {
		delete Bun.env.JINA_API_KEY;

		const headers = await requestJinaHeaders();

		expect(headers.get("authorization")).toBeNull();
	});
});
