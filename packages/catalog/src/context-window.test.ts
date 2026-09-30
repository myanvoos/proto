import { describe, expect, test } from "bun:test";
import { buildModel } from "./build";
import { clampContextOverride, resolveMaxContextWindow } from "./context-window";

describe("resolveMaxContextWindow", () => {
	test("curates the Astra extended-context ceiling at 922K input", () => {
		const bundled = buildModel({
			id: "gpt-6-astra",
			name: "GPT-6 Astra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxContextWindow: 872_000,
			maxTokens: 128_000,
		});
		expect(resolveMaxContextWindow(bundled)).toBe(922_000);
	});

	test("corrects GPT-6.1 Sol's stale 872K Codex maximum to the documented 922K input cap", () => {
		// Not bundled yet: build the row the way Codex discovery reports it.
		for (const id of ["gpt-6.1-sol", "gpt-6.1-sol-wm"]) {
			const sol = buildModel({
				id,
				name: "GPT-6.1 Sol",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 272_000,
				maxContextWindow: 872_000,
				maxTokens: 128_000,
			});
			expect(sol.contextWindow).toBe(272_000);
			expect(resolveMaxContextWindow(sol)).toBe(922_000);
		}
	});

	test("falls back to the curated window when the live maximum is missing or invalid", () => {
		for (const id of ["gpt-6.1-sol", "gpt-6.1-sol-wm"]) {
			const base = {
				id,
				provider: "openai-codex" as const,
			};
			expect(resolveMaxContextWindow({ ...base, maxContextWindow: undefined })).toBe(922_000);
			expect(resolveMaxContextWindow({ ...base, maxContextWindow: Number.NaN })).toBe(922_000);
		}
	});

	test("a higher live maximum still wins", () => {
		const id = "gpt-6.1-sol";
		expect(resolveMaxContextWindow({ id, provider: "openai-codex", maxContextWindow: 1_000_000 })).toBe(1_000_000);
	});
});

describe("clampContextOverride", () => {
	test("clamps Codex overrides to the curated ceiling", () => {
		const model = {
			id: "gpt-6.1-sol",
			provider: "openai-codex",
			maxContextWindow: 872_000,
			contextWindow: 272_000,
		};
		expect(clampContextOverride(model, 1_000_000)).toBe(922_000);
		// Requests at or under the ceiling pass through unchanged.
		expect(clampContextOverride(model, 500_000)).toBe(500_000);
	});
});
