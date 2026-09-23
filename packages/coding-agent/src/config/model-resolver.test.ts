import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import {
	parseModelPattern,
	resolveCliModel,
	resolveConfiguredModelPatterns,
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
