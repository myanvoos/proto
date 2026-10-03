import { describe, expect, it } from "bun:test";
import type { Api, ApiKeyResolver, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type BenchModelRegistry, resolveBenchModels } from "./bench-cli";

function fakeModel(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 4096,
		contextWindow: 128_000,
	});
}

function discoveryRegistry(
	initial: Model<Api>[],
	discovered: Model<Api>[],
	auth: (model: Model<Api>) => boolean = () => true,
): BenchModelRegistry & { refreshCalls: number } {
	let models = initial;
	const registry = {
		refreshCalls: 0,
		getAll: () => models,
		getAvailable: () => models.filter(auth),
		hasConfiguredAuth: auth,
		getApiKey: async (model: Model<Api>) => (auth(model) ? "sk-test" : undefined),
		resolver: () => (() => Promise.resolve("sk-test")) as unknown as ApiKeyResolver,
		getDiscoverableProviders: () => ["lm-studio"],
		refresh: async () => {
			registry.refreshCalls += 1;
			models = discovered;
		},
	};
	return registry;
}

describe("resolveBenchModels discovery fallback", () => {
	it("runs one discovery pass and resolves a selector missing from the startup catalog", async () => {
		const registry = discoveryRegistry([], [fakeModel("lm-studio", "local-27b")]);

		const [target] = await resolveBenchModels(["local-27b"], registry, undefined, () => {});

		expect(registry.refreshCalls).toBe(1);
		expect(target.model.id).toBe("local-27b");
	});

	it("reports the selector after the refreshed catalog still misses it", async () => {
		const registry = discoveryRegistry([], []);

		await expect(resolveBenchModels(["local-27b"], registry, undefined, () => {})).rejects.toThrow(/local-27b/);
		expect(registry.refreshCalls).toBe(1);
	});

	it("re-resolves every selector from the refreshed catalog and prints each warning once", async () => {
		const shared = [fakeModel("groq", "openai/gpt-oss-20b"), fakeModel("openrouter", "openai/gpt-oss-20b")];
		const registry = discoveryRegistry(
			shared,
			[...shared, fakeModel("lm-studio", "other")],
			model => model.provider !== "groq",
		);
		const stderr: string[] = [];

		const [redirected, other] = await resolveBenchModels(["openai/gpt-oss-20b", "other"], registry, undefined, text =>
			stderr.push(text),
		);

		expect(registry.refreshCalls).toBe(1);
		expect(redirected.model.provider).toBe("openrouter");
		expect(other.model.id).toBe("other");
		expect(stderr.filter(text => text.includes("no credentials for")).length).toBe(1);
	});
});
