import { Effort } from "./effort";
import { bareModelId, parseAnthropicModel, parseGeminiModel, parseOpenAIModel, semverGte } from "./identity/classify";
import { isKimiK3ModelId } from "./identity/family";
import { applyNewProviderPolicy } from "./provider-models/new-providers";
import type { AntigravityModelWireProfile, Api, ModelCost, ModelSpec, TokenCost } from "./types";
import { isOfficialCodexApiUrl } from "./wire/codex";

const FIVE_EFFORTS = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] as const;
/**
 * Cloud Code Assist rejects Claude 4.x requests over 64,000 output tokens with
 * a 400 (`Request contains an invalid argument`) even when the roster
 * advertises 65,536. The ceiling also lowers the discovered per-SKU wire caps
 * the transport sends verbatim.
 */
const ANTIGRAVITY_CLAUDE_OUTPUT_CEILING = 64_000;
const HAIKU_COST: TokenCost = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };
const ARGON_INTRO: TokenCost = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 };
const ARGON_LIST: TokenCost = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 };

/**
 * Lower per-SKU Antigravity output caps to the host's ceiling. The transport
 * sends a profile's `maxOutputTokens` verbatim, so a roster value above the
 * ceiling must be corrected here as the row's `maxTokens` is.
 */
function capAntigravityWireProfiles(
	profiles: Readonly<Record<string, AntigravityModelWireProfile>> | undefined,
	ceiling: number,
): Readonly<Record<string, AntigravityModelWireProfile>> | undefined {
	if (profiles === undefined) return undefined;
	let capped: Record<string, AntigravityModelWireProfile> | undefined;
	for (const [wireId, profile] of Object.entries(profiles)) {
		if (profile.maxOutputTokens === undefined || profile.maxOutputTokens <= ceiling) continue;
		capped ??= { ...profiles };
		capped[wireId] = { ...profile, maxOutputTokens: ceiling };
	}
	return capped ?? profiles;
}

function tier(cost: TokenCost, inputThreshold: number, multiplier: number, outputMultiplier = multiplier): ModelCost {
	return {
		...cost,
		longContext: {
			inputThreshold,
			input: cost.input * multiplier,
			output: cost.output * outputMultiplier,
			cacheRead: cost.cacheRead * multiplier,
			cacheWrite: cost.cacheWrite * multiplier,
		},
	};
}

/** Reviewed provider contracts applied to both live discovery and generated snapshots. */
export function applyModelPolicy<TApi extends Api>(source: ModelSpec<TApi>): ModelSpec<TApi> {
	const model = { ...source, cost: { ...source.cost } };
	if (model.provider === "cursor" && model.toolSchemasInContext === undefined) model.toolSchemasInContext = false;
	const id = bareModelId(model.requestModelId ?? model.id);
	if (model.provider === "openai" || model.provider === "openai-codex") {
		const codex = model.provider === "openai-codex";
		model.serviceTierCost = { flex: 0.5, priority: codex ? 2.5 : 2, ...model.serviceTierCost };
		if (/^gpt-(?:6-astra|6\.1-sol)(?:-|$)/.test(id)) {
			model.serviceTierCost = { ...model.serviceTierCost, ultrafast: codex ? 8 : 6 };
		}
	}
	const claude = parseAnthropicModel(id);
	const gemini = parseGeminiModel(id);
	const openai = parseOpenAIModel(id);
	if (model.provider === "google-antigravity" && claude !== null && !semverGte(claude.version, "5")) {
		if (model.maxTokens !== null && model.maxTokens > ANTIGRAVITY_CLAUDE_OUTPUT_CEILING) {
			model.maxTokens = ANTIGRAVITY_CLAUDE_OUTPUT_CEILING;
		}
		model.antigravityWireProfiles = capAntigravityWireProfiles(
			model.antigravityWireProfiles,
			ANTIGRAVITY_CLAUDE_OUTPUT_CEILING,
		);
	}
	if (claude?.kind === "haiku" && semverGte(claude.version, "5.5")) {
		model.reasoning = true;
		if (!model.input.includes("image")) model.input = ["text", "image"];
		if (model.provider !== "github-copilot" && model.provider !== "cursor" && model.provider !== "devin") {
			model.contextWindow = 1_000_000;
			model.maxTokens = 128_000;
		}
		if (
			[
				"anthropic",
				"google-vertex",
				"google-antigravity",
				"amazon-bedrock",
				"vercel-ai-gateway",
				"cursor",
				"devin",
			].includes(model.provider)
		) {
			model.cost = tier(HAIKU_COST, 100_000, 5);
		} else if (model.provider === "github-copilot") {
			model.cost = { ...HAIKU_COST };
		}
		model.thinking = {
			...model.thinking,
			mode: "anthropic-adaptive",
			efforts: FIVE_EFFORTS,
			defaultLevel: Effort.Medium,
			supportsDisplay: true,
			prefixBinding: true,
		};
	}
	if (model.provider === "google-antigravity" && claude?.version.major === 5 && claude.version.minor === 5) {
		if (claude.kind === "opus") model.cost = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
		if (claude.kind === "sonnet") model.cost = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
	}
	if (gemini?.kind === "argon") {
		model.reasoning = true;
		model.thinking = {
			...model.thinking,
			mode: "google-level",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
			requiresEffort: true,
		};
		if (["google", "google-vertex", "google-antigravity", "cursor"].includes(model.provider)) {
			model.cost = {
				...ARGON_INTRO,
				timeBased: {
					offPeakMultiplier: 1,
					peakWindows: [],
					effectiveRates: [
						{ effectiveFrom: 0, ...ARGON_INTRO },
						{ effectiveFrom: Date.UTC(2026, 11, 1, 8), ...ARGON_LIST },
					],
				},
			};
		}
	}
	if (model.provider === "openai" && ["gpt-6-sol", "gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol"].includes(id)) {
		model.cost = tier(model.cost, 272_000, 2, 1.5);
	}
	if ((model.provider === "openai" || model.provider === "openai-codex") && /^gpt-5\.6(?:-sol)?(?:-|$)/.test(id)) {
		model.cost.longContext = { inputThreshold: 272_000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 };
	}
	if (model.provider === "openai-codex" && /^gpt-6\.1-sol(?:-wm)?$/.test(id)) model.contextWindow = 500_000;
	if (/^gpt-6\.1-terra(?:-wm)?$/.test(id) && (model.provider === "openai" || model.provider === "openai-codex")) {
		model.cost = {
			...model.cost,
			input: 1,
			output: 5,
			cacheRead: 0.05,
			cacheWrite: model.provider === "openai-codex" ? 0 : 1.25,
		};
		model.maxContextWindow = Math.max(model.maxContextWindow ?? 0, 922_000);
		if (model.provider === "openai") model.cost = tier(model.cost, 272_000, 2, 1.5);
	}
	if (["minimax", "minimax-cn", "minimax-code", "minimax-code-cn"].includes(model.provider) && id === "MiniMax-M3") {
		model.cost = tier(model.cost, 512_000, 2);
	}
	if (/^minimax-m3\.1-flash(?:-preview)?$/i.test(id)) {
		model.reasoning = true;
		model.thinking = {
			mode: model.api === "anthropic-messages" ? "anthropic-adaptive" : "effort",
			efforts: FIVE_EFFORTS,
			requiresEffort: true,
			effortMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
		};
	}
	if (model.provider === "meta" || model.provider === "muse-code") {
		if (/^muse-wonder-(?:full-)?1\.0(?:-contributor)?$/.test(id)) {
			const contributor = id.includes("contributor");
			model.cost = contributor
				? { input: 1.6, output: 8, cacheRead: 0.08, cacheWrite: 0 }
				: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 };
			model.contextWindow = 1_048_576;
			model.maxTokens = 131_072;
		}
	}
	if (model.provider === "cursor" && id.startsWith("deepseek-v41-flash-1017")) {
		model.cost = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 };
	}
	if (model.provider === "google" && /(?:^|[/-])gemma-?4(?:[-.]|$)/i.test(id)) {
		model.reasoning = true;
		model.thinking = { mode: "google-level", efforts: [Effort.High], suppressWhenOff: true };
	}
	if (model.provider === "xai-oauth" && id.startsWith("grok-4.20")) model.contextWindow = 1_000_000;
	if (model.provider === "moonshot" || model.provider === "kimi-code") {
		if (isKimiK3ModelId(id)) {
			model.cost.cacheWrite = model.cost.input;
			model.maxTokens = Math.min(model.maxTokens ?? 131_072, 131_072);
		}
		if (/^(?:kimi-)?k3\.1-pro(?:-highspeed)?$/.test(id)) {
			const fast = id.endsWith("-highspeed");
			model.cost = { input: fast ? 4 : 2, output: fast ? 20 : 10, cacheRead: 0.2, cacheWrite: fast ? 4 : 2 };
			model.maxTokens = 131_072;
		}
	}
	if (model.provider === "deepseek" && id === "deepseek-v4-pro") {
		model.cost = {
			input: 1.32,
			output: 3.96,
			cacheRead: 0.044,
			cacheWrite: 0,
			timeBased: {
				offPeakMultiplier: 0.5,
				peakWindows: [
					{ weekdays: [1, 2, 3, 4, 5], startMinute: 60, endMinute: 240 },
					{ weekdays: [1, 2, 3, 4, 5], startMinute: 360, endMinute: 600 },
				],
			},
		};
	}
	if (model.provider === "devin") {
		const gptCache = openai && semverGte(openai.version, "5.6") && openai.version.major < 7;
		model.cost.cacheWrite = claude || gptCache ? model.cost.input * 1.25 : id === "adaptive" ? model.cost.input : 0;
		const gptTier =
			openai &&
			!["mini", "nano"].includes(openai.variant) &&
			semverGte(openai.version, "5.4") &&
			openai.version.major < 7;
		const geminiTier =
			gemini?.kind === "pro" &&
			((gemini.version.major === 2 && gemini.version.minor === 5) ||
				(semverGte(gemini.version, "3.1") && gemini.version.major < 4));
		if (gptTier || geminiTier) model.cost = tier(model.cost, gptTier ? 272_000 : 200_000, 2, 1.5);
		else if (/grok-4[.-](?:[5-9]|[1-9]\d)/i.test(id)) model.cost = tier(model.cost, 200_000, 2);
	}
	return applyNewProviderPolicy(model);
}

function seed(
	provider: string,
	api: Api,
	baseUrl: string,
	id: string,
	name: string,
	cost: TokenCost,
	contextWindow = 1_000_000,
	maxTokens: number | null = 128_000,
): ModelSpec {
	return {
		provider,
		api,
		baseUrl,
		id,
		name,
		cost,
		contextWindow,
		maxTokens,
		reasoning: true,
		input: ["text", "image"],
	};
}

/** Offline fallback only; successful authoritative discovery still owns account entitlements. */
export const REVIEWED_MODEL_SEEDS: readonly ModelSpec[] = [
	seed(
		"anthropic",
		"anthropic-messages",
		"https://api.anthropic.com",
		"claude-haiku-5-5",
		"Claude Haiku 5.5",
		HAIKU_COST,
	),
	seed("openai", "openai-responses", "https://api.openai.com/v1", "gpt-6.1-terra", "GPT-6.1 Terra", {
		input: 1,
		output: 5,
		cacheRead: 0.05,
		cacheWrite: 1.25,
	}),
	seed(
		"mistral",
		"openai-completions",
		"https://api.mistral.ai/v1",
		"mistral-large-4",
		"Mistral Large 4",
		{ input: 0.68, output: 2.09, cacheRead: 0.07, cacheWrite: 0 },
		1_000_000,
		null,
	),
	seed(
		"mistral",
		"openai-completions",
		"https://api.mistral.ai/v1",
		"mistral-large-4-0",
		"Mistral Large 4",
		{ input: 0.68, output: 2.09, cacheRead: 0.07, cacheWrite: 0 },
		1_000_000,
		null,
	),
	seed(
		"zhipu-coding-plan",
		"openai-completions",
		"https://open.bigmodel.cn/api/coding/paas/v4",
		"glm-5.3-flashx",
		"GLM-5.3-FlashX",
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		1_000_000,
		131_072,
	),
	...["meta", "muse-code"].flatMap(provider =>
		(provider === "meta"
			? ["muse-wonder-1.0"]
			: [
					"muse-wonder-1.0",
					"muse-wonder-1.0-contributor",
					"muse-wonder-full-1.0",
					"muse-wonder-full-1.0-contributor",
				]
		).map(id => ({
			...seed(
				provider,
				"openai-responses",
				"https://api.meta.ai/v1",
				id,
				id.replaceAll("-", " "),
				{ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
				1_048_576,
				131_072,
			),
			thinking: { mode: "effort" as const, efforts: [Effort.Minimal, ...FIVE_EFFORTS] },
		})),
	),
];

/** Only deployments whose same-family key warms independently of the prompt itself. */
export function supportsSharedPromptCache(
	model: Pick<ModelSpec, "provider" | "api" | "id" | "requestModelId">,
): boolean {
	const id = model.requestModelId ?? model.id;
	if (model.provider === "muse-code" && model.api === "openai-responses") {
		return [
			"muse-spark-1.3",
			"muse-spark-1.3-contributor",
			"muse-wonder-1.0",
			"muse-wonder-1.0-contributor",
			"muse-wonder-full-1.0",
			"muse-wonder-full-1.0-contributor",
		].includes(id);
	}
	if (model.provider !== "opencode-go") return false;
	if (model.api === "openai-responses")
		return [
			"muse-spark-1.3-contributor",
			"muse-spark-1.2-contributor",
			"gpt-5.6-luna",
			"gpt-6-luna",
			"grok-4.6",
		].includes(id);
	return model.api === "openai-completions" && (id === "deepseek-v4-pro" || id === "omen-alpha");
}

/** Native Codex subscription caches have no TTL; proxies cannot inherit this promise. */
export function isPromptCachePersistent(model: Pick<ModelSpec, "provider" | "baseUrl">): boolean {
	return model.provider === "openai-codex" && isOfficialCodexApiUrl(model.baseUrl);
}
