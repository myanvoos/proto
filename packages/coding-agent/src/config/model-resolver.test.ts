import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import {
	extractExplicitThinkingSelector,
	parseModelPattern,
	resolveAgentAdvisorRolePattern,
	resolveAgentModelSelection,
	resolveAgentSpawnModelSelection,
	resolveCliModel,
	resolveConfiguredModelPatterns,
	resolveModelOverrideWithAuthFallback,
	resolveModelRoleValue,
	resolveProviderModelReference,
} from "./model-resolver";
import { Settings } from "./settings";

describe("collapsed-family wire ids", () => {
	const devinModel = (id: string, effortRouting?: Partial<Record<Effort, string>>): Model<Api> =>
		buildModel({
			id,
			name: id,
			api: "devin-agent",
			provider: "devin",
			baseUrl: "https://server.codeium.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
			...(effortRouting
				? { thinking: { mode: "effort", efforts: [Effort.Medium, Effort.High], effortRouting } }
				: {}),
		});
	// Collapsed at discovery time, so no alias table covers its per-effort uids.
	const models = [
		devinModel("claude-mythos-9", {
			[Effort.Medium]: "claude-mythos-9-medium",
			[Effort.High]: "claude-mythos-9-high",
		}),
	];

	test("a raw effort-route uid selects its collapsed model within the named provider only", () => {
		expect(resolveProviderModelReference("devin", "claude-mythos-9-high", models)?.id).toBe("claude-mythos-9");
		expect(resolveProviderModelReference("openai", "claude-mythos-9-high", models)).toBeUndefined();
	});

	test("a live raw model wins over the collapsed carrier routing to it", () => {
		const withRaw = [...models, devinModel("claude-mythos-9-high")];
		expect(resolveProviderModelReference("devin", "claude-mythos-9-high", withRaw)?.id).toBe("claude-mythos-9-high");
	});

	test("a provider-qualified effort-route uid keeps that route's thinking level", () => {
		const routed = parseModelPattern("devin/claude-mythos-9-high", models);
		expect(routed.model?.id).toBe("claude-mythos-9");
		expect(routed.thinkingLevel).toBe(Effort.High);
		expect(routed.explicitThinkingLevel).toBe(true);
		expect(parseModelPattern("devin/claude-mythos-9", models).thinkingLevel).toBeUndefined();
	});
});

describe("unset roles resolving through other roles", () => {
	const first = (role: string, modelRoles: Record<string, string>) =>
		resolveConfiguredModelPatterns(`@${role}`, Settings.isolated({ modelRoles }))[0];

	test("tiny follows the configured smol model", () => {
		expect(first("tiny", { smol: "openai/gpt-5-mini" })).toBe("openai/gpt-5-mini");
	});

	test("advisor follows an explicitly configured slow model but never inherits the primary", () => {
		expect(first("advisor", { slow: "anthropic/claude-opus-5" })).toBe("anthropic/claude-opus-5");
		expect(first("advisor", { default: "local/primary" })).not.toBe("local/primary");
	});

	test("a tiny -> smol -> default -> tiny alias cycle falls back to built-in models", () => {
		const patterns = resolveConfiguredModelPatterns(
			"@tiny",
			Settings.isolated({ modelRoles: { smol: "@default", default: "@tiny" } }),
		);
		expect(patterns.length).toBeGreaterThan(0);
		expect(patterns.some(pattern => pattern.startsWith("@"))).toBe(false);
	});
});

describe("@upstream routing selector", () => {
	const model = (provider: string, id: string, baseUrl: string): Model<Api> =>
		buildModel({
			id,
			name: id,
			api: "openai-completions",
			provider,
			baseUrl,
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
	const models = [
		model("google", "gemini-2.5-pro", "https://generativelanguage.googleapis.com/v1beta"),
		model("openrouter", "google/gemini-2.5-pro", "https://openrouter.ai/api/v1"),
	];
	const openRouterOnly = (resolved: Model<Api> | undefined): string[] | undefined =>
		(resolved?.compat as { openRouterRouting?: { only?: string[] } } | undefined)?.openRouterRouting?.only;

	test("pins a tiered upstream slug and keeps a trailing thinking level", () => {
		const result = parseModelPattern("openrouter/google/gemini-2.5-pro@google-vertex/global/flex:high", models);
		expect(result.model?.provider).toBe("openrouter");
		expect(result.thinkingLevel).toBe(Effort.High);
		expect(openRouterOnly(result.model)).toEqual(["google-vertex/global/flex"]);
	});

	test("resolveCliModel routes an aggregator id the first-party provider also bundles", () => {
		const result = resolveCliModel({
			cliModel: "openrouter/google/gemini-2.5-pro@google-ai-studio/priority",
			modelRegistry: { getAll: () => models, getAvailable: () => models } as unknown as Parameters<
				typeof resolveCliModel
			>[0]["modelRegistry"],
		});
		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.selector).toBe("openrouter/google/gemini-2.5-pro@google-ai-studio/priority");
		expect(openRouterOnly(result.model)).toEqual(["google-ai-studio/priority"]);
	});
});

describe("resolveCliModel with disabledProviders", () => {
	const gpt55 = (provider: string, api: Api, baseUrl: string): Model<Api> =>
		buildModel({
			id: "gpt-5.5",
			name: "GPT-5.5",
			api,
			provider,
			baseUrl,
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		});
	const models = [
		gpt55("openai", "openai-responses", "https://api.openai.com"),
		gpt55("openai-codex", "openai-codex-responses", "https://chatgpt.com/backend-api/codex/responses"),
	];
	const registry = { getAll: () => models, getAvailable: () => models };
	const settings = Settings.isolated({ disabledProviders: ["openai-codex"] });

	test("refuses a provider-qualified pin and names the disabled provider", () => {
		const result = resolveCliModel({ cliModel: "openai-codex/gpt-5.5", modelRegistry: registry, settings });
		expect(result.model).toBeUndefined();
		expect(result.disabledProvider).toBe("openai-codex");
		expect(result.error).toContain("openai-codex");
	});

	test("refuses a --provider/--model pair naming the disabled provider", () => {
		const result = resolveCliModel({
			cliProvider: "openai-codex",
			cliModel: "gpt-5.5",
			modelRegistry: registry,
			settings,
		});
		expect(result.model).toBeUndefined();
		expect(result.disabledProvider).toBe("openai-codex");
	});

	test("falls through to an enabled provider carrying the same id", () => {
		const result = resolveCliModel({
			cliModel: "gpt-5.5",
			modelRegistry: registry,
			availableModels: models.filter(model => model.provider === "openai-codex"),
			settings,
		});
		expect(result.error).toBeUndefined();
		expect(result.disabledProvider).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
	});

	test("refuses a configured role whose only candidate is disabled", () => {
		const result = resolveCliModel({
			cliModel: "task",
			modelRegistry: registry,
			settings: Settings.isolated({
				disabledProviders: ["openai-codex"],
				modelRoles: { task: "openai-codex/gpt-5.5" },
			}),
		});
		expect(result.model).toBeUndefined();
		expect(result.disabledProvider).toBe("openai-codex");
	});
});

describe("retired wire-tier ids", () => {
	const flash = buildModel({
		id: "gemini-3.5-flash",
		requestModelId: "gemini-3.5-flash-extra-low",
		name: "Gemini 3.5 Flash",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		thinking: {
			mode: "google-level",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			effortRouting: {
				off: "gemini-3.5-flash-extra-low",
				[Effort.Minimal]: "gemini-3-flash-agent",
				[Effort.Low]: "gemini-3.5-flash-extra-low",
				[Effort.Medium]: "gemini-3.5-flash-extra-low",
				[Effort.High]: "gemini-3.5-flash-low",
			},
		},
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_535,
	});

	test("a route owned by one level implies that level", () => {
		const result = parseModelPattern("google-antigravity/gemini-3.5-flash-low", [flash]);
		expect(result.model?.id).toBe("gemini-3.5-flash");
		expect(result.thinkingLevel).toBe(Effort.High);
	});

	test("the default wire id shared by several levels leaves the thinking level unset", () => {
		const result = parseModelPattern("google-antigravity/gemini-3.5-flash-extra-low", [flash]);
		expect(result.model?.id).toBe("gemini-3.5-flash");
		expect(result.thinkingLevel).toBeUndefined();
		expect(result.explicitThinkingLevel).toBe(false);
	});
});

test("built-in smol priorities match `*-mini` ids but not gemini or minimax ids", () => {
	const settings = Settings.isolated({});
	const chatModel = (provider: string, id: string): Model<Api> =>
		buildModel({
			id,
			name: id,
			api: "openai-completions",
			provider,
			baseUrl: "https://example.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
	const large = [
		chatModel("custom", "google/gemini-3.1-pro-preview"),
		chatModel("google", "gemini-2.5-pro"),
		chatModel("minimax", "MiniMax-M2"),
	];

	expect(resolveModelRoleValue("@smol", large, { settings }).model).toBeUndefined();
	expect(resolveModelRoleValue("@smol", [...large, chatModel("openai", "o4-mini")], { settings }).model?.id).toBe(
		"o4-mini",
	);
});

test("a child advisor resolves owner aliases before its own advisor role is assigned", () => {
	const settings = Settings.isolated({ modelRoles: { advisor: "@slow", slow: "openai/gpt-5:high" } });
	expect(resolveAgentAdvisorRolePattern("@advisor", settings)).toBe("openai/gpt-5:high");
	expect(resolveAgentAdvisorRolePattern("@advisor,openai/gpt-4.1", settings)).toBe("openai/gpt-5:high,openai/gpt-4.1");
});

function selectorModel(provider: string, id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "https://models.example/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 64000,
		maxTokens: 8000,
	});
}

test("bare CLI model ids honor configured provider order and recent exact matches", () => {
	const models = [selectorModel("first", "shared-id"), selectorModel("preferred", "shared-id")];
	const modelRegistry = { getAll: () => models, getAvailable: () => models };
	expect(
		resolveCliModel({
			cliModel: "shared-id",
			modelRegistry,
			settings: Settings.isolated({ modelProviderOrder: ["preferred", "first"] }),
		}).model?.provider,
	).toBe("preferred");
	expect(
		resolveCliModel({
			cliModel: "shared-id:high",
			modelRegistry,
			preferences: { usageOrder: ["preferred/shared-id"] },
		}).model?.provider,
	).toBe("preferred");
});

test("provider-qualified misses never fuzzy-route but retain a same-provider spelling hint", () => {
	const models = [selectorModel("custom", "target-model"), selectorModel("gateway", "custom/target-old")];
	expect(parseModelPattern("custom/target", models).model).toBeUndefined();
	const resolved = resolveCliModel({
		cliModel: "custom/target",
		modelRegistry: { getAll: () => models, getAvailable: () => models },
	});
	expect(resolved.error).toContain("custom/target-model");
	expect(resolved.model).toBeUndefined();
	const cold = resolveCliModel({
		cliModel: "pending/missing",
		modelRegistry: {
			getAll: () => [selectorModel("gateway", "pending/missing-later")],
			getAvailable: () => [selectorModel("gateway", "pending/missing-later")],
			hasProvider: id => id === "pending",
		},
	});
	expect(cold.model).toBeUndefined();
});

test("provider ids differing only by case remain individually selectable while ambiguous casing is refused", () => {
	const models = [selectorModel("vendor", "MiMo-V2"), selectorModel("vendor", "mimo-v2")];
	expect(resolveProviderModelReference("vendor", "MiMo-V2", models)?.id).toBe("MiMo-V2");
	expect(resolveProviderModelReference("vendor", "mimo-v2", models)?.id).toBe("mimo-v2");
	expect(resolveProviderModelReference("vendor", "MIMO-V2", models)).toBeUndefined();
});

test("short selectors retain explicit effort without splitting literal max-suffixed ids", () => {
	expect(extractExplicitThinkingSelector("x:high")).toBe(Effort.High);
	expect(
		extractExplicitThinkingSelector("x:max", undefined, {
			isLiteralModelId: (provider, id) => provider === undefined && id === "x:max",
		}),
	).toBeUndefined();
});

test("per-call default selects the live parent while agent frontmatter expands the configured default", () => {
	const options = {
		settings: Settings.isolated({ modelRoles: { default: "vendor/configured" } }),
		activeModelPattern: "vendor/live",
	};
	expect(resolveAgentSpawnModelSelection({ ...options, requestModel: "@default:high" }).patterns).toEqual([
		"vendor/live:high",
	]);
	expect(resolveAgentModelSelection({ ...options, agentModel: "@default:high" }).patterns).toEqual([
		"vendor/configured:high",
	]);
});

test("auth fallback skips disabled models and tries remaining configured candidates before the parent", async () => {
	const models = [
		selectorModel("vendor", "no-key"),
		selectorModel("vendor", "working"),
		selectorModel("vendor", "parent"),
	];
	const modelRegistry = {
		getAvailable: () => models,
		getApiKey: async (model: Model<Api>) => (model.id === "no-key" ? undefined : "working-key"),
	};
	const result = await resolveModelOverrideWithAuthFallback(
		["vendor/no-key", "vendor/working"],
		"vendor/parent",
		modelRegistry,
		Settings.isolated(),
	);
	expect(result.model?.id).toBe("working");
	expect(result.authFallbackUsed).toBe(false);
	const restricted = await resolveModelOverrideWithAuthFallback(
		["vendor/no-key", "vendor/working"],
		"vendor/parent",
		modelRegistry,
		Settings.isolated({ enabledModels: ["vendor/no-key"] }),
	);
	expect(restricted.model?.id).toBe("no-key");
	const perCall = await resolveModelOverrideWithAuthFallback(
		["vendor/no-key", "vendor/working"],
		undefined,
		modelRegistry,
		Settings.isolated(),
		undefined,
		{ perCallModel: true },
	);
	expect(perCall.model?.id).toBe("working");
});
