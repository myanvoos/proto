import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import * as catalogModels from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "./model-registry";

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
