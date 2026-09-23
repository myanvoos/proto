import { describe, expect, it } from "bun:test";
import { servedModelFromAnthropicSignature, servedModelFromOpenRouterReasoning } from "./anthropic-signature";

// Captured from OpenRouter → "Claude Platform on AWS" for anthropic/claude-opus-5.
const OPUS_5_SIGNATURE =
	"CAISnAIKrgEIERgCKkBun5aw4pp8OwMcmPih8WPkWUcibrzQ8Jg5AooTtYTxb4OGtHksxfgAiCJWYNO0xqC4zVwgAFZ0nU0+5/QoKQStMg1jbGF1ZGUtb3B1cy01OAFCCHRoaW5raW5nWiQ0YzBmMDQ2Zi0yNWZkLTQ1ZmItYmZiMy1hMDhhOGUyNDljYTd6HnVwcm9mXzAxMUNlUVRqY1ZkV2lES1F4d0Zlc3BldqgBndWi1QYSDDfLtFY9SutE7G2OLhoMvcDeJZgBIoqoYb4IIjBvpyKZu6JlaYZEy4cKXscU+OxzGZkpQapVraxYNEwKypi+Dbvz9FD2bO0yHjFhi5kqGwmcLJKipAse80nNfJfANbVYCqh6yW6HgnkXAxgB";
// api.anthropic.com v4 outer format: the header carries no model id.
const V4_SIGNATURE = "CAQStgYKEAgRGAI4AUIIdGhpbmtpbmcSDCgdRY6PL4pRWmAaPxoMkEErP6SIhmUZXydSIjDBUTSM41Hv";
const OPENAI_FERNET = "gAAAAABqqKjDeKWwGqlnw3QcNkzoMW4FNSSRdQoIAE2cBvpWtJW1CeF8SOHqZawrG5ebwSua9tWKUhWydIlL";

describe("servedModelFromAnthropicSignature", () => {
	it("recovers the serving model id from a current-format signature", () => {
		expect(servedModelFromAnthropicSignature(OPUS_5_SIGNATURE)).toBe("claude-opus-5");
	});

	it("yields nothing for model-less, foreign, or malformed blobs instead of a bogus id", () => {
		expect(servedModelFromAnthropicSignature(V4_SIGNATURE)).toBeUndefined();
		expect(servedModelFromAnthropicSignature(OPENAI_FERNET)).toBeUndefined();
		expect(servedModelFromAnthropicSignature("not base64 at all!!")).toBeUndefined();
	});

	it("rejects an overflowing varint length before a valid header", () => {
		const signature = Buffer.concat([
			Buffer.from([0x1a, 0x80, 0x80, 0x80, 0x80, 0x10]),
			Buffer.from(OPUS_5_SIGNATURE, "base64"),
		]);
		expect(servedModelFromAnthropicSignature(signature.toString("base64"))).toBeUndefined();
	});

	it("reads OpenRouter's forwarded Anthropic reasoning signature only for the Claude format", () => {
		expect(servedModelFromOpenRouterReasoning({ format: "anthropic-claude-v1", signature: OPUS_5_SIGNATURE })).toBe(
			"claude-opus-5",
		);
		expect(servedModelFromOpenRouterReasoning({ format: "openai-responses-v1", signature: OPUS_5_SIGNATURE })).toBe(
			undefined,
		);
	});
});
