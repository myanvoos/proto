import { buildCompat, buildModel } from "./build";
import { Effort, THINKING_EFFORTS } from "./effort";
import { stripThinkingVariantToken } from "./identity/family";
import { resolveModelThinking } from "./model-thinking";
import type { Api, Model, ModelSpec, Provider, ThinkingConfig } from "./types";

export type VariantSpecLike = Omit<ModelSpec<Api>, "compat"> & { compat?: unknown };

export interface EffortVariantFamily {
	id: string;

	name: string;

	members: readonly string[];

	retiredMembers?: readonly string[];

	routing: Readonly<Partial<Record<Effort | "off", string>>>;

	thinking: Readonly<Omit<ThinkingConfig, "effortRouting" | "suppressWhenOff">>;

	suppressWhenOff?: boolean;

	preserveAbsentEffortRoutes?: boolean;

	extraAliases?: readonly string[];
}

export interface VariantCollapseTable {
	families: readonly EffortVariantFamily[];
}

function thinkingPair(baseId: string, name: string): EffortVariantFamily {
	return {
		id: baseId,
		name,
		members: [baseId, `${baseId}-thinking`],
		routing: {
			off: baseId,
			[Effort.Minimal]: `${baseId}-thinking`,
			[Effort.Low]: `${baseId}-thinking`,
			[Effort.Medium]: `${baseId}-thinking`,
			[Effort.High]: `${baseId}-thinking`,
		},

		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		preserveAbsentEffortRoutes: true,
	};
}

type TierRoutes = Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string>>;

const DEVIN_FIVE_TIER_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];

const DEVIN_FOUR_TIER_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];

function tierFamily(id: string, name: string, routes: TierRoutes, efforts: readonly Effort[]): EffortVariantFamily {
	const routing: Partial<Record<Effort | "off", string>> = {};
	if (routes.off) routing.off = routes.off;
	for (const effort of efforts) {
		switch (effort) {
			case Effort.Minimal:
				if (routes.minimal) routing[effort] = routes.minimal;
				break;
			case Effort.Low:
				if (routes.low) routing[effort] = routes.low;
				break;
			case Effort.Medium:
				if (routes.medium) routing[effort] = routes.medium;
				break;
			case Effort.High:
				if (routes.high) routing[effort] = routes.high;
				break;
			case Effort.XHigh:
				if (routes.xhigh) routing[effort] = routes.xhigh;
				break;
			case Effort.Max:
				if (routes.max) routing[effort] = routes.max;
				break;
		}
	}
	const members = [
		routes.off,
		routes.minimal,
		routes.low,
		routes.medium,
		routes.high,
		routes.xhigh,
		routes.max,
	].filter((member, index, items): member is string => typeof member === "string" && items.indexOf(member) === index);
	return {
		id,
		name,
		members,
		routing,
		thinking: {
			mode: "effort",
			efforts,
			...(routes.off ? undefined : { requiresEffort: true }),
		},
	};
}

function devinGpt56Families(variant: "luna" | "sol" | "terra", name: string): readonly EffortVariantFamily[] {
	const base = `gpt-5-6-${variant}`;
	return [
		tierFamily(
			base,
			name,
			{
				off: `${base}-none`,
				low: `${base}-low`,
				medium: `${base}-medium`,
				high: `${base}-high`,
				xhigh: `${base}-xhigh`,
				max: `${base}-max`,
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
		tierFamily(
			`${base}-fast`,
			`${name} Fast`,
			{
				off: `${base}-none-priority`,
				low: `${base}-low-priority`,
				medium: `${base}-medium-priority`,
				high: `${base}-high-priority`,
				xhigh: `${base}-xhigh-priority`,
				max: `${base}-max-priority`,
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
	];
}

const GEMINI_3_FLASH_FAMILY_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];
const GEMINI_3_PRO_FAMILY_EFFORTS: readonly Effort[] = [Effort.Low, Effort.High];

const GEMINI_3_FLASH_FAMILY_BUDGETS: Readonly<Partial<Record<Effort, number>>> = {
	[Effort.Minimal]: 1000,
	[Effort.Low]: 1000,
	[Effort.Medium]: 4000,
	[Effort.High]: 10000,
};
const GEMINI_3_PRO_FAMILY_BUDGETS: Readonly<Partial<Record<Effort, number>>> = {
	[Effort.Low]: 1001,
	[Effort.High]: 10001,
};

function geminiFlashFamily(mode: "budget" | "google-level"): EffortVariantFamily {
	const budget = mode === "budget";
	return {
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		members: ["gemini-3.5-flash-extra-low", "gemini-3.5-flash-low", "gemini-3-flash-agent"],
		routing: budget
			? {
					off: "gemini-3.5-flash-extra-low",
					[Effort.Minimal]: "gemini-3.5-flash-extra-low",
					[Effort.Low]: "gemini-3.5-flash-extra-low",
					[Effort.Medium]: "gemini-3.5-flash-low",
					[Effort.High]: "gemini-3-flash-agent",
				}
			: {
					off: "gemini-3.5-flash-extra-low",
					[Effort.Minimal]: "gemini-3-flash-agent",
					[Effort.Low]: "gemini-3.5-flash-extra-low",
					[Effort.Medium]: "gemini-3.5-flash-extra-low",
					[Effort.High]: "gemini-3.5-flash-low",
				},
		thinking: budget
			? { mode: "budget", efforts: GEMINI_3_FLASH_FAMILY_EFFORTS, effortBudgets: GEMINI_3_FLASH_FAMILY_BUDGETS }
			: { mode: "google-level", efforts: GEMINI_3_FLASH_FAMILY_EFFORTS },
		suppressWhenOff: true,

		extraAliases: ["gemini-3-flash"],
	};
}

function geminiLevelFlashFamily(version: "3.6" | "3.7", ...additionalMembers: string[]): EffortVariantFamily {
	const id = `gemini-${version}-flash`;
	return {
		id,
		name: `Gemini ${version} Flash`,
		members: [`${id}-low`, `${id}-medium`, `${id}-high`, ...additionalMembers],
		routing: {
			[Effort.Minimal]: `${id}-low`,
			[Effort.Low]: `${id}-low`,
			[Effort.Medium]: `${id}-medium`,
			[Effort.High]: `${id}-high`,
		},
		thinking: {
			mode: "google-level",
			efforts: GEMINI_3_FLASH_FAMILY_EFFORTS,
			requiresEffort: true,
		},
	};
}

const GEMINI_36_FLASH_FAMILY = geminiLevelFlashFamily("3.6", "gemini-3.6-flash-tiered");
const GEMINI_37_FLASH_FAMILY = geminiLevelFlashFamily("3.7");

function geminiProFamily(mode: "budget" | "google-level"): EffortVariantFamily {
	const budget = mode === "budget";
	return {
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro",

		members: ["gemini-3.1-pro-low", "gemini-pro-agent", "gemini-3.1-pro-high"],
		retiredMembers: ["gemini-3.1-pro-high"],
		routing: {
			off: "gemini-3.1-pro-low",
			[Effort.Low]: "gemini-3.1-pro-low",
			[Effort.High]: "gemini-pro-agent",
		},
		thinking: budget
			? { mode: "budget", efforts: GEMINI_3_PRO_FAMILY_EFFORTS, effortBudgets: GEMINI_3_PRO_FAMILY_BUDGETS }
			: { mode: "google-level", efforts: GEMINI_3_PRO_FAMILY_EFFORTS },
		suppressWhenOff: true,
	};
}

const SHARED_CCA_FAMILIES: readonly EffortVariantFamily[] = [
	{
		id: "gemini-3-pro",
		name: "Gemini 3 Pro",
		members: ["gemini-3-pro-low", "gemini-3-pro-high"],
		routing: {
			off: "gemini-3-pro-low",
			[Effort.Low]: "gemini-3-pro-low",
			[Effort.High]: "gemini-3-pro-high",
		},
		thinking: { mode: "google-level", efforts: GEMINI_3_PRO_FAMILY_EFFORTS },
		suppressWhenOff: true,
	},
	{
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B",
		members: ["gpt-oss-120b-medium"],
		routing: {},
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
	},

	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		members: ["claude-sonnet-4-6", "claude-sonnet-4-6-thinking"],
		retiredMembers: ["claude-sonnet-4-6-thinking"],
		routing: {},
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
	},

	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		members: ["claude-opus-4-6-thinking", "claude-opus-4-6"],
		retiredMembers: ["claude-opus-4-6"],
		routing: {},
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
	},
	thinkingPair("claude-sonnet-4-5", "Claude Sonnet 4.5"),
	thinkingPair("claude-opus-4-5", "Claude Opus 4.5"),
	thinkingPair("gemini-2.5-flash", "Gemini 2.5 Flash"),
];

export const ANTIGRAVITY_VARIANT_COLLAPSE_TABLE: VariantCollapseTable = {
	families: [
		GEMINI_36_FLASH_FAMILY,
		GEMINI_37_FLASH_FAMILY,
		geminiFlashFamily("budget"),
		geminiProFamily("budget"),
		...SHARED_CCA_FAMILIES,
	],
};

export const GEMINI_CLI_VARIANT_COLLAPSE_TABLE: VariantCollapseTable = {
	families: [
		GEMINI_36_FLASH_FAMILY,
		GEMINI_37_FLASH_FAMILY,
		geminiFlashFamily("google-level"),
		geminiProFamily("google-level"),
		...SHARED_CCA_FAMILIES,
	],
};
export const DEVIN_VARIANT_COLLAPSE_TABLE: VariantCollapseTable = {
	families: [
		tierFamily(
			"claude-opus-5",
			"Claude Opus 5",
			{
				low: "claude-opus-5-low",
				medium: "claude-opus-5-medium",
				high: "claude-opus-5-high",
				xhigh: "claude-opus-5-xhigh",
				max: "claude-opus-5-max",
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
		tierFamily(
			"claude-opus-5-fast",
			"Claude Opus 5 Fast",
			{
				low: "claude-opus-5-low-fast",
				medium: "claude-opus-5-medium-fast",
				high: "claude-opus-5-high-fast",
				xhigh: "claude-opus-5-xhigh-fast",
				max: "claude-opus-5-max-fast",
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
		tierFamily(
			"claude-fable-5",
			"Claude Fable 5",
			{
				low: "claude-5-fable-low",
				medium: "claude-5-fable-medium",
				high: "claude-5-fable-high",
				xhigh: "claude-5-fable-xhigh",
				max: "claude-5-fable-max",
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
		tierFamily(
			"claude-sonnet-5",
			"Claude Sonnet 5",
			{
				low: "claude-sonnet-5-low",
				medium: "claude-sonnet-5-medium",
				high: "claude-sonnet-5-high",
				xhigh: "claude-sonnet-5-xhigh",
				max: "claude-sonnet-5-max",
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
		tierFamily(
			"claude-opus-4-7",
			"Claude Opus 4.7",
			{
				low: "claude-opus-4-7-low",
				medium: "claude-opus-4-7-medium",
				high: "claude-opus-4-7-high",
				xhigh: "claude-opus-4-7-xhigh",
				max: "claude-opus-4-7-max",
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
		tierFamily(
			"claude-opus-4-7-fast",
			"Claude Opus 4.7 Fast",
			{
				low: "claude-opus-4-7-low-fast",
				medium: "claude-opus-4-7-medium-fast",
				high: "claude-opus-4-7-high-fast",
				xhigh: "claude-opus-4-7-xhigh-fast",
				max: "claude-opus-4-7-max-fast",
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
		tierFamily(
			"claude-opus-4-8",
			"Claude Opus 4.8",
			{
				low: "claude-opus-4-8-low",
				medium: "claude-opus-4-8-medium",
				high: "claude-opus-4-8-high",
				xhigh: "claude-opus-4-8-xhigh",
				max: "claude-opus-4-8-max",
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
		tierFamily(
			"claude-opus-4-8-fast",
			"Claude Opus 4.8 Fast",
			{
				low: "claude-opus-4-8-low-fast",
				medium: "claude-opus-4-8-medium-fast",
				high: "claude-opus-4-8-high-fast",
				xhigh: "claude-opus-4-8-xhigh-fast",
				max: "claude-opus-4-8-max-fast",
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
		tierFamily(
			"gpt-5-2",
			"GPT-5.2",
			{
				off: "MODEL_GPT_5_2_NONE",
				low: "MODEL_GPT_5_2_LOW",
				medium: "MODEL_GPT_5_2_MEDIUM",
				high: "MODEL_GPT_5_2_HIGH",
				xhigh: "MODEL_GPT_5_2_XHIGH",
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
		tierFamily(
			"gpt-5-3-codex",
			"GPT-5.3 Codex",
			{
				low: "gpt-5-3-codex-low",
				medium: "gpt-5-3-codex-medium",
				high: "gpt-5-3-codex-high",
				xhigh: "gpt-5-3-codex-xhigh",
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
		tierFamily(
			"gpt-5-3-codex-fast",
			"GPT-5.3 Codex Fast",
			{
				low: "gpt-5-3-codex-low-priority",
				medium: "gpt-5-3-codex-medium-priority",
				high: "gpt-5-3-codex-high-priority",
				xhigh: "gpt-5-3-codex-xhigh-priority",
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
		tierFamily(
			"gpt-5-4",
			"GPT-5.4",
			{
				off: "gpt-5-4-none",
				low: "gpt-5-4-low",
				medium: "gpt-5-4-medium",
				high: "gpt-5-4-high",
				xhigh: "gpt-5-4-xhigh",
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
		tierFamily(
			"gpt-5-4-fast",
			"GPT-5.4 Fast",
			{
				off: "gpt-5-4-none-priority",
				low: "gpt-5-4-low-priority",
				medium: "gpt-5-4-medium-priority",
				high: "gpt-5-4-high-priority",
				xhigh: "gpt-5-4-xhigh-priority",
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
		tierFamily(
			"gpt-5-4-mini",
			"GPT-5.4 Mini",
			{
				low: "gpt-5-4-mini-low",
				medium: "gpt-5-4-mini-medium",
				high: "gpt-5-4-mini-high",
				xhigh: "gpt-5-4-mini-xhigh",
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
		tierFamily(
			"gpt-5-5",
			"GPT-5.5",
			{
				off: "gpt-5-5-none",
				low: "gpt-5-5-low",
				medium: "gpt-5-5-medium",
				high: "gpt-5-5-high",
				xhigh: "gpt-5-5-xhigh",
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
		tierFamily(
			"gpt-5-5-fast",
			"GPT-5.5 Fast",
			{
				off: "gpt-5-5-none-priority",
				low: "gpt-5-5-low-priority",
				medium: "gpt-5-5-medium-priority",
				high: "gpt-5-5-high-priority",
				xhigh: "gpt-5-5-xhigh-priority",
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
		...devinGpt56Families("luna", "GPT-5.6 Luna"),
		...devinGpt56Families("sol", "GPT-5.6 Sol"),
		...devinGpt56Families("terra", "GPT-5.6 Terra"),
		tierFamily(
			"kimi-k3",
			"Kimi K3",
			{
				low: "kimi-k3-low",
				high: "kimi-k3-high",
				max: "kimi-k3-max",
			},
			[Effort.Low, Effort.High, Effort.Max],
		),
		tierFamily(
			"swe-1-7",
			"SWE-1.7",
			{
				medium: "swe-1-7-medium",
				max: "swe-1-7",
			},
			[Effort.Medium, Effort.Max],
		),
		tierFamily(
			"grok-4-5",
			"Grok 4.5",
			{
				low: "grok-4-5-low",
				medium: "grok-4-5-medium",
				high: "grok-4-5-high",
			},
			[Effort.Low, Effort.Medium, Effort.High],
		),
		tierFamily(
			"inkling",
			"Inkling",
			{
				off: "inkling-none",
				low: "inkling-low",
				medium: "inkling-medium",
				high: "inkling-high",
				xhigh: "inkling-xhigh",
				max: "inkling-max",
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
		tierFamily(
			"gemini-3-1-pro",
			"Gemini 3.1 Pro",
			{
				low: "gemini-3-1-pro-low",
				high: "gemini-3-1-pro-high",
			},
			[Effort.Low, Effort.High],
		),
		tierFamily(
			"gemini-3-5-flash",
			"Gemini 3.5 Flash",
			{
				minimal: "gemini-3-5-flash-minimal",
				low: "gemini-3-5-flash-low",
				medium: "gemini-3-5-flash-medium",
				high: "gemini-3-5-flash-high",
			},
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		),
		tierFamily(
			"gemini-3-6-flash",
			"Gemini 3.6 Flash",
			{
				minimal: "gemini-3-6-flash-minimal",
				low: "gemini-3-6-flash-low",
				medium: "gemini-3-6-flash-medium",
				high: "gemini-3-6-flash-high",
			},
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		),
		tierFamily(
			"gemini-3-flash",
			"Gemini 3 Flash",
			{
				minimal: "MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL",
				low: "MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW",
				medium: "MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM",
				high: "MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH",
			},
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		),

		{
			id: "glm-5-2",
			name: "GLM-5.2",
			members: ["glm-5-2", "glm-5-2-none", "glm-5-2-max"],
			routing: {
				[Effort.High]: "glm-5-2",
				[Effort.XHigh]: "glm-5-2",
			},
			thinking: {
				mode: "effort",
				efforts: [Effort.High, Effort.XHigh],
				requiresEffort: true,
			},
		},

		tierFamily(
			"glm-5-2-1m",
			"GLM-5.2 1M",
			{
				off: "glm-5-2-none-1m",
				high: "glm-5-2-1m",
				xhigh: "glm-5-2-max-1m",
			},
			[Effort.High, Effort.XHigh],
		),
	],
};

const CURSOR_GROK_45_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High];
const CURSOR_GROK_46_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];

const CURSOR_GPT_56_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];

function cursorGrokFamilies(version: "4.5" | "4.6", efforts: readonly Effort[]): readonly EffortVariantFamily[] {
	const build = (fast: boolean): EffortVariantFamily => {
		const suffix = fast ? "-fast" : "";
		const routes: TierRoutes = {};
		for (const effort of efforts) {
			routes[effort] = `cursor-grok-${version}-${effort}${suffix}`;
		}
		return tierFamily(`cursor-grok-${version}${suffix}`, `Grok ${version}${fast ? " Fast" : ""}`, routes, efforts);
	};
	return [build(false), build(true)];
}

function cursorGpt56Families(variant: "luna" | "sol" | "terra", name: string): readonly EffortVariantFamily[] {
	const build = (fast: boolean): EffortVariantFamily => {
		const suffix = fast ? "-fast" : "";
		const base = `gpt-5.6-${variant}`;
		return tierFamily(
			`${base}${suffix}`,
			`${name}${fast ? " Fast" : ""}`,
			{
				off: `${base}-none${suffix}`,
				low: `${base}-low${suffix}`,
				medium: `${base}-medium${suffix}`,
				high: `${base}-high${suffix}`,
				xhigh: `${base}-xhigh${suffix}`,
				max: `${base}-max${suffix}`,
			},
			CURSOR_GPT_56_EFFORTS,
		);
	};
	return [build(false), build(true)];
}

export const CURSOR_VARIANT_COLLAPSE_TABLE: VariantCollapseTable = {
	families: [
		...cursorGrokFamilies("4.5", CURSOR_GROK_45_EFFORTS),
		...cursorGrokFamilies("4.6", CURSOR_GROK_46_EFFORTS),
		...cursorGpt56Families("luna", "GPT-5.6 Luna"),
		...cursorGpt56Families("sol", "GPT-5.6 Sol"),
		...cursorGpt56Families("terra", "GPT-5.6 Terra"),
	],
};

type CursorTierToken = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface CursorTierMember<TSpec extends VariantSpecLike> {
	baseId: string;
	fast: boolean;
	spec: TSpec;
	tier: CursorTierToken;
}

const CURSOR_TIER_ID_PATTERN = /^(.+?)-(extra-high|none|minimal|low|medium|high|xhigh|max)(-fast)?$/;
const CURSOR_TIER_BASE_PATTERN = /-(extra-high|none|minimal|low|medium|high|xhigh|max)$/;
const CURSOR_THINKING_TOKEN_PATTERN = /(^|-)thinking($|-)/;
const CURSOR_TIER_BY_TOKEN: Readonly<Record<string, CursorTierToken | undefined>> = {
	none: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	"extra-high": "xhigh",
	xhigh: "xhigh",
	max: "max",
};

function collapsedCursorLogicalMatches<TSpec extends VariantSpecLike>(
	spec: TSpec,
	members: readonly CursorTierMember<TSpec>[],
): boolean {
	const routing = spec.thinking?.effortRouting;
	if (!routing) return false;
	for (const member of members) {
		if (spec.requestModelId === member.spec.id) continue;
		let matched = false;
		for (const effort of VARIANT_ROUTING_KEYS) {
			if (routing[effort] === member.spec.id) {
				matched = true;
				break;
			}
		}
		if (!matched) return false;
	}
	return true;
}

function deriveCursorEffortFamilies<TSpec extends VariantSpecLike>(specs: readonly TSpec[]): EffortVariantFamily[] {
	const byId = new Map<string, TSpec>();
	const groups = new Map<string, CursorTierMember<TSpec>[]>();
	const candidateBases = new Set<string>();

	for (const spec of specs) {
		if (!byId.has(spec.id)) byId.set(spec.id, spec);
		const match = CURSOR_TIER_ID_PATTERN.exec(spec.id);
		if (!match) continue;
		const baseId = match[1];
		const tier = CURSOR_TIER_BY_TOKEN[match[2] ?? ""];
		const fast = match[3] !== undefined;
		if (!baseId || !tier) continue;
		const member = { baseId, fast, spec, tier };
		const key = `${baseId}\0${fast ? "fast" : "standard"}`;
		const group = groups.get(key);
		if (group) {
			group.push(member);
		} else {
			groups.set(key, [member]);
		}
		candidateBases.add(baseId);
	}

	const unsafeBases = new Set<string>();
	for (const group of groups.values()) {
		const first = group[0];
		if (!first) continue;
		const { baseId } = first;
		const standardGroup = groups.get(`${baseId}\0standard`) ?? [];
		const standardBase = byId.get(baseId);
		const laneBase = byId.get(`${baseId}${first.fast ? "-fast" : ""}`);
		const independentStandardBase =
			standardBase !== undefined && !collapsedCursorLogicalMatches(standardBase, standardGroup);
		const independentLaneBase = laneBase !== undefined && !collapsedCursorLogicalMatches(laneBase, group);
		if (
			independentStandardBase ||
			independentLaneBase ||
			new Set(group.map(member => member.tier)).size !== group.length ||
			CURSOR_TIER_BASE_PATTERN.test(baseId) ||
			CURSOR_THINKING_TOKEN_PATTERN.test(baseId) ||
			candidateBases.has(`${baseId}-thinking`) ||
			byId.has(`${baseId}-thinking`) ||
			byId.has(`${baseId}-thinking-fast`) ||
			byId.has(`${baseId}-fast-thinking`) ||
			group.some(member => member.spec.thinking !== undefined || member.spec.requestModelId !== undefined) ||
			group.some(member => candidateBases.has(`${baseId}-${member.tier}`))
		) {
			unsafeBases.add(baseId);
		}
	}

	const families: EffortVariantFamily[] = [];
	for (const group of groups.values()) {
		const first = group[0];
		if (!first || group.length < 2 || unsafeBases.has(first.baseId)) continue;
		if (
			group.some(
				member =>
					member.spec.api !== first.spec.api ||
					member.spec.baseUrl !== first.spec.baseUrl ||
					member.spec.contextWindow !== first.spec.contextWindow ||
					member.spec.maxTokens !== first.spec.maxTokens ||
					member.spec.cursorMaxMode !== first.spec.cursorMaxMode ||
					!Bun.deepEquals(member.spec.cost, first.spec.cost) ||
					!Bun.deepEquals(member.spec.compat, first.spec.compat),
			)
		) {
			continue;
		}

		const routes: TierRoutes = {};
		for (const member of group) {
			if (member.tier === "none") {
				routes.off = member.spec.id;
			} else {
				routes[member.tier] = member.spec.id;
			}
		}
		const efforts = THINKING_EFFORTS.filter(effort => routes[effort] !== undefined);
		if (efforts.length === 0) continue;
		const strippedName = first.spec.name
			.replace(/\s+(extra-high|none|minimal|low|medium|high|xhigh|max)(\s+fast)?$/i, "")
			.trim();
		const baseName = strippedName === first.spec.id ? first.baseId : strippedName || first.baseId;
		const suffix = first.fast ? "-fast" : "";
		families.push(tierFamily(`${first.baseId}${suffix}`, `${baseName}${first.fast ? " Fast" : ""}`, routes, efforts));
	}
	return families;
}

export const VARIANT_COLLAPSE_TABLES: Readonly<Record<string, VariantCollapseTable>> = {
	"google-antigravity": ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
	"google-gemini-cli": GEMINI_CLI_VARIANT_COLLAPSE_TABLE,
	devin: DEVIN_VARIANT_COLLAPSE_TABLE,
	cursor: CURSOR_VARIANT_COLLAPSE_TABLE,
};

export function deriveThinkingPairFamilies<TSpec extends VariantSpecLike>(
	specs: readonly TSpec[],
	table?: VariantCollapseTable,
): EffortVariantFamily[] {
	const byId = new Map<string, TSpec>();
	for (const spec of specs) {
		if (!byId.has(spec.id)) byId.set(spec.id, spec);
	}
	const claimed = table ? getAliasIndex(table) : undefined;
	const families: EffortVariantFamily[] = [];
	for (const spec of specs) {
		const baseId = stripThinkingVariantToken(spec.id);
		if (baseId === undefined || baseId === spec.id) continue;
		const base = byId.get(baseId);
		if (!base) continue;
		if (claimed) {
			const forward = claimed.forward;
			if (
				forward.has(spec.id.toLowerCase()) ||
				forward.has(baseId.toLowerCase()) ||
				claimed.familyIds.has(spec.id) ||
				claimed.familyIds.has(baseId)
			) {
				continue;
			}
		}
		if (spec.api !== base.api) continue;
		const specPriced = spec.cost.input !== 0 || spec.cost.output !== 0;
		const basePriced = base.cost.input !== 0 || base.cost.output !== 0;
		if (
			specPriced &&
			basePriced &&
			(spec.cost.input !== base.cost.input ||
				spec.cost.output !== base.cost.output ||
				spec.cost.cacheRead !== base.cost.cacheRead ||
				spec.cost.cacheWrite !== base.cost.cacheWrite)
		) {
			continue;
		}
		const surface = derivePairThinkingSurface(spec, base);
		const routing: Partial<Record<Effort | "off", string>> = { off: base.id };
		for (const effort of surface.efforts) {
			routing[effort] = spec.id;
		}
		families.push({
			id: base.id,
			name: base.name,
			members: [base.id, spec.id],
			routing,
			thinking: surface,
		});
	}
	return families;
}

const DEFAULT_PAIR_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];

function derivePairThinkingSurface(
	thinkingSpec: VariantSpecLike,
	baseSpec: VariantSpecLike,
): Omit<ThinkingConfig, "effortRouting" | "suppressWhenOff" | "requiresEffort"> {
	const baked = thinkingSpec.thinking ?? baseSpec.thinking;
	if (baked && baked.efforts.length > 0) {
		const { effortRouting: _routing, suppressWhenOff: _suppress, requiresEffort: _required, ...surface } = baked;
		return surface;
	}
	const derived = resolveModelThinking(
		{ ...(thinkingSpec as unknown as ModelSpec<Api>), reasoning: true, thinking: undefined },
		buildCompat(thinkingSpec as unknown as ModelSpec<Api>),
	);
	if (derived && derived.efforts.length > 0) {
		const { effortRouting: _dRouting, suppressWhenOff: _dSuppress, requiresEffort: _dRequired, ...surface } = derived;
		return surface;
	}
	return { mode: "budget", efforts: DEFAULT_PAIR_EFFORTS };
}

export function isVariantCollapsedSpec(spec: VariantSpecLike): boolean {
	if (spec.thinking?.effortRouting !== undefined) {
		return true;
	}
	if (spec.requestModelId === undefined) {
		return false;
	}
	const table = VARIANT_COLLAPSE_TABLES[spec.provider];
	return table !== undefined && getAliasIndex(table).familyIds.has(spec.id);
}

function reconcileRetiredRouting<TSpec extends VariantSpecLike>(
	spec: TSpec,
	family: EffortVariantFamily,
	retired: ReadonlySet<string>,
): TSpec {
	const routing = spec.thinking?.effortRouting;
	const requestRetired = spec.requestModelId !== undefined && retired.has(spec.requestModelId);
	let routingRetired = false;
	if (routing !== undefined) {
		for (const key in routing) {
			const target = routing[key as Effort | "off"];
			if (target !== undefined && retired.has(target)) {
				routingRetired = true;
				break;
			}
		}
	}
	if (!requestRetired && !routingRetired) return spec;

	const offTarget = family.routing.off;
	const fallbackWireId =
		offTarget !== undefined && !retired.has(offTarget) ? offTarget : family.members.find(id => !retired.has(id));
	const next: TSpec = { ...spec };
	if (routingRetired && routing !== undefined) {
		const nextRouting: Partial<Record<Effort | "off", string>> = {};
		for (const key in routing) {
			const effortKey = key as Effort | "off";
			const target = routing[effortKey];
			if (target === undefined) continue;
			if (!retired.has(target)) {
				nextRouting[effortKey] = target;
				continue;
			}
			const tableTarget = family.routing[effortKey];
			if (tableTarget !== undefined && !retired.has(tableTarget)) {
				nextRouting[effortKey] = tableTarget;
			} else if (fallbackWireId !== undefined) {
				nextRouting[effortKey] = fallbackWireId;
			}
		}
		next.thinking = { ...(spec.thinking as ThinkingConfig), effortRouting: nextRouting };
	}
	if (requestRetired) {
		if (fallbackWireId !== undefined && fallbackWireId !== spec.id) {
			next.requestModelId = fallbackWireId;
		} else {
			delete next.requestModelId;
		}
	}
	return next;
}

function refreshCollapsedThinking<TSpec extends VariantSpecLike>(
	spec: TSpec,
	family: EffortVariantFamily,
	retired: ReadonlySet<string> | undefined,
): TSpec {
	if (!spec.reasoning || family.thinking.effortBudgets === undefined) return spec;
	const routing: Partial<Record<Effort | "off", string>> = {};
	let hasRouting = false;
	for (const effortKey in family.routing) {
		const target = family.routing[effortKey as Effort | "off"];
		if (target !== undefined && !retired?.has(target)) {
			routing[effortKey as Effort | "off"] = target;
			hasRouting = true;
		}
	}
	const thinking: ThinkingConfig = { ...family.thinking };
	if (hasRouting) thinking.effortRouting = routing;
	if (family.suppressWhenOff) thinking.suppressWhenOff = true;
	const offTarget = family.routing.off;
	const requestModelId =
		offTarget !== undefined && !retired?.has(offTarget) && offTarget !== spec.id ? offTarget : spec.requestModelId;
	if (Bun.deepEquals(thinking, spec.thinking) && requestModelId === spec.requestModelId) {
		return spec;
	}
	return { ...spec, thinking, ...(requestModelId !== undefined ? { requestModelId } : {}) };
}

export function collapseEffortVariants<TSpec extends VariantSpecLike>(
	specs: readonly TSpec[],
	table: VariantCollapseTable,
): TSpec[] {
	const byId = new Map<string, TSpec>();
	for (const spec of specs) {
		if (!byId.has(spec.id)) byId.set(spec.id, spec);
	}

	const replacement = new Map<string, TSpec>();

	const familyIdBySpecId = new Map<string, string>();

	for (const family of table.families) {
		const retired =
			family.retiredMembers !== undefined && family.retiredMembers.length > 0
				? new Set(family.retiredMembers)
				: undefined;
		const existing = byId.get(family.id);
		const existingCollapsed =
			existing !== undefined &&
			(existing.requestModelId !== undefined || existing.thinking?.effortRouting !== undefined);
		const reconciled =
			existing !== undefined && existingCollapsed && retired !== undefined
				? reconcileRetiredRouting(existing, family, retired)
				: existing;
		const rawPresent = family.members.filter(id => byId.has(id) && !(id === family.id && existingCollapsed));
		if (rawPresent.length === 0) {
			const refreshed =
				existing !== undefined && existingCollapsed
					? refreshCollapsedThinking(reconciled ?? existing, family, retired)
					: reconciled;
			if (refreshed !== undefined && refreshed !== existing) {
				familyIdBySpecId.set(family.id, family.id);
				replacement.set(family.id, refreshed);
			}
			continue;
		}

		for (const id of rawPresent) familyIdBySpecId.set(id, family.id);
		if (existing) familyIdBySpecId.set(family.id, family.id);

		if (existingCollapsed) {
			replacement.set(family.id, reconciled as TSpec);
			continue;
		}

		const memberSpecs = rawPresent.map(id => byId.get(id) as TSpec);
		const presentSet = new Set(rawPresent);
		const routing: Partial<Record<Effort | "off", string>> = {};
		let hasRouting = false;
		let hasEffortRoute = false;
		let usedAbsentEffortRoute = false;
		for (const effortKey in family.routing) {
			const target = family.routing[effortKey as Effort | "off"];
			const effort = effortKey as Effort | "off";
			const targetPresent = target !== undefined && presentSet.has(target);
			const preserveAbsentEffort =
				target !== undefined && effort !== "off" && family.preserveAbsentEffortRoutes === true;
			if (target !== undefined && (targetPresent || preserveAbsentEffort) && !retired?.has(target)) {
				routing[effort] = target;
				hasRouting = true;
				if (effortKey !== "off") hasEffortRoute = true;
				if (!targetPresent && effort !== "off") usedAbsentEffortRoute = true;
			}
		}

		const reasoning = memberSpecs.some(spec => spec.reasoning) || hasEffortRoute;
		const thinking: ThinkingConfig = { ...family.thinking };
		if (hasRouting) thinking.effortRouting = routing;
		if (family.suppressWhenOff) thinking.suppressWhenOff = true;

		const input: ("text" | "image")[] = [];
		if (memberSpecs.some(spec => spec.input.includes("text"))) input.push("text");
		if (memberSpecs.some(spec => spec.input.includes("image"))) input.push("image");

		const collapsed: TSpec = {
			...(memberSpecs[0] as TSpec),
			id: family.id,
			name: family.name,
			reasoning,
			input,
			contextWindow: maxOrNull(memberSpecs.map(spec => spec.contextWindow)),
			maxTokens: maxOrNull(memberSpecs.map(spec => spec.maxTokens)),
		};

		const defaultWireId = rawPresent.find(id => !retired?.has(id)) ?? rawPresent[0];
		if (defaultWireId === family.id) {
			if (usedAbsentEffortRoute) {
				collapsed.requestModelId = defaultWireId as string;
			} else {
				delete collapsed.requestModelId;
			}
		} else {
			collapsed.requestModelId = defaultWireId as string;
		}
		if (reasoning) {
			collapsed.thinking = thinking;
		} else {
			delete collapsed.thinking;
		}
		replacement.set(family.id, collapsed);
	}

	for (const family of table.families) {
		if (family.extraAliases === undefined) continue;
		const retired =
			family.retiredMembers !== undefined && family.retiredMembers.length > 0
				? new Set(family.retiredMembers)
				: undefined;
		for (const alias of family.extraAliases) {
			if (alias === family.id || familyIdBySpecId.has(alias)) continue;
			const aliasSpec = byId.get(alias);
			if (aliasSpec === undefined) continue;
			const refreshed = refreshCollapsedThinking(aliasSpec, family, retired);
			if (refreshed !== aliasSpec) {
				familyIdBySpecId.set(alias, alias);
				replacement.set(alias, refreshed);
			}
		}
	}

	if (replacement.size === 0) return [...specs];

	const emitted = new Set<string>();
	const out: TSpec[] = [];
	for (const spec of specs) {
		const familyId = familyIdBySpecId.get(spec.id);
		if (familyId === undefined) {
			out.push(spec);
			continue;
		}
		if (emitted.has(familyId)) continue;
		emitted.add(familyId);
		out.push(replacement.get(familyId) as TSpec);
	}
	return out;
}

function retargetCollapsedModelReferences<TSpec extends VariantSpecLike>(specs: TSpec[]): void {
	const liveIdsByProvider = new Map<string, Set<string>>();
	for (const spec of specs) {
		const provider = spec.provider.toLowerCase();
		let liveIds = liveIdsByProvider.get(provider);
		if (!liveIds) {
			liveIds = new Set<string>();
			liveIdsByProvider.set(provider, liveIds);
		}
		liveIds.add(spec.id.toLowerCase());
	}

	for (let index = 0; index < specs.length; index++) {
		const spec = specs[index];
		if (!spec) continue;
		const contextPromotionTarget = resolveCollapsedModelReference(
			spec.contextPromotionTarget,
			spec.provider,
			liveIdsByProvider,
		);
		const compactionModel = resolveCollapsedModelReference(spec.compactionModel, spec.provider, liveIdsByProvider);
		if (contextPromotionTarget === spec.contextPromotionTarget && compactionModel === spec.compactionModel) continue;
		specs[index] = { ...spec, contextPromotionTarget, compactionModel };
	}
}

function resolveCollapsedModelReference(
	target: string | undefined,
	currentProvider: Provider,
	liveIdsByProvider: ReadonlyMap<string, ReadonlySet<string>>,
): string | undefined {
	if (target === undefined) return undefined;
	const separator = target.indexOf("/");
	const provider = separator >= 0 ? target.slice(0, separator) : currentProvider;
	const providerId = provider.toLowerCase();
	const modelId = separator >= 0 ? target.slice(separator + 1) : target;
	const normalizedModelId = modelId.trim().toLowerCase();
	const liveIds = liveIdsByProvider.get(providerId);
	if (liveIds?.has(normalizedModelId)) return target;
	const alias = resolveRegisteredVariantAlias(provider, normalizedModelId);
	if (alias === undefined || !liveIds?.has(alias.toLowerCase())) return target;
	return separator >= 0 ? `${provider}/${alias}` : alias;
}

export function collapseEffortVariantsAcrossProviders<TSpec extends VariantSpecLike>(specs: readonly TSpec[]): TSpec[] {
	const byProvider = new Map<string, TSpec[]>();
	for (const spec of specs) {
		const slice = byProvider.get(spec.provider);
		if (slice) {
			slice.push(spec);
		} else {
			byProvider.set(spec.provider, [spec]);
		}
	}
	const out: TSpec[] = [];
	for (const [provider, slice] of byProvider) {
		const table = VARIANT_COLLAPSE_TABLES[provider];
		let result = table ? collapseEffortVariants(slice, table) : slice;
		if (provider === "cursor") {
			const cursorDerived = deriveCursorEffortFamilies(result);
			if (cursorDerived.length > 0) {
				result = collapseEffortVariants(result, { families: cursorDerived });
			}
		}
		const derived = deriveThinkingPairFamilies(result, table);
		if (derived.length > 0) {
			result = collapseEffortVariants(result, { families: derived });
		}
		registerCollapsedVariantAliases(provider, result);
		out.push(...result);
	}
	retargetCollapsedModelReferences(out);
	return out;
}

export function collapseBuiltModelVariants<TApi extends Api>(models: readonly Model<TApi>[]): Model<TApi>[] {
	const collapsed = collapseEffortVariantsAcrossProviders(models);
	const inputRefs = new Set<Model<TApi>>(models);
	return collapsed.map(model =>
		inputRefs.has(model) ? model : buildModel({ ...model, compat: model.compatConfig } as unknown as ModelSpec<TApi>),
	);
}

interface VariantAliasIndex {
	forward: Map<string, string>;

	reverse: Map<string, string[]>;

	familyIds: Set<string>;
}

// Dynamic aliases are authoritative registry state, not a disposable cache: evicting a
// provider erases aliases needed by later resolution. Registered providers bound the keys.
const dynamicAliasIndexes = new Map<string, VariantAliasIndex>();
const VARIANT_ROUTING_KEYS: readonly (Effort | "off")[] = ["off", ...THINKING_EFFORTS];

const kAliasIndex = Symbol("variant-collapse.aliasIndex");

interface TableWithAliasIndex extends VariantCollapseTable {
	[kAliasIndex]?: VariantAliasIndex;
}

function createAliasIndex(): VariantAliasIndex {
	return {
		forward: new Map<string, string>(),
		reverse: new Map<string, string[]>(),
		familyIds: new Set<string>(),
	};
}

function addVariantAlias(index: VariantAliasIndex, from: string, to: string): boolean {
	if (from === to || index.forward.has(from.toLowerCase())) return false;
	index.forward.set(from.toLowerCase(), to);
	const sources = index.reverse.get(to);
	if (sources) {
		sources.push(from);
	} else {
		index.reverse.set(to, [from]);
	}
	return true;
}

function registerCollapsedVariantAliases(provider: Provider, specs: readonly VariantSpecLike[]): void {
	const providerId = provider.toLowerCase();
	let index = dynamicAliasIndexes.get(providerId);
	for (const spec of specs) {
		const routing = spec.thinking?.effortRouting;
		if (!routing) continue;
		let registered = false;
		for (const effort of VARIANT_ROUTING_KEYS) {
			const source = routing[effort];
			if (!source || source === spec.id) continue;
			index ??= createAliasIndex();
			registered = addVariantAlias(index, source, spec.id) || registered;
		}
		if (spec.requestModelId && spec.requestModelId !== spec.id) {
			index ??= createAliasIndex();
			registered = addVariantAlias(index, spec.requestModelId, spec.id) || registered;
		}
		if (registered) index?.familyIds.add(spec.id);
	}
	if (index) dynamicAliasIndexes.set(providerId, index);
}

function resolveRegisteredVariantAlias(provider: Provider, normalizedModelId: string): string | undefined {
	const providerId = provider.toLowerCase();
	const table = VARIANT_COLLAPSE_TABLES[provider] ?? VARIANT_COLLAPSE_TABLES[providerId];
	return (
		(table ? getAliasIndex(table).forward.get(normalizedModelId) : undefined) ??
		dynamicAliasIndexes.get(providerId)?.forward.get(normalizedModelId)
	);
}

function getAliasIndex(table: VariantCollapseTable): VariantAliasIndex {
	const tagged = table as TableWithAliasIndex;
	const cached = tagged[kAliasIndex];
	if (cached) return cached;
	const index = createAliasIndex();
	for (const family of table.families) {
		index.familyIds.add(family.id);
		for (const member of family.members) addVariantAlias(index, member, family.id);
		for (const alias of family.extraAliases ?? []) addVariantAlias(index, alias, family.id);
	}
	tagged[kAliasIndex] = index;
	return index;
}

export function resolveVariantAlias(provider: Provider, modelId: string): string | undefined {
	return resolveRegisteredVariantAlias(provider, modelId.trim().toLowerCase());
}

export interface BareVariantAliasHit {
	id: string;

	providers: readonly Provider[];
}

export function resolveBareVariantAlias(modelId: string): BareVariantAliasHit | undefined {
	const normalized = modelId.trim().toLowerCase();
	const providerIds = new Set<string>();
	for (const provider in VARIANT_COLLAPSE_TABLES) providerIds.add(provider);
	for (const provider of dynamicAliasIndexes.keys()) providerIds.add(provider);
	for (const provider of providerIds) {
		const hit = resolveRegisteredVariantAlias(provider, normalized);
		if (hit === undefined) continue;
		const providers: Provider[] = [];
		for (const candidate of providerIds) {
			if (resolveRegisteredVariantAlias(candidate, normalized) === hit) {
				providers.push(candidate);
			}
		}
		return { id: hit, providers };
	}
	return undefined;
}

export function getVariantAliasSources(provider: Provider, modelId: string): readonly string[] {
	const providerId = provider.toLowerCase();
	const table = VARIANT_COLLAPSE_TABLES[provider] ?? VARIANT_COLLAPSE_TABLES[providerId];
	const staticSources = table ? getAliasIndex(table).reverse.get(modelId) : undefined;
	const dynamicSources = dynamicAliasIndexes.get(providerId)?.reverse.get(modelId);
	if (!staticSources) return dynamicSources ?? [];
	if (!dynamicSources) return staticSources;
	return [...new Set([...staticSources, ...dynamicSources])];
}

function maxOrNull(values: ReadonlyArray<number | null>): number | null {
	const known = values.filter((v): v is number => v != null);
	return known.length ? Math.max(...known) : null;
}
