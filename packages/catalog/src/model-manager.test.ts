import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fingerprintStaticModels, resolveProviderModels } from "./model-manager";
import { modelsDevCatalogFallback } from "./provider-models";
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

	it("preserves discovered limits on warm additive catalog reads", async () => {
		const cacheDbPath = await tempCacheDb();
		const bundled = { ...chatSpec("bundled"), contextWindow: 1_000_000 };
		const options = {
			providerId: "venice",
			staticModels: [bundled],
			cacheDbPath,
			fetchDynamicModels: async () => [{ ...bundled, contextWindow: 128_000, maxTokens: 4096 }],
			modelsDev: { additiveOnly: true, fetch: async () => null, map: () => [bundled] },
		};
		await resolveProviderModels(options, "online");
		for (const strategy of ["online-if-uncached", "offline"] as const) {
			const result = await resolveProviderModels(options, strategy);
			expect(result.models[0]).toMatchObject({ contextWindow: 128_000, maxTokens: 4096 });
		}
	});

	it("never resurrects retired bundled models after repeated failed authoritative refreshes", async () => {
		const cacheDbPath = await tempCacheDb();
		let online = true;
		const options = {
			providerId: "venice",
			staticModels: [chatSpec("served"), chatSpec("retired")],
			cacheDbPath,
			dynamicModelsAuthoritative: true,
			fetchDynamicModels: async () => (online ? [chatSpec("served")] : null),
			modelsDev: {
				additiveOnly: true,
				fetch: async () => {
					if (!online) throw Error("offline");
					return null;
				},
				map: () => [],
			},
		};
		await resolveProviderModels(options, "online");
		online = false;
		for (const strategy of ["online", "offline", "online", "online-if-uncached"] as const) {
			const result = await resolveProviderModels(options, strategy);
			expect(result.models.map(model => model.id)).toEqual(["served"]);
		}
	});

	it("keeps authoritative and additive policies distinct even for empty catalogs", () => {
		const plain = fingerprintStaticModels([]);
		const authoritative = fingerprintStaticModels([], { authoritative: true });
		const additive = fingerprintStaticModels([], { additive: true });
		const both = fingerprintStaticModels([], { authoritative: true, additive: true });
		expect(new Set([plain, authoritative, additive, both]).size).toBe(4);
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

	it("reports a throwing endpoint fetcher on the resolution result instead of swallowing it", async () => {
		const cacheDbPath = await tempCacheDb();
		const options = {
			providerId: "venice",
			staticModels: [chatSpec("bundled")],
			cacheDbPath,
			fetchDynamicModels: async () => {
				throw new Error("HTTP 503");
			},
		};

		const failed = await resolveProviderModels(options, "online");
		expect(failed.fetchError).toBe("HTTP 503");
		expect(failed.models.map(model => model.id)).toEqual(["bundled"]);

		const recovered = await resolveProviderModels(
			{ ...options, fetchDynamicModels: async () => [chatSpec("live")] },
			"online",
		);
		expect(recovered.fetchError).toBeUndefined();
	});

	it("keeps a header-bearing cached catalog after a failed refresh so the next launch refetches it", async () => {
		const cacheDbPath = await tempCacheDb();
		// Live headers with no static source: the cache omits them and the row's model cannot be
		// restored offline.
		const headerModel: ModelSpec<"openai-completions"> = {
			...chatSpec("tenant-model"),
			provider: "header-failed-refresh-test",
			headers: { "X-Tenant": "tenant-a" },
		};
		let fail = false;
		let fetches = 0;
		const options = {
			providerId: "header-failed-refresh-test" as const,
			staticModels: [] as ModelSpec<"openai-completions">[],
			dynamicModelsAuthoritative: true,
			cacheDbPath,
			now: () => 1_000_000,
			fetchDynamicModels: async () => {
				fetches++;
				return fail ? null : [headerModel];
			},
		};

		const populated = await resolveProviderModels(options, "online");
		expect(populated.models.map(model => model.id)).toEqual(["tenant-model"]);

		fail = true;
		await resolveProviderModels(options, "online");
		expect(fetches).toBe(2);

		// The clock does not advance: a rewritten empty snapshot would read back fresh and skip
		// this fetch, hiding the model until the backoff expires.
		fail = false;
		const recovered = await resolveProviderModels(options, "online-if-uncached");
		expect(recovered.models.map(model => model.id)).toEqual(["tenant-model"]);
		expect(fetches).toBe(3);
	});
});

describe("runtime-resolved endpoints", () => {
	const tempDirs: string[] = [];
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	it("discovers and caches models whose baseUrl is resolved at request time", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-azure-discovery-"));
		tempDirs.push(dir);
		const fallback = modelsDevCatalogFallback("azure");
		if (!fallback) throw new Error("Azure did not configure a shared catalog fallback");
		const options = {
			providerId: "azure" as const,
			staticModels: [] as ModelSpec<"openai-completions">[],
			cacheDbPath: path.join(dir, "models.db"),
			modelsDev: {
				...fallback,
				fetch: async () => ({
					azure: {
						models: {
							"gpt-6.1-terra": {
								name: "GPT-6.1 Terra",
								tool_call: true,
								reasoning: true,
								limit: { context: 1_050_000, output: 128_000 },
							},
						},
					},
				}),
			},
		};

		const online = await resolveProviderModels(options, "online");
		expect(online.models.map(model => `${model.provider}/${model.id}`)).toEqual(["azure/gpt-6.1-terra"]);
		expect(online.models[0]?.baseUrl).toBe("");

		const cached = await resolveProviderModels(options, "offline");
		expect(cached.models.map(model => `${model.provider}/${model.id}`)).toEqual(["azure/gpt-6.1-terra"]);
	});
});
