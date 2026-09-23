import { describe, expect, test } from "bun:test";
import { buildModel } from "../build";
import { Effort } from "../effort";
import type { FetchImpl } from "../types";
import { metaModelManagerOptions, museCodeModelManagerOptions } from "./openai-compat";

const FIVE_TIER = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];

function modelListFetch(ids: readonly string[]): { fetch: FetchImpl; headers: () => Headers } {
	let requestHeaders = new Headers();
	const fetch: FetchImpl = async (_input, init) => {
		requestHeaders = new Headers(init?.headers);
		return Response.json({ object: "list", data: ids.map(id => ({ id, object: "model" })) });
	};
	return { fetch, headers: () => requestHeaders };
}

describe("Meta Model API discovery", () => {
	test("keeps seeded capabilities for the bare ids Meta lists and drops media SKUs", async () => {
		// api.meta.ai/v1/models returns bare `{id}` rows: without the seed a shipped revision surfaced
		// as a text-only model with an unknown window and no thinking.
		const { fetch } = modelListFetch(["muse-spark-1.3", "muse-spark-1.3-contributor", "muse-image-1.0"]);
		const specs = (await metaModelManagerOptions({ apiKey: "meta-key", fetch }).fetchDynamicModels?.()) ?? [];
		const byId = new Map(specs.map(spec => [spec.id, buildModel(spec)]));

		expect(byId.get("muse-spark-1.3")).toMatchObject({
			name: "Muse Spark 1.3",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			thinking: { efforts: [...FIVE_TIER, Effort.Max] },
		});
		expect(byId.get("muse-spark-1.3-contributor")).toMatchObject({
			name: "Muse Spark 1.3 (C)",
			cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
			thinking: { efforts: FIVE_TIER },
		});
		expect(byId.has("muse-image-1.0")).toBe(false);
	});

	test("gives unseeded Muse Spark revisions the lineage window, tier pricing, and 5-tier ladder", async () => {
		const { fetch } = modelListFetch(["muse-spark-1.4", "muse-spark-1.4-contributor", "muse-spark-2.0.1"]);
		const specs = (await metaModelManagerOptions({ apiKey: "meta-key", fetch }).fetchDynamicModels?.()) ?? [];
		const byId = new Map(specs.map(spec => [spec.id, buildModel(spec)]));

		expect(byId.get("muse-spark-1.4")).toMatchObject({
			name: "Muse Spark 1.4",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
			thinking: { efforts: FIVE_TIER },
		});
		expect(byId.get("muse-spark-1.4-contributor")).toMatchObject({
			name: "Muse Spark 1.4 (C)",
			cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
		});
		expect(byId.get("muse-spark-2.0.1")).toMatchObject({ name: "Muse Spark 2.0.1", reasoning: true });
	});
});

describe("Muse Code subscription discovery", () => {
	test("authenticates with the minted key and lists subscription chat models at Meta pricing", async () => {
		const { fetch, headers } = modelListFetch(["muse-spark-1.3", "muse-image-1.0", "muse-voice-1.0"]);
		const options = museCodeModelManagerOptions({ apiKey: "LLM|subscription-key", fetch });
		const specs = (await options.fetchDynamicModels?.()) ?? [];

		expect(headers().get("Authorization")).toBe("Bearer LLM|subscription-key");
		expect(headers().get("x-api-version")).toBe("1.0.0");
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(specs.map(spec => buildModel(spec))).toEqual([
			expect.objectContaining({
				id: "muse-spark-1.3",
				provider: "muse-code",
				reasoning: true,
				cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
				maxTokens: 131_072,
			}),
		]);
	});

	test("scopes the discovery cache to the subscription key", () => {
		const first = museCodeModelManagerOptions({ apiKey: "LLM|first" }).cacheProviderId;
		const second = museCodeModelManagerOptions({ apiKey: "LLM|second" }).cacheProviderId;
		expect(first).toStartWith("muse-code:");
		expect(first).not.toBe(second);
	});
});
