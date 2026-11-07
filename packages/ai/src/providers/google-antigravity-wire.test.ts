import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Context, FetchImpl, Model, ModelSpec } from "../types";
import { buildRequest, streamGoogleGeminiCli } from "./google-gemini-cli";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

function antigravityModel(
	overrides: Partial<ModelSpec<"google-gemini-cli">> & { id: string },
): Model<"google-gemini-cli"> {
	return buildModel({
		name: overrides.id,
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		...overrides,
	} satisfies ModelSpec<"google-gemini-cli">);
}

describe("Antigravity per-SKU thinking constants", () => {
	it("pins a routed tier SKU to the thinking level its roster advertises", () => {
		const model = antigravityModel({
			id: "gemini-tier-fixture",
			thinking: {
				mode: "google-level",
				efforts: [Effort.Low, Effort.Medium, Effort.High],
				effortRouting: {
					low: "gemini-tier-fixture-low",
					medium: "gemini-tier-fixture-medium",
					high: "gemini-tier-fixture-high",
				},
			},
			antigravityWireProfiles: {
				"gemini-tier-fixture-low": { thinkingLevel: "LOW" },
				"gemini-tier-fixture-medium": { thinkingLevel: "MEDIUM" },
				"gemini-tier-fixture-high": { thinkingLevel: "HIGH" },
			},
		});
		const payload = buildRequest(
			model,
			context,
			"project",
			{ requestModelId: "gemini-tier-fixture-high", thinking: { enabled: true, level: "LOW" } },
			true,
		);
		expect(payload.request.generationConfig?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingLevel: "HIGH",
		});
	});

	it("keeps the caller's thinking level for a model that is not a routed tier", () => {
		const model = antigravityModel({
			id: "gemini-plain-fixture",
			antigravityWireProfiles: { "gemini-plain-fixture": { thinkingLevel: "HIGH", maxOutputTokens: 32_000 } },
		});
		const payload = buildRequest(model, context, "project", { thinking: { enabled: true, level: "LOW" } }, true);
		expect(payload.request.generationConfig?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingLevel: "LOW",
		});
		// The roster's output cap still applies to plain models.
		expect(payload.request.generationConfig?.maxOutputTokens).toBe(32_000);
	});
});

async function captureAntigravityHeaders(model: Model<"google-gemini-cli">): Promise<Headers> {
	let requestHeaders: Headers | undefined;
	const fetchMock: FetchImpl = async (input, init) => {
		if (String(input).includes("manifest")) return new Response("version: 2.26.0\n");
		requestHeaders = new Headers(init?.headers);
		return new Response('{"error":{"message":"bad request"}}', { status: 400 });
	};
	await streamGoogleGeminiCli(model, context, {
		apiKey: JSON.stringify({ token: "token", projectId: "project" }),
		fetch: fetchMock,
	}).result();
	if (!requestHeaders) throw new Error("Antigravity request headers were not captured");
	return requestHeaders;
}

describe("Antigravity Claude thinking beta", () => {
	it("withholds the interleaved-thinking beta from Claude 5.x, like the native client", async () => {
		const headers = await captureAntigravityHeaders(antigravityModel({ id: "claude-sonnet-5-5" }));
		expect(headers.get("anthropic-beta")).toBeNull();
	});

	it("keeps the interleaved-thinking beta for Claude 4.x", async () => {
		const headers = await captureAntigravityHeaders(antigravityModel({ id: "claude-sonnet-4-6" }));
		expect(headers.get("anthropic-beta")).toContain("interleaved-thinking-2025-05-14");
	});
});
