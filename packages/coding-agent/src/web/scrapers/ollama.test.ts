import { afterEach, describe, expect, it, vi } from "bun:test";
import { handleOllama } from "./ollama";
import * as scrapers from "./types";

function fakeOllama(tags: { ok: boolean; content: string }, page: { ok: boolean; content: string }) {
	return vi.spyOn(scrapers, "loadPage").mockImplementation(async url => {
		const result = url.includes("/api/tags") ? tags : page;
		return { ...result, status: result.ok ? 200 : 500, finalUrl: url, contentType: "text/html" };
	});
}

const tagsIndex = (...names: string[]) => ({
	ok: true,
	content: JSON.stringify({ models: names.map(name => ({ name })) }),
});
const modelPage = { ok: true, content: `<html><head><meta name="description" content="Model page" /></head></html>` };

describe("handleOllama", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects reserved routes without fetching", async () => {
		const loadPage = fakeOllama(tagsIndex(), modelPage);
		for (const route of ["library", "library:latest", "blog:post", "blog/some-post", "pricing", "account"]) {
			expect(await handleOllama(`https://ollama.com/${route}`, 5000)).toBeNull();
		}
		expect(loadPage).not.toHaveBeenCalled();
	});

	it("rejects shorthands missing from the tags index without fetching the page", async () => {
		const loadPage = fakeOllama(tagsIndex("llama3:latest"), modelPage);
		expect(await handleOllama("https://ollama.com/turbo", 5000)).toBeNull();
		expect(await handleOllama("https://ollama.com/llama3:not-a-tag", 5000)).toBeNull();
		expect(loadPage).toHaveBeenCalledTimes(2);
	});

	it("renders shorthand model URLs from the library page", async () => {
		fakeOllama(tagsIndex("llama3:latest", "llama3:8b"), modelPage);
		const result = await handleOllama("https://ollama.com/llama3:8b", 5000);
		expect(result?.content).toContain("# llama3");
		expect(result?.content).toContain("**Tag:** llama3:8b");
		expect(result?.finalUrl).toBe("https://ollama.com/library/llama3");
	});

	it("falls through to the page when the tags index is unavailable or malformed", async () => {
		fakeOllama({ ok: false, content: "Internal Error" }, modelPage);
		expect((await handleOllama("https://ollama.com/offline-model", 5000))?.content).toContain("# offline-model");
		vi.restoreAllMocks();
		fakeOllama({ ok: true, content: "not json" }, modelPage);
		expect((await handleOllama("https://ollama.com/malformed-model", 5000))?.content).toContain("# malformed-model");
	});

	it("renders canonical URLs missing from the tags index", async () => {
		const loadPage = fakeOllama(tagsIndex("unrelated:latest"), modelPage);
		const result = await handleOllama("https://ollama.com/library/canonical-model", 5000);
		expect(result?.content).toContain("# canonical-model");
		expect(loadPage).toHaveBeenCalledTimes(2);
	});

	it("returns null when the page fails and no tags match", async () => {
		fakeOllama(tagsIndex("mistral:latest"), { ok: false, content: "404" });
		expect(await handleOllama("https://ollama.com/library/llama3", 5000)).toBeNull();
	});
});
