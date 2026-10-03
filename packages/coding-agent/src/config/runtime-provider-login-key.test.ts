import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry, type ProviderConfigInput } from "./model-registry";

// Extension providers register `apiKey: "<ENV_NAME>"` alongside a `/login` flow. With the env var unset the name
// resolves to its literal text; it must not shadow the key saved by /login.
describe("runtime provider apiKey vs /login credential", () => {
	const provider = "login-key-precedence";
	const envName = "LOGIN_KEY_PRECEDENCE_TEST_KEY";
	const sourceId = "ext://login-key-precedence";
	const savedKey = "saved-login-key";
	const offlineFetch: FetchImpl = () => Promise.reject(new Error("network disabled"));
	let tempDir: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let discoveryKeys: Array<string | undefined>;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-login-key-precedence-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), {
			cacheDbPath: path.join(tempDir, "models.db"),
			fetch: offlineFetch,
		});
		discoveryKeys = [];
		delete process.env[envName];
	});

	afterEach(async () => {
		delete process.env[envName];
		unregisterCustomApis(sourceId);
		unregisterOAuthProviders(sourceId);
		authStorage.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function register(options: { oauth: boolean }): void {
		const config: ProviderConfigInput = {
			apiKey: envName,
			baseUrl: "https://login-key-precedence.example.com/v1",
			api: "openai-completions",
			...(options.oauth ? { oauth: { name: "Test", login: async () => savedKey } } : {}),
			fetchDynamicModels: async apiKey => {
				discoveryKeys.push(apiKey);
				if (apiKey !== savedKey && apiKey !== "env-key") throw new Error("401 invalid key");
				return [
					{
						id: "listed-model",
						name: "Listed",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8_192,
					},
				];
			},
		};
		registry.registerProvider(provider, config, sourceId);
	}

	async function login(): Promise<void> {
		await authStorage.login(provider, { onAuth() {}, onPrompt: async () => savedKey });
	}

	test("saved /login key beats an unset env-var apiKey for discovery and requests", async () => {
		register({ oauth: true });
		await login();
		await registry.refreshProvider(provider, "online");

		expect(discoveryKeys).toEqual([savedKey]);
		expect(registry.find(provider, "listed-model")).toBeDefined();
		expect(await registry.getApiKeyForProvider(provider)).toBe(savedKey);
	});

	test("login key survives a static reload that reinstalls runtime keys", async () => {
		register({ oauth: true });
		await login();
		await registry.refresh("online");

		expect(await registry.getApiKeyForProvider(provider)).toBe(savedKey);
		expect(registry.find(provider, "listed-model")).toBeDefined();
	});

	test("without a login, the provider apiKey still resolves from the environment", async () => {
		process.env[envName] = "env-key";
		register({ oauth: true });
		await registry.refreshProvider(provider, "online");

		expect(discoveryKeys).toEqual(["env-key"]);
		expect(await registry.getApiKeyForProvider(provider)).toBe("env-key");
	});

	test("providers without a /login flow keep apiKey as an override", async () => {
		process.env[envName] = "env-key";
		register({ oauth: false });
		await authStorage.set(provider, { type: "api_key", key: "stored-key" });

		expect(await registry.getApiKeyForProvider(provider)).toBe("env-key");
	});
});
