import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "../types";
import { readOpenRouterGenerationError } from "./openrouter-generation";

async function diagnostic(response: Response, outputTokens = 0, reasoningTokens = 0): Promise<string | undefined> {
	const fetchImpl: FetchImpl = Object.assign(async () => response, { preconnect: fetch.preconnect });
	return readOpenRouterGenerationError({
		baseUrl: "https://openrouter.ai/api/v1",
		headers: {},
		responseId: "gen_1",
		outputTokens,
		reasoningTokens,
		fetch: fetchImpl,
		signal: new AbortController().signal,
	});
}

describe("OpenRouter native generation diagnostics", () => {
	it("recovers a hidden native failure only from the requested generation", async () => {
		const error = await diagnostic(
			Response.json({ data: { id: "gen_1", native_finish_reason: "MALFORMED_RESPONSE" } }),
		);
		expect(error).toContain("MALFORMED_RESPONSE");
		expect(error).toContain("gen_1");
		expect(
			await diagnostic(Response.json({ data: { id: "other", native_finish_reason: "MALFORMED_RESPONSE" } })),
		).toBeUndefined();
	});

	it("infers dropped output on metadata-lag 404 only when non-reasoning output was billed", async () => {
		expect(await diagnostic(new Response(null, { status: 404 }), 10, 4)).toContain("inferred MALFORMED_RESPONSE");
		expect(await diagnostic(new Response(null, { status: 404 }), 10, 10)).toBeUndefined();
		expect(await diagnostic(new Response(null, { status: 503 }), 10, 4)).toBeUndefined();
	});

	it("keeps unfamiliar vendor finish reasons forward compatible", async () => {
		expect(
			await diagnostic(Response.json({ data: { id: "gen_1", native_finish_reason: "VENDOR_SUCCESS" } })),
		).toBeUndefined();
	});
});
