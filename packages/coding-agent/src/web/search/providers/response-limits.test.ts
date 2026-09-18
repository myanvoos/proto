import { afterEach, beforeEach, expect, test } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { SearchProviderError } from "../types";
import { browserFetch } from "./browser-page";
import { searchTavily } from "./tavily";
import { readProviderErrorText, readProviderResponseText } from "./utils";

let authStorage: AuthStorage;

beforeEach(async () => {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("tavily", "test-key");
});

afterEach(() => {
	authStorage.close();
});

function streamedResponse(
	text: string,
	init: ResponseInit,
): { response: Response; bytesRead: () => number; wasCancelled: () => boolean } {
	const bytes = new TextEncoder().encode(text);
	let offset = 0;
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.byteLength) {
				controller.close();
				return;
			}
			const end = Math.min(offset + 64 * 1024, bytes.byteLength);
			controller.enqueue(bytes.slice(offset, end));
			offset = end;
		},
		cancel() {
			cancelled = true;
		},
	});
	return {
		response: new Response(body, init),
		bytesRead: () => offset,
		wasCancelled: () => cancelled,
	};
}

test("Tavily rejects and cancels an oversized success body even when content-length lies", async () => {
	const payload = JSON.stringify({ answer: "must not parse", results: [], padding: "x".repeat(3 * 1024 * 1024) });
	const streamed = streamedResponse(payload, { status: 200, headers: { "content-length": "1" } });
	const fetchImpl: FetchImpl = async () => streamed.response;

	const pending = searchTavily({
		query: "bounded",
		systemPrompt: "",
		authStorage,
		fetch: fetchImpl,
	});
	await expect(pending).rejects.toBeInstanceOf(SearchProviderError);
	await expect(pending).rejects.toMatchObject({
		name: "SearchProviderError",
		provider: "tavily",
		message: expect.stringContaining("exceeded"),
	});
	expect(streamed.wasCancelled()).toBe(true);
	expect(streamed.bytesRead()).toBeLessThan(new TextEncoder().encode(payload).byteLength);
});

test("Tavily rejects an oversized diagnostic body without embedding it in the error", async () => {
	const streamed = streamedResponse("sensitive".repeat(16 * 1024), { status: 500 });
	const fetchImpl: FetchImpl = async () => streamed.response;

	const pending = searchTavily({ query: "bounded", systemPrompt: "", authStorage, fetch: fetchImpl });
	await expect(pending).rejects.toBeInstanceOf(SearchProviderError);
	await expect(pending).rejects.toMatchObject({
		name: "SearchProviderError",
		provider: "tavily",
		message: expect.stringContaining("diagnostic body exceeded"),
	});
	expect(streamed.wasCancelled()).toBe(true);
});

test("browser search rejects and cancels oversized HTML instead of partially parsing it", async () => {
	const html = `<html><body>${"x".repeat(3 * 1024 * 1024)}</body></html>`;
	const streamed = streamedResponse(html, { status: 200, headers: { "content-length": "12" } });
	const fetchImpl: FetchImpl = async () => streamed.response;
	const options = {
		provider: "google" as const,
		fetch: fetchImpl,
		signal: new AbortController().signal,
	};

	const pending = browserFetch("https://example.test/search", options);
	await expect(pending).rejects.toBeInstanceOf(SearchProviderError);
	await expect(pending).rejects.toMatchObject({
		name: "SearchProviderError",
		provider: "google",
		message: expect.stringContaining("HTML body exceeded"),
	});
	expect(streamed.wasCancelled()).toBe(true);
	expect(streamed.bytesRead()).toBeLessThan(new TextEncoder().encode(html).byteLength);
});

test("normal-sized Tavily JSON parses into the same search response", async () => {
	const fetchImpl: FetchImpl = async () =>
		new Response(
			JSON.stringify({
				answer: "Exact answer",
				request_id: "request-1",
				results: [
					{
						title: "Exact title",
						url: "https://example.test/result",
						content: "Exact snippet",
					},
				],
			}),
			{ status: 200 },
		);

	await expect(
		searchTavily({ query: "normal", systemPrompt: "", authStorage, fetch: fetchImpl }),
	).resolves.toMatchObject({
		provider: "tavily",
		answer: "Exact answer",
		requestId: "request-1",
		sources: [{ title: "Exact title", url: "https://example.test/result", snippet: "Exact snippet" }],
	});
});

test("normal-sized browser HTML is returned byte-for-byte", async () => {
	const html = "<!doctype html><title>café</title>";
	const fetchImpl: FetchImpl = async () => new Response(html, { status: 203 });
	const page = await browserFetch("https://example.test/search", {
		provider: "google",
		fetch: fetchImpl,
		signal: new AbortController().signal,
	});

	expect(page).toEqual({ html, status: 203, url: "https://example.test/search" });
});

test.each([
	["JSON", JSON.stringify({ value: "café", nested: [1, 2, 3] })],
	["SSE", 'event: message\ndata: {"value":"café"}\n\n'],
])("normal-sized %s provider bodies are preserved byte-for-byte", async (_shape, body) => {
	await expect(readProviderResponseText(new Response(body), "exa")).resolves.toBe(body);
});

test("normal-sized diagnostic text remains available for provider classification", async () => {
	const body = '{"error":"quota exceeded"}';
	await expect(readProviderErrorText(new Response(body, { status: 429 }), "tavily")).resolves.toBe(body);
});
