import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import * as catalogModels from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "./model-registry";
import { Settings } from "./settings";

let authStorage: AuthStorage | undefined;
let tempDir: string | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	authStorage?.close();
	authStorage = undefined;
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

test("refreshing one provider does not materialize unrelated bundled catalogs", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-model-registry-lazy-"));
	const cachePath = path.join(tempDir, "models.db");
	const cachedModel = buildModel({
		id: "cache-only-model",
		name: "Cache-only model",
		provider: "openai",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_384,
		maxTokens: 4_096,
	});
	writeModelCache("openai", Date.now(), [cachedModel], false, "", cachePath);

	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("openai", "test-key");
	const bundledLoads = vi.spyOn(catalogModels, "getBundledModels");
	const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), {
		cacheDbPath: cachePath,
		fetch: () => Promise.reject(new Error("network disabled in test")),
	});

	expect(bundledLoads).not.toHaveBeenCalled();
	await registry.refreshProvider("openai", "offline");

	expect(registry.find("openai", cachedModel.id)?.name).toBe(cachedModel.name);
	const loadedProviders = new Set(bundledLoads.mock.calls.map(([provider]) => provider));
	expect(loadedProviders).toEqual(new Set(["openai"]));

	expect(registry.find("anthropic", "claude-sonnet-4-5")?.provider).toBe("anthropic");
	const allModels = registry.getAll();
	expect(allModels).toContainEqual(expect.objectContaining({ provider: "openai", id: cachedModel.id }));
	expect(allModels.filter(model => model.provider === "openai" && model.id === cachedModel.id)).toHaveLength(1);
});

test("authoritative runtime refresh replaces its prior model set", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-model-registry-authoritative-"));
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), {
		cacheDbPath: path.join(tempDir, "models.db"),
		fetch: () => Promise.reject(new Error("network disabled in test")),
	});
	let modelId = "runtime-model-a";
	registry.registerProvider("runtime-authoritative", {
		api: "openai-completions",
		baseUrl: "https://runtime.invalid/v1",
		apiKey: "test-key",
		fetchDynamicModels: async () => [
			{
				id: modelId,
				name: modelId,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 16_384,
				maxTokens: 4_096,
			},
		],
	});

	await registry.refreshRuntimeProviders("online");
	expect(registry.find("runtime-authoritative", "runtime-model-a")?.name).toBe("runtime-model-a");

	modelId = "runtime-model-b";
	await registry.refreshRuntimeProviders("online");
	expect(registry.find("runtime-authoritative", "runtime-model-a")).toBeUndefined();
	expect(registry.find("runtime-authoritative", "runtime-model-b")?.name).toBe("runtime-model-b");
});

// `proto usage` probes credentials right after constructing a registry; a discovery-only provider has
// no model to read a URL from yet, and falling back to the canonical host would leak a proxy-scoped key.
test("resolves a configured provider base URL before any model is discovered", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-model-registry-base-url-"));
	const modelsPath = path.join(tempDir, "models.yml");
	await Bun.write(
		modelsPath,
		JSON.stringify({ providers: { "charm-hyper": { baseUrl: "https://gateway.internal" } } }),
	);
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	const registry = new ModelRegistry(authStorage, modelsPath, {
		cacheDbPath: path.join(tempDir, "models.db"),
		fetch: () => Promise.reject(new Error("network disabled in test")),
	});

	expect(registry.getAll().some(model => model.provider === "charm-hyper")).toBe(false);
	expect(registry.getProviderBaseUrl("charm-hyper")).toBe("https://gateway.internal");
});

test("a successful configured discovery drops models the endpoint no longer lists", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-model-registry-shrink-"));
	const modelsPath = path.join(tempDir, "models.yml");
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: {
				gateway: {
					baseUrl: "https://gateway.invalid/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
			},
		}),
	);
	let listed = ["model-a", "model-b"];
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	const registry = new ModelRegistry(authStorage, modelsPath, {
		cacheDbPath: path.join(tempDir, "models.db"),
		fetch: async input =>
			String(input) === "https://gateway.invalid/v1/models"
				? Response.json({ object: "list", data: listed.map(id => ({ id, object: "model" })) })
				: Promise.reject(new Error("network disabled in test")),
	});
	const gatewayIds = () =>
		registry
			.getAll()
			.filter(model => model.provider === "gateway")
			.map(model => model.id)
			.sort();

	await registry.refreshProvider("gateway", "online");
	expect(gatewayIds()).toEqual(["model-a", "model-b"]);

	listed = ["model-a"];
	await registry.refreshProvider("gateway", "online");
	expect(gatewayIds()).toEqual(["model-a"]);

	listed = [];
	await registry.refreshProvider("gateway", "online");
	expect(gatewayIds()).toEqual([]);
	expect(registry.getProviderDiscoveryState("gateway")?.status).toBe("empty");
});

test("injectV1: false discovers models at the configured versioned root", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-model-registry-inject-v1-"));
	const modelsPath = path.join(tempDir, "models.yml");
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: {
				opper: {
					baseUrl: "https://gateway.invalid/v3/compat/",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "openai-models-list", injectV1: false },
				},
			},
		}),
	);
	const requested: string[] = [];
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	const registry = new ModelRegistry(authStorage, modelsPath, {
		cacheDbPath: path.join(tempDir, "models.db"),
		fetch: async input => {
			requested.push(String(input));
			return Response.json({ object: "list", data: [{ id: "compat-model", object: "model" }] });
		},
	});

	await registry.refreshProvider("opper", "online");

	expect(requested).toContain("https://gateway.invalid/v3/compat/models");
	expect(requested).not.toContain("https://gateway.invalid/v3/compat/v1/models");
	expect(registry.find("opper", "compat-model")?.baseUrl).toBe("https://gateway.invalid/v3/compat");
});

test("models.yml prices are flat: a cost cannot smuggle in a time-based schedule", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-model-registry-flat-cost-"));
	const modelsPath = path.join(tempDir, "models.yml");
	const cost = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: {
				gateway: {
					baseUrl: "https://gateway.invalid/v1",
					api: "openai-completions",
					auth: "none",
					models: [
						{ id: "flat-model", cost: { ...cost, timeBased: { offPeakMultiplier: 0.5, peakWindows: [] } } },
					],
				},
			},
		}),
	);
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	const registry = new ModelRegistry(authStorage, modelsPath, {
		cacheDbPath: path.join(tempDir, "models.db"),
		fetch: () => Promise.reject(new Error("network disabled in test")),
	});

	const model = registry.find("gateway", "flat-model");
	expect(model?.cost).toEqual(cost);
});

async function litellmRegistry(prefix: string, respond: (pathname: string) => Response | undefined) {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const modelsPath = path.join(tempDir, "models.yml");
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: {
				proxy: {
					baseUrl: "https://litellm.invalid/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "litellm" },
				},
			},
		}),
	);
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	const registry = new ModelRegistry(authStorage, modelsPath, {
		cacheDbPath: path.join(tempDir, "models.db"),
		fetch: async input => respond(new URL(String(input)).pathname) ?? new Response("missing", { status: 404 }),
	});
	await registry.refreshProvider("proxy", "online");
	return registry
		.getAll()
		.filter(model => model.provider === "proxy")
		.map(model => model.id)
		.sort();
}

test("LiteLLM /models fallback drops known non-conversational modes but keeps aliases", async () => {
	const ids = await litellmRegistry("proto-model-registry-litellm-modes-", pathname =>
		pathname === "/v1/models"
			? Response.json({
					object: "list",
					data: [
						{ id: "chat-model", object: "model", mode: "chat" },
						{ id: "text-embedder", object: "model", mode: "embedding" },
						{ id: "voice", object: "model", mode: "audio_speech" },
						{ id: "router-alias", object: "model" },
						{ id: "future-mode", object: "model", mode: "agentic" },
					],
				})
			: undefined,
	);
	expect(ids).toEqual(["chat-model", "future-mode", "router-alias"]);
});

test("LiteLLM metadata listing only non-conversational models does not fall back to /models", async () => {
	const ids = await litellmRegistry("proto-model-registry-litellm-empty-", pathname => {
		if (pathname === "/model_group/info") {
			return Response.json({ data: [{ model_group: "text-embedder", mode: "embedding" }] });
		}
		if (pathname === "/v1/models") {
			return Response.json({ object: "list", data: [{ id: "text-embedder", object: "model" }] });
		}
		return undefined;
	});
	expect(ids).toEqual([]);
});

test("catalog metrics enrich models discovered through a custom provider", async () => {
	// Metrics only fill unscored models, so the id must be absent from the bundled catalog: a regen that scores it
	// would otherwise win here.
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-model-registry-metrics-"));
	const modelsPath = path.join(tempDir, "models.yml");
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: {
				cliproxy: {
					baseUrl: "https://proxy.example/v1",
					api: "openai-responses",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
			},
		}),
	);
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	const registry = new ModelRegistry(authStorage, modelsPath, {
		cacheDbPath: path.join(tempDir, "models.db"),
		fetch: async input => {
			const url = String(input);
			if (url === "https://catalog.stencil.so/models.json.zstd") {
				return Response.json({
					openai: {
						id: "openai",
						name: "OpenAI",
						models: {
							"gpt-5.7-sol": { id: "gpt-5.7-sol", name: "GPT-5.7 Sol", tool_call: true, int: 60.9, tps: 70.4 },
						},
					},
				});
			}
			if (url === "https://proxy.example/v1/models") {
				return Response.json({ data: [{ id: "openai/gpt-5.7-sol" }] });
			}
			return Promise.reject(new Error(`network disabled in test: ${url}`));
		},
	});

	await registry.refresh("online");

	const model = registry.find("cliproxy", "openai/gpt-5.7-sol");
	expect(model?.int).toBe(60.9);
	expect(model?.tps).toBe(70.4);
});

test("Codex Astra opens its 922K input window only with extended context, and overrides clamp to it", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-model-registry-astra-"));
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	const load = async (extendedContext: boolean, modelOverrides?: Record<string, { contextWindow: number }>) => {
		const modelsPath = path.join(tempDir!, `models-${extendedContext}-${modelOverrides ? "o" : "n"}.yml`);
		await Bun.write(
			modelsPath,
			JSON.stringify(modelOverrides ? { providers: { "openai-codex": { modelOverrides } } } : {}),
		);
		return new ModelRegistry(authStorage!, modelsPath, {
			cacheDbPath: path.join(tempDir!, "models.db"),
			settings: Settings.isolated({ extendedContext }),
			fetch: () => Promise.reject(new Error("network disabled in test")),
		});
	};

	expect((await load(false)).find("openai-codex", "gpt-6-astra")?.contextWindow).toBe(272_000);
	expect((await load(true)).find("openai-codex", "gpt-6-astra")?.contextWindow).toBe(922_000);

	const overridden = await load(false, {
		"gpt-6-astra": { contextWindow: 1_050_000 },
		"gpt-5.5": { contextWindow: 2_000_000 },
	});
	expect(overridden.find("openai-codex", "gpt-6-astra")?.contextWindow).toBe(922_000);
	// No curated or live maximum: the override passes through unclamped.
	expect(overridden.find("openai-codex", "gpt-5.5")?.contextWindow).toBe(2_000_000);
});

test.each([
	["maximum-only override", "modelOverrides", undefined, 272_000],
	["paired override", "modelOverrides", 400_000, 400_000],
	["maximum-only custom model", "models", undefined, 272_000],
	["paired custom model", "models", 400_000, 400_000],
] as const)(
	"Astra %s clamps its maximum across extended-context toggles and offline refresh",
	async (_name, source, contextWindow, standardWindow) => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-model-registry-astra-max-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const configured = { ...(contextWindow === undefined ? {} : { contextWindow }), maxContextWindow: 2_000_000 };
		const modelsPath = path.join(tempDir, "models.yml");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					"openai-codex":
						source === "modelOverrides"
							? { modelOverrides: { "gpt-6-astra": configured } }
							: {
									baseUrl: "https://chatgpt.com/backend-api",
									api: "openai-codex-responses",
									auth: "none",
									models: [{ id: "gpt-6-astra", ...configured }],
								},
				},
			}),
		);
		const settings = Settings.isolated();
		settings.set("extendedContext", true);
		const registry = new ModelRegistry(authStorage, modelsPath, {
			cacheDbPath: path.join(tempDir, "models.db"),
			settings,
			fetch: () => Promise.reject(new Error("network disabled in test")),
		});
		expect(registry.getError()).toBeUndefined();
		expect(registry.find("openai-codex", "gpt-6-astra")?.contextWindow).toBe(922_000);

		for (const extendedContext of [false, true, false, true]) {
			settings.set("extendedContext", extendedContext);
			await registry.reapplyModelPolicies();
			const expected = extendedContext ? 922_000 : standardWindow;
			expect(registry.find("openai-codex", "gpt-6-astra")?.contextWindow).toBe(expected);
			await registry.refresh("offline");
			expect(registry.find("openai-codex", "gpt-6-astra")?.contextWindow).toBe(expected);
		}
	},
);

test("a retired variant's maximum override wins over a larger custom maximum", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-model-registry-variant-max-"));
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	const modelsPath = path.join(tempDir, "models.yml");
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: {
				"google-antigravity": {
					baseUrl: "https://example.com/v1",
					api: "google-gemini-cli",
					auth: "none",
					models: [{ id: "gemini-3-pro", contextWindow: 128_000, maxContextWindow: 800_000 }],
					modelOverrides: { "gemini-3-pro-high": { maxContextWindow: 512_000 } },
				},
			},
		}),
	);
	const settings = Settings.isolated();
	settings.set("extendedContext", true);
	const registry = new ModelRegistry(authStorage, modelsPath, {
		cacheDbPath: path.join(tempDir, "models.db"),
		settings,
		fetch: () => Promise.reject(new Error("network disabled in test")),
	});
	expect(registry.getError()).toBeUndefined();
	expect(registry.find("google-antigravity", "gemini-3-pro")?.contextWindow).toBe(512_000);

	settings.set("extendedContext", false);
	await registry.reapplyModelPolicies();
	expect(registry.find("google-antigravity", "gemini-3-pro")?.contextWindow).toBe(128_000);
});

test("a spec-shaped row from oauth.modifyModels keeps its sparse compat override", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-model-registry-projection-"));
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	await authStorage.set("compat-provider", {
		type: "oauth",
		access: "access-token",
		refresh: "refresh-token",
		expires: Date.now() + 60_000,
	});
	const spec = {
		id: "synthesized-model",
		name: "Synthesized",
		provider: "compat-provider",
		api: "openai-completions",
		baseUrl: "https://example.invalid/",
		reasoning: false,
		input: ["text"] as Array<"text">,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		compat: { promptCacheSessionHeader: "x-grok-conv-id" },
	} as const;
	const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	registry.registerProvider(
		"compat-provider",
		{
			api: "openai-completions",
			baseUrl: "https://example.invalid/",
			models: [{ ...spec, id: "base-model" }],
			oauth: {
				name: "Compat OAuth",
				login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
				refreshToken: async credentials => credentials,
				getApiKey: credentials => credentials.access,
				// A hook-authored spec: its override lives in `compat`, not the built `compatConfig`.
				modifyModels: models => [
					...models.filter(model => model.provider !== "compat-provider"),
					spec as unknown as (typeof models)[number],
				],
			},
		},
		"ext://oauth",
	);

	const projected = registry.getAll().find(model => model.provider === "compat-provider");
	expect(projected?.id).toBe("synthesized-model");
	expect(projected?.compatConfig).toEqual({ promptCacheSessionHeader: "x-grok-conv-id" });
});

test("extension-registered Codex models keep a WebSocket opt-out, standalone and over a bundled model", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-model-registry-websockets-"));
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const model = {
		name: "Codex",
		reasoning: true,
		input: ["text"] as ("text" | "image" | "video")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		preferWebsockets: false,
	};
	const codex = {
		baseUrl: "https://chatgpt.com/backend-api/codex",
		apiKey: "RUNTIME_KEY",
		api: "openai-codex-responses" as const,
	};
	registry.registerProvider("runtime-codex", { ...codex, models: [{ ...model, id: "gpt-5.6-sol" }] }, "ext://a");
	registry.registerProvider("openai-codex", { ...codex, models: [{ ...model, id: "gpt-5.5" }] }, "ext://b");

	await registry.refresh("offline");
	expect(registry.find("runtime-codex", "gpt-5.6-sol")?.preferWebsockets).toBe(false);
	expect(registry.find("openai-codex", "gpt-5.5")?.preferWebsockets).toBe(false);
});

test("configured headers resolve per request, never on catalog reads, and survive a cache restart", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-model-registry-live-headers-"));
	const modelsPath = path.join(tempDir, "models.yml");
	const cacheDbPath = path.join(tempDir, "models.db");
	const tenantEnv = "PROTO_TEST_REGISTRY_TENANT";
	process.env[tenantEnv] = "tenant-1";
	try {
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					probe: {
						baseUrl: "https://probe.invalid/v1",
						api: "openai-completions",
						apiKey: "!printf test-key",
						authHeader: true,
						headers: { "X-Tenant": tenantEnv },
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		let discoveryAuthorization: string | null | undefined;
		const primed = new ModelRegistry(authStorage, modelsPath, {
			cacheDbPath,
			fetch: async (input, init) => {
				if (String(input) !== "https://probe.invalid/v1/models") throw new Error("network disabled in test");
				discoveryAuthorization = new Headers(init?.headers).get("Authorization");
				return Response.json({ object: "list", data: [{ id: "probe-model", object: "model" }] });
			},
		});
		await primed.refreshProvider("probe", "online");
		expect(discoveryAuthorization).toBe("Bearer test-key");

		const model = primed.find("probe", "probe-model");
		expect(model?.headers?.Authorization).toBeUndefined();
		expect(await primed.getRequestHeaders("probe", "probe-model")).toEqual({
			"X-Tenant": "tenant-1",
			Authorization: "Bearer test-key",
		});
		process.env[tenantEnv] = "tenant-2";
		expect((await primed.getRequestHeaders("probe", "probe-model"))?.["X-Tenant"]).toBe("tenant-2");

		const restarted = new ModelRegistry(authStorage, modelsPath, {
			cacheDbPath,
			fetch: () => Promise.reject(new Error("offline")),
		});
		expect(restarted.find("probe", "probe-model")).toBeDefined();
		expect((await restarted.getRequestHeaders("probe", "probe-model"))?.Authorization).toBe("Bearer test-key");
		// A failed online refresh serves the cached rows through the model manager, which must reattach the resolver.
		await restarted.refreshProvider("probe", "online");
		expect(restarted.getProviderDiscoveryState("probe")?.status).toBe("cached");
		expect((await restarted.getRequestHeaders("probe", "probe-model"))?.Authorization).toBe("Bearer test-key");
	} finally {
		delete process.env[tenantEnv];
	}
});
