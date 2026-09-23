import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "./model-manager";
import type { ModelCost, ModelSpec } from "./types";

function modelSpec(cost: ModelCost): ModelSpec<"openai-completions"> {
	return {
		id: "discovered-free-model",
		name: "Discovered Free Model",
		api: "openai-completions",
		provider: "venice",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

describe("model source pricing merge", () => {
	it("lets discovered zero prices replace stale nonzero prices in every token lane", async () => {
		const stale = modelSpec({ input: 2, output: 8, cacheRead: 1, cacheWrite: 4 });
		const discovered = modelSpec({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		const result = await resolveProviderModels(
			{
				providerId: "venice",
				staticModels: [stale],
				cacheDbPath: ":memory:",
				fetchDynamicModels: async () => [discovered],
			},
			"online",
		);

		expect(result.models).toHaveLength(1);
		expect(result.models[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("keeps static pricing when discovered pricing is unknown rather than zero", async () => {
		const stale = modelSpec({ input: 2, output: 8, cacheRead: 1, cacheWrite: 4 });
		const unknown = modelSpec({
			input: Number.NaN,
			output: Number.NaN,
			cacheRead: Number.NaN,
			cacheWrite: Number.NaN,
		});
		const result = await resolveProviderModels(
			{
				providerId: "venice",
				staticModels: [stale],
				cacheDbPath: ":memory:",
				fetchDynamicModels: async () => [unknown],
			},
			"online",
		);

		expect(result.models).toHaveLength(1);
		expect(result.models[0]?.cost).toEqual(stale.cost);
	});
});

describe("model source resolution", () => {
	const tempDirs: string[] = [];
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	async function tempCacheDb(): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-manager-test-"));
		tempDirs.push(dir);
		return path.join(dir, "models.db");
	}

	function chatSpec(id: string): ModelSpec<"openai-completions"> {
		return { ...modelSpec({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }), id, name: id };
	}

	it("keeps cached shared-catalog additions when models.dev fails but the endpoint refresh succeeds", async () => {
		const cacheDbPath = await tempCacheDb();
		let modelsDevAvailable = true;
		const options = {
			providerId: "venice",
			staticModels: [chatSpec("bundled")],
			cacheDbPath,
			fetchDynamicModels: async () => [chatSpec("bundled")],
			modelsDev: {
				additiveOnly: true,
				fetch: async () => {
					if (!modelsDevAvailable) throw new Error("offline");
					return null;
				},
				map: () => [chatSpec("bundled"), chatSpec("catalog-added")],
			},
		};

		const first = await resolveProviderModels(options, "online");
		expect(first.models.map(model => model.id).sort()).toEqual(["bundled", "catalog-added"]);
		expect(first.source).toBe("provider");

		modelsDevAvailable = false;
		const second = await resolveProviderModels(options, "online");
		expect(second.models.map(model => model.id).sort()).toEqual(["bundled", "catalog-added"]);
		expect(second.stale).toBe(true);
	});

	it("does not persist an empty failed discovery, so the next launch retries immediately", async () => {
		const cacheDbPath = await tempCacheDb();
		let calls = 0;
		const options = {
			providerId: "venice",
			staticModels: [],
			cacheDbPath,
			fetchDynamicModels: async () => {
				calls++;
				return calls === 1 ? null : [chatSpec("recovered")];
			},
		};

		const failed = await resolveProviderModels(options, "online-if-uncached");
		expect(failed).toMatchObject({ models: [], stale: true, source: "bundled" });

		const retried = await resolveProviderModels(options, "online-if-uncached");
		expect(calls).toBe(2);
		expect(retried.models.map(model => model.id)).toEqual(["recovered"]);
		expect(retried.source).toBe("provider");
	});

	it("treats a successful shared-catalog refresh as authoritative for providers without endpoint discovery", async () => {
		const cacheDbPath = await tempCacheDb();
		let fetches = 0;
		const options = {
			providerId: "venice",
			staticModels: [chatSpec("bundled")],
			cacheDbPath,
			modelsDev: {
				additiveOnly: true,
				fetch: async () => {
					fetches++;
					return null;
				},
				map: () => [chatSpec("catalog-added")],
			},
		};

		const refreshed = await resolveProviderModels(options, "online-if-uncached");
		expect(refreshed).toMatchObject({ stale: false, source: "models.dev" });

		const reused = await resolveProviderModels(options, "online-if-uncached");
		expect(fetches).toBe(1);
		expect(reused.source).toBe("cache");
		expect(reused.models.map(model => model.id).sort()).toEqual(["bundled", "catalog-added"]);
	});

	it("scores bundled rows from the additive shared catalog, fresh and from the cache fast path", async () => {
		const cacheDbPath = await tempCacheDb();
		const options = {
			providerId: "venice",
			staticModels: [chatSpec("bundled")],
			cacheDbPath,
			modelsDev: {
				additiveOnly: true,
				fetch: async () => null,
				map: () => [{ ...chatSpec("bundled"), name: "Remote Name", int: 61.5, tps: 88 }],
			},
		};

		for (const strategy of ["online", "online-if-uncached"] as const) {
			const { models } = await resolveProviderModels(options, strategy);
			expect(models).toHaveLength(1);
			// The additive boundary still keeps bundled metadata; only the scores flow through.
			expect(models[0]).toMatchObject({ id: "bundled", name: "bundled", int: 61.5, tps: 88 });
		}
	});
});
