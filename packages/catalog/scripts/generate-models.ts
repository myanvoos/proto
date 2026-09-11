#!/usr/bin/env bun

const COPILOT_PREMIUM_MULTIPLIERS: Record<string, number> = {
	"github-copilot/claude-haiku-4.5": 0.33,
	"github-copilot/claude-opus-4.6": 3,
	"github-copilot/gpt-4o": 0,
	"github-copilot/gpt-5.4-mini": 0.33,
	"github-copilot/grok-code-fast-1": 0.25,
};

import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAuthStorage } from "@oh-my-pi/pi-ai/auth-broker/discover";
import type { OAuthAccess } from "@oh-my-pi/pi-ai/auth-storage";
import type { OAuthProvider } from "@oh-my-pi/pi-ai/oauth/types";
import { getGitLabDuoModels } from "@oh-my-pi/pi-ai/providers/gitlab-duo";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { $env } from "@oh-my-pi/pi-utils";
import { buildModel } from "../src/build";
import { ANTIGRAVITY_PRIMARY_ENDPOINT, fetchAntigravityDiscoveryModels } from "../src/discovery/antigravity";
import { fetchCodexModels } from "../src/discovery/codex";
import { buildGitLabDuoWorkflowFallbackModel } from "../src/discovery/gitlab-duo-workflow";
import { createModelManager } from "../src/model-manager";
import { resolveOpenAIDaybreakStandardCost } from "../src/openai-pricing";
import { toModelSpec } from "../src/provider-models/bundled-references";
import {
	allowsUnauthenticatedCatalogDiscovery,
	type CatalogDiscoveryConfig,
	type CatalogProviderDescriptor,
	isCatalogDescriptor,
} from "../src/provider-models/descriptor-types";
import { PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import {
	AIAND_STATIC_MODELS,
	ALIBABA_TOKEN_PLAN_STATIC_MODELS,
	ANTHROPIC_CURATED_FALLBACK_MODELS,
	BEDROCK_MANTLE_STATIC_MODELS,
	buildFireworksFastSeed,
	buildXaiOAuthStaticSeed,
	clampFireworksKimiMaxTokens,
	clampKimiK27CodeMaxTokens,
	fetchWellKnownModels,
	GMI_CLOUD_STATIC_MODELS,
	isFireworksKimiK2ModelId,
	isKimiK27CodeModelId,
	kimiCodeMaxTokens,
	META_MUSE_STATIC_MODELS,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
	OPENAI_DAYBREAK_CURATED_FALLBACK_MODELS,
	projectOpenAIProReasoningAliases,
	SAKANA_FUGU_STATIC_MODELS,
	stripFireworksDeepSeekThinkingToggle,
} from "../src/provider-models/openai-compat";
import type { Api, Model, ModelSpec } from "../src/types";
import { cleanModelName } from "../src/utils";
import { collapseEffortVariantsAcrossProviders } from "../src/variant-collapse";
import {
	applyAntigravityPricingFallback,
	applyCanonicalLimitFallback,
	applyGeneratedModelPolicies,
	applyOllamaCloudOutputCap,
	CLOUDFLARE_FALLBACK_MODEL,
	dropBedrockMantleOpenAIModels,
	dropUnsupportedBedrockGeoIds,
	hasBillableCost,
	linkOpenAIPromotionTargets,
} from "./generated-policies";

const packageRoot = path.join(import.meta.dir, "..");

async function loadPrevModels(): Promise<Record<string, Record<string, Model<Api>>>> {
	const modelsDir = path.join(packageRoot, "src/models");
	const out: Record<string, Record<string, Model<Api>>> = {};
	for (const entry of await fs.promises.readdir(modelsDir)) {
		if (!entry.endsWith(".json")) continue;
		const provider = entry.replace(/\.json$/, "");
		out[provider] = await Bun.file(path.join(modelsDir, entry)).json();
	}
	return out;
}

const prevModelsJson = await loadPrevModels();

const DISCOVERY_ONLY_PROVIDERS = new Set(["ollama", "vllm", "lm-studio", "litellm"]);
const RETIRED_PROVIDERS = new Set(["wafer-pass", "wandb"]);

async function resolveProviderApiKey(providerId: string, catalog: CatalogDiscoveryConfig): Promise<string | undefined> {
	for (const envVar of catalog.envVars ?? []) {
		const value = $env[envVar as keyof typeof $env];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}

	try {
		const authStorage = await discoverAuthStorage();
		try {
			const storedApiKey = await authStorage.getApiKey(providerId);
			if (storedApiKey) {
				return storedApiKey;
			}
			if (catalog.oauthProvider) {
				const oauthKey = await authStorage.getApiKey(catalog.oauthProvider);
				if (oauthKey) {
					return oauthKey;
				}
			}
		} finally {
			authStorage.close();
		}
	} catch (err) {
		console.warn(
			`Warning: Failed to retrieve credentials for ${providerId}:`,
			err instanceof Error ? err.message : String(err),
		);
	}

	return undefined;
}
type CatalogProviderFetchResult = { models: ModelSpec[]; succeeded: boolean };

async function fetchProviderModelsFromCatalog(
	descriptor: CatalogProviderDescriptor,
): Promise<CatalogProviderFetchResult> {
	const apiKey = await resolveProviderApiKey(descriptor.providerId, descriptor.catalogDiscovery);

	if (!apiKey && !allowsUnauthenticatedCatalogDiscovery(descriptor)) {
		console.log(`No ${descriptor.catalogDiscovery.label} credentials found (env or agent.db), using fallback models`);
		return { models: [], succeeded: false };
	}

	try {
		console.log(`Fetching models from ${descriptor.catalogDiscovery.label} model manager...`);
		const discoveryConfig = { apiKey };
		const preparedConfig =
			getProviderDefinition(descriptor.providerId)?.prepareModelDiscovery?.(discoveryConfig) ?? discoveryConfig;
		const managerOptions = descriptor.createModelManagerOptions(preparedConfig);
		const manager = createModelManager(managerOptions);
		const result = await manager.refresh("online");

		if (result.stale) {
			console.warn(
				`${descriptor.catalogDiscovery.label} dynamic fetch failed (stale cache merge), using fallback models`,
			);
			return { models: [], succeeded: false };
		}
		const models = result.models.filter(model => model.provider === descriptor.providerId);
		if (models.length === 0) {
			console.warn(`${descriptor.catalogDiscovery.label} discovery returned no models`);
			return { models: [], succeeded: true };
		}
		console.log(`Fetched ${models.length} models from ${descriptor.catalogDiscovery.label} model manager`);

		return { models: models.map(model => toModelSpec(model)), succeeded: true };
	} catch (error) {
		console.error(`Failed to fetch ${descriptor.catalogDiscovery.label} models:`, error);
		return { models: [], succeeded: false };
	}
}

async function loadModelsDevData(): Promise<ModelSpec[]> {
	try {
		console.log("Fetching stencil.so catalog from catalog.stencil.so...");
		const data = await fetchWellKnownModels();
		const models = mapModelsDevToModels(data as Record<string, unknown>, MODELS_DEV_PROVIDER_DESCRIPTORS);
		models.sort((a, b) => a.id.localeCompare(b.id));
		console.log(`Loaded ${models.length} tool-capable models from stencil.so`);
		return models;
	} catch (error) {
		console.error("Failed to load stencil.so data:", error);
		return [];
	}
}

function createGlobalModelsDevReferenceMap(modelsDevModels: readonly ModelSpec[]): Map<string, ModelSpec> {
	const references = new Map<string, ModelSpec>();
	for (const model of modelsDevModels) {
		const existing = references.get(model.id);
		if (!existing) {
			references.set(model.id, model);
			continue;
		}
		if ((model.contextWindow ?? 0) > (existing.contextWindow ?? 0)) {
			references.set(model.id, model);
			continue;
		}
		if (
			(model.contextWindow ?? 0) === (existing.contextWindow ?? 0) &&
			(model.maxTokens ?? 0) > (existing.maxTokens ?? 0)
		) {
			references.set(model.id, model);
		}
	}
	return references;
}

function applyGlobalModelsDevFallback(
	models: readonly ModelSpec[],
	modelsDevModels: readonly ModelSpec[],
): ModelSpec[] {
	const providerScopedKeys = new Set(modelsDevModels.map(model => `${model.provider}/${model.id}`));
	const globalReferences = createGlobalModelsDevReferenceMap(modelsDevModels);
	return models.map(model => {
		if (
			providerScopedKeys.has(`${model.provider}/${model.id}`) ||
			model.provider === "devin" ||
			model.provider === "baseten"
		) {
			return model;
		}
		const reference = globalReferences.get(model.id);
		if (!reference) {
			return model;
		}
		return {
			...model,
			name: reference.name,
			reasoning: reference.reasoning,
			input: reference.input,

			contextWindow: model.contextWindow ?? reference.contextWindow,
			maxTokens: model.maxTokens ?? reference.maxTokens,
		};
	});
}

function applyPremiumMultiplierOverrides(models: readonly ModelSpec[]): ModelSpec[] {
	return models.map(model => {
		const premiumMultiplier = COPILOT_PREMIUM_MULTIPLIERS[`${model.provider}/${model.id}`];
		if (premiumMultiplier === undefined) {
			return model;
		}
		if (model.premiumMultiplier === premiumMultiplier) {
			return model;
		}
		return {
			...model,
			premiumMultiplier,
		};
	});
}

function applyUmansPricingFallback(models: readonly ModelSpec[], modelsDevModels: readonly ModelSpec[]): ModelSpec[] {
	const paygCosts = new Map<string, ModelSpec["cost"]>();
	for (const model of modelsDevModels) {
		if (model.provider === "umans" && hasBillableCost(model.cost)) {
			paygCosts.set(model.id, model.cost);
		}
	}

	const flashCost = paygCosts.get("umans-flash");
	if (flashCost) {
		paygCosts.set("umans-qwen3.6-35b-a3b", flashCost);
	}

	return models.map(model => {
		if (model.provider !== "umans" || hasBillableCost(model.cost)) {
			return model;
		}
		const cost = paygCosts.get(model.id);
		return cost ? { ...model, cost: { ...cost } } : model;
	});
}

function applyCodexPricingFallback(models: readonly ModelSpec[]): ModelSpec[] {
	const openAIModels = new Map(
		models
			.filter(model => model.provider === "openai" && hasBillableCost(model.cost))
			.map(model => [model.id, model.cost]),
	);

	return models.map(model => {
		if (model.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
			return model;
		}
		if (hasBillableCost(model.cost)) {
			return model;
		}

		const openAICost = openAIModels.get(model.id) ?? resolveOpenAIDaybreakStandardCost(model.id);
		if (!openAICost) {
			return model;
		}

		return {
			...model,
			cost: { ...openAICost },
		};
	});
}

function applyKimiMaxTokensCap(models: readonly ModelSpec[]): ModelSpec[] {
	const FIREWORKS_KIMI_PROVIDERS = new Set(["fireworks", "firepass"]);
	return models.map(model => {
		if (FIREWORKS_KIMI_PROVIDERS.has(model.provider) && isFireworksKimiK2ModelId(model.id)) {
			const capped = clampFireworksKimiMaxTokens(model.id, model.maxTokens);
			return capped === model.maxTokens ? model : { ...model, maxTokens: capped };
		}
		if (model.provider === "venice" && isKimiK27CodeModelId(model.id)) {
			const capped = clampKimiK27CodeMaxTokens(model.id, model.maxTokens);
			return capped === model.maxTokens ? model : { ...model, maxTokens: capped };
		}
		if (model.provider === "kimi-code") {
			const capped = kimiCodeMaxTokens(model.id, model.maxTokens);
			return capped === model.maxTokens ? model : { ...model, maxTokens: capped };
		}
		return model;
	});
}

function applyFireworksDeepSeekReasoningShape(models: readonly ModelSpec[]): ModelSpec[] {
	return models.map(model => {
		if (model.provider !== "fireworks" || model.api !== "openai-completions") return model;

		return stripFireworksDeepSeekThinkingToggle(model as ModelSpec<"openai-completions">, model.id);
	});
}

function dropUnusableZaiContextTierIds(models: readonly ModelSpec[]): ModelSpec[] {
	return models.filter(model => !(model.provider === "zai" && model.id.endsWith("[1m]")));
}

function dropFireworksWireIds(models: readonly ModelSpec[]): ModelSpec[] {
	return models.filter(
		model =>
			!(
				(model.provider === "fireworks" || model.provider === "firepass") &&
				model.id.startsWith("accounts/fireworks/")
			),
	);
}

function dropXiaomiAudioOnlyIds(models: readonly ModelSpec[]): ModelSpec[] {
	return models.filter(model => {
		const isXiaomiProvider = model.provider === "xiaomi" || model.provider.startsWith("xiaomi-token-plan-");
		return !isXiaomiProvider || (!model.id.includes("-tts") && !model.id.includes("-asr"));
	});
}

function normalizeAntigravityEndpoint(models: readonly ModelSpec[]): ModelSpec[] {
	return models.map(model => {
		if (model.provider === "google-antigravity" && model.baseUrl) {
			return { ...model, baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT };
		}
		return model;
	});
}

const ANTIGRAVITY_ENDPOINT = ANTIGRAVITY_PRIMARY_ENDPOINT;

async function getOAuthAccessFromStorage(provider: OAuthProvider): Promise<OAuthAccess | null> {
	try {
		const authStorage = await discoverAuthStorage();
		try {
			let access = await authStorage.getOAuthAccess(provider);
			if (!access && provider === "google-antigravity") {
				access = await authStorage.getOAuthAccess("google-gemini-cli");
			}
			return access ?? null;
		} finally {
			authStorage.close();
		}
	} catch (err) {
		console.warn(
			`Warning: Failed to retrieve credentials for ${provider}:`,
			err instanceof Error ? err.message : String(err),
		);
		return null;
	}
}

async function fetchAntigravityModels(): Promise<ModelSpec<"google-gemini-cli">[]> {
	const access = await getOAuthAccessFromStorage("google-antigravity");
	if (!access) {
		console.log("No Antigravity or Gemini CLI credentials found, will use previous models.");
		console.log("Tip: If you are logged in under a specific profile, run with PROTO_PROFILE=<name>.");
		return [];
	}
	try {
		console.log("Fetching models from Antigravity API...");
		const discovered = await fetchAntigravityDiscoveryModels({
			token: access.accessToken,
			endpoint: ANTIGRAVITY_ENDPOINT,
		});
		if (discovered === null) {
			console.warn("Antigravity API fetch failed, will use previous models");
			return [];
		}
		if (discovered.length > 0) {
			console.log(`Fetched ${discovered.length} models from Antigravity API`);
			return discovered;
		}
		console.warn("Antigravity API returned no models, will use previous models");
		return [];
	} catch (error) {
		console.error("Failed to fetch Antigravity models:", error);
		return [];
	}
}

async function fetchCodexDiscoveryModels(): Promise<ModelSpec<"openai-codex-responses">[]> {
	console.log("Fetching models from the Pi remote catalog...");
	const result = await fetchCodexModels();
	if (!result) {
		console.warn("Pi remote catalog fetch failed, keeping previous models.");
		return [];
	}
	console.log(`Fetched ${result.models.length} models from the Pi remote catalog`);
	return result.models;
}

async function generateModels() {
	const modelsDevModels = await loadModelsDevData();
	const catalogProviderDescriptors = PROVIDER_DESCRIPTORS.filter(
		(descriptor): descriptor is CatalogProviderDescriptor =>
			isCatalogDescriptor(descriptor) && !DISCOVERY_ONLY_PROVIDERS.has(descriptor.providerId),
	);
	const catalogProviderModelBatches = await Promise.all(
		catalogProviderDescriptors.map(async descriptor => ({
			descriptor,
			...(await fetchProviderModelsFromCatalog(descriptor)),
		})),
	);

	const authoritativeCatalogProviders = new Set(
		catalogProviderModelBatches
			.filter(
				batch =>
					batch.descriptor.dynamicModelsAuthoritative === true &&
					(batch.models.length > 0 || (batch.succeeded && batch.descriptor.providerId === "alibaba-token-plan")),
			)
			.map(batch => batch.descriptor.providerId),
	);
	const catalogProviderModels = catalogProviderModelBatches.flatMap(batch => batch.models);
	const bundledModelsDevModels = modelsDevModels.filter(model => !authoritativeCatalogProviders.has(model.provider));

	const gitLabDuoModels = getGitLabDuoModels().map(model => toModelSpec(model));

	let allModels = applyGlobalModelsDevFallback(
		[...bundledModelsDevModels, ...catalogProviderModels, ...gitLabDuoModels],
		modelsDevModels,
	);

	if (!allModels.some(model => model.provider === "cloudflare-ai-gateway")) {
		allModels.push(CLOUDFLARE_FALLBACK_MODEL as ModelSpec<"anthropic-messages">);
	}

	allModels.push(...buildXaiOAuthStaticSeed());

	allModels.push(...OPENAI_DAYBREAK_CURATED_FALLBACK_MODELS);

	allModels.push(...ANTHROPIC_CURATED_FALLBACK_MODELS);

	allModels.push({
		id: "glm-5.3",
		name: "GLM-5.3",
		api: "anthropic-messages",
		provider: "zai",
		baseUrl: "https://api.z.ai/api/anthropic",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	} as ModelSpec<"anthropic-messages">);

	allModels.push(...META_MUSE_STATIC_MODELS);

	allModels.push(...BEDROCK_MANTLE_STATIC_MODELS);

	if (!authoritativeCatalogProviders.has("sakana")) {
		allModels.push(...SAKANA_FUGU_STATIC_MODELS);
	}

	if (!authoritativeCatalogProviders.has("aiand")) {
		allModels.push(...AIAND_STATIC_MODELS);
	}

	if (!authoritativeCatalogProviders.has("gmi-cloud")) {
		allModels.push(...GMI_CLOUD_STATIC_MODELS);
	}

	if (!authoritativeCatalogProviders.has("gitlab-duo-agent")) {
		allModels.push(buildGitLabDuoWorkflowFallbackModel());
	}

	allModels.push(...buildFireworksFastSeed());

	const specialDiscoverySources = [
		{ label: "Antigravity", providerId: "google-antigravity", authoritative: false, fetch: fetchAntigravityModels },
		{ label: "Codex", providerId: "openai-codex", authoritative: true, fetch: fetchCodexDiscoveryModels },
	] as const;
	const specialDiscoveries = await Promise.all(
		specialDiscoverySources.map(async source => ({
			label: source.label,
			providerId: source.providerId,
			authoritative: source.authoritative,
			models: await source.fetch(),
		})),
	);
	const authoritativeSpecialDiscoveryProviders = new Set<string>();
	for (const discovery of specialDiscoveries) {
		if (discovery.models.length > 0) {
			console.log(`Added ${discovery.models.length} models from ${discovery.label} discovery`);
			allModels.push(...discovery.models);
			if (discovery.authoritative) {
				authoritativeSpecialDiscoveryProviders.add(discovery.providerId);
			}
		}
	}

	const modelsDevSnapshotExcludedProviders = new Set<string>();
	for (const model of modelsDevModels) {
		if (model.provider === "google-vertex") {
			modelsDevSnapshotExcludedProviders.add(model.provider);
		}
	}

	const fetchedKeys = new Set(allModels.map(model => `${model.provider}/${model.id}`));

	for (const models of Object.values(prevModelsJson as unknown as Record<string, Record<string, Model<Api>>>)) {
		for (const bundledModel of Object.values(models)) {
			const model = toModelSpec(bundledModel);
			if (
				!fetchedKeys.has(`${model.provider}/${model.id}`) &&
				!DISCOVERY_ONLY_PROVIDERS.has(model.provider) &&
				!RETIRED_PROVIDERS.has(model.provider) &&
				!authoritativeCatalogProviders.has(model.provider) &&
				!authoritativeSpecialDiscoveryProviders.has(model.provider) &&
				!modelsDevSnapshotExcludedProviders.has(model.provider)
			) {
				allModels.push(model);
			}
		}
	}

	allModels = applyGlobalModelsDevFallback(allModels, modelsDevModels);

	if (!authoritativeCatalogProviders.has("alibaba-token-plan")) {
		allModels.unshift(...ALIBABA_TOKEN_PLAN_STATIC_MODELS);
	}
	allModels = applyUmansPricingFallback(allModels, modelsDevModels);
	allModels = applyPremiumMultiplierOverrides(allModels);
	allModels = applyCodexPricingFallback(allModels);
	allModels = applyAntigravityPricingFallback(allModels);
	allModels = applyKimiMaxTokensCap(allModels);
	allModels = applyFireworksDeepSeekReasoningShape(allModels);
	allModels = dropFireworksWireIds(allModels);
	allModels = dropUnusableZaiContextTierIds(allModels);
	allModels = dropXiaomiAudioOnlyIds(allModels);
	allModels = dropUnsupportedBedrockGeoIds(allModels);
	allModels = dropBedrockMantleOpenAIModels(allModels);
	allModels = normalizeAntigravityEndpoint(allModels);

	allModels = allModels.map(model => {
		const name = cleanModelName(model.name);
		return name === model.name ? model : { ...model, name };
	});

	allModels = projectOpenAIProReasoningAliases(allModels);
	applyGeneratedModelPolicies(allModels);
	linkOpenAIPromotionTargets(allModels);

	allModels = collapseEffortVariantsAcrossProviders(allModels);

	applyCanonicalLimitFallback(allModels);

	applyOllamaCloudOutputCap(allModels);

	for (const model of allModels) {
		canonicalizeModelCompat(model);
	}

	const providers: Record<string, Record<string, ModelSpec>> = {};
	for (const model of allModels) {
		if (DISCOVERY_ONLY_PROVIDERS.has(model.provider) || RETIRED_PROVIDERS.has(model.provider)) continue;
		if (!providers[model.provider]) {
			providers[model.provider] = {};
		}

		if (!providers[model.provider][model.id]) {
			providers[model.provider][model.id] = model;
		}
	}

	const sortObj = <V>(o: Record<string, V>): Record<string, V> => {
		return Object.fromEntries(
			Object.entries(o)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([id, model]) => [id, model]),
		);
	};

	const modelSpecs: Record<string, Record<string, ModelSpec>> = sortObj(providers);
	const MODELS: Record<string, Record<string, Model<Api>>> = {};
	for (const [provider, models] of Object.entries(modelSpecs)) {
		MODELS[provider] = Object.fromEntries(
			Object.entries(sortObj(models)).map(([id, model]) => [id, buildModel(model)]),
		);
	}

	const modelsDir = path.join(packageRoot, "src/models");
	await fs.promises.mkdir(modelsDir, { recursive: true });
	const bundledProviders = Object.keys(MODELS);
	for (const provider of bundledProviders) {
		await Bun.write(path.join(modelsDir, `${provider}.json`), JSON.stringify(MODELS[provider], null, "	"));
	}
	await Bun.write(
		path.join(packageRoot, "src/models-providers.ts"),
		`// Generated by scripts/generate-models.ts. Provider names with bundled model data.\nexport const GENERATED_PROVIDERS = [\n${bundledProviders.map(p => `\t${JSON.stringify(p)},`).join("\n")}\n] as const;\n`,
	);
	await Bun.write(path.join(packageRoot, "src/models-lazy.ts"), generateLazyLoader(bundledProviders));
	await fs.promises.rm(path.join(packageRoot, "src/models.json"), { force: true });
	console.log(`Generated src/models/ (${providers.length} providers)`);

	const totalModels = allModels.length;
	const reasoningModels = allModels.filter(m => m.reasoning).length;

	console.log(`
Model Statistics:`);
	console.log(`  Total tool-capable models: ${totalModels}`);
	console.log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(MODELS)) {
		console.log(`  ${provider}: ${Object.keys(models).length} models`);
	}
}

function canonicalizeModelCompat(model: ModelSpec<Api>): void {
	if (!model.compat) return;

	if ("disableStrictTools" in model.compat && model.compat.disableStrictTools === false) {
		delete model.compat.disableStrictTools;
	}

	let hasKeys = false;
	for (const _ in model.compat) {
		hasKeys = true;
		break;
	}
	if (!hasKeys) {
		delete model.compat;
	}
}

generateModels().catch(console.error);

function generateLazyLoader(providers: string[]): string {
	const cases = providers
		.map(
			provider =>
				`\t\tcase ${JSON.stringify(provider)}:\n\t\t\treturn require("./models/${provider}.json") as Record<string, unknown>;`,
		)
		.join("\n");
	return (
		"// Generated by scripts/generate-models.ts. Static require paths keep the JSON\n" +
		"// embeddable by bundlers while materialization stays lazy per provider.\n" +
		"export function loadProviderModels(provider: string): Record<string, unknown> | undefined {\n" +
		"\tswitch (provider) {\n" +
		cases +
		"\n\t\tdefault:\n\t\t\treturn undefined;\n\t}\n}\n"
	);
}
