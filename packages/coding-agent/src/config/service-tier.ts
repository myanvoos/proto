import type { ServiceTier, ServiceTierByFamily, ServiceTierFamily } from "@oh-my-pi/pi-ai";
import type { SubmenuOption } from "./settings-schema";

export const SERVICE_TIER_OPENAI_VALUES = ["none", "auto", "default", "flex", "scale", "priority"] as const;
export const SERVICE_TIER_ANTHROPIC_VALUES = ["none", "priority"] as const;
export const SERVICE_TIER_GOOGLE_VALUES = ["none", "flex", "priority"] as const;

export const PRIORITY_TIER_LABEL = "priority";

export type ServiceTierOpenAISettingValue = (typeof SERVICE_TIER_OPENAI_VALUES)[number];
type ServiceTierAnthropicSettingValue = (typeof SERVICE_TIER_ANTHROPIC_VALUES)[number];
type ServiceTierGoogleSettingValue = (typeof SERVICE_TIER_GOOGLE_VALUES)[number];

export function isServiceTierOpenAISettingValue(value: string): value is ServiceTierOpenAISettingValue {
	return SERVICE_TIER_OPENAI_VALUES.some(tier => tier === value);
}

export function isServiceTierFamily(value: unknown): value is ServiceTierFamily {
	return value === "openai" || value === "anthropic" || value === "google";
}

export function isServiceTierForFamily(family: string, tier: unknown): tier is ServiceTier {
	if (typeof tier !== "string" || tier === "none") return false;
	let values: readonly string[];
	switch (family) {
		case "openai":
			values = SERVICE_TIER_OPENAI_VALUES;
			break;
		case "anthropic":
			values = SERVICE_TIER_ANTHROPIC_VALUES;
			break;
		case "google":
			values = SERVICE_TIER_GOOGLE_VALUES;
			break;
		default:
			return false;
	}
	return values.includes(tier);
}

export const SERVICE_TIER_INHERIT_SETTING_VALUES = [
	"inherit",
	"none",
	"auto",
	"default",
	"flex",
	"scale",
	"priority",
] as const;

type ServiceTierInheritSettingValue = (typeof SERVICE_TIER_INHERIT_SETTING_VALUES)[number];

export const SERVICE_TIER_OPENAI_OPTIONS: ReadonlyArray<SubmenuOption<ServiceTierOpenAISettingValue>> = [
	{ value: "none", label: "None", description: "Omit service_tier (standard processing)" },
	{ value: "auto", label: "Auto", description: "Provider default tier selection" },
	{ value: "default", label: "Default", description: "Standard priority processing" },
	{ value: "flex", label: "Flex", description: "Lower cost, higher latency when available" },
	{ value: "scale", label: "Scale", description: "Scale Tier credits when available" },
	{ value: "priority", label: "Priority", description: "Faster, higher cost (premium request)" },
];

export const SERVICE_TIER_ANTHROPIC_OPTIONS: ReadonlyArray<SubmenuOption<ServiceTierAnthropicSettingValue>> = [
	{ value: "none", label: "None", description: "Standard processing" },
	{
		value: "priority",
		label: "Priority",
		description: 'Fast mode (`speed: "fast"`) on supported direct Claude models; ignored on Bedrock/Vertex',
	},
];

export const SERVICE_TIER_GOOGLE_OPTIONS: ReadonlyArray<SubmenuOption<ServiceTierGoogleSettingValue>> = [
	{ value: "none", label: "None", description: "Standard processing" },
	{ value: "flex", label: "Flex", description: "Lower cost, higher latency (Gemini API + Vertex)" },
	{ value: "priority", label: "Priority", description: "Faster, higher reliability (Gemini API + Vertex)" },
];

export const SERVICE_TIER_INHERIT_OPTIONS: ReadonlyArray<SubmenuOption<ServiceTierInheritSettingValue>> = [
	{ value: "inherit", label: "Inherit", description: "Match the main agent's live per-family tiers" },
	{ value: "none", label: "None", description: "Standard processing" },
	{ value: "auto", label: "Auto", description: "Provider default tier selection (OpenAI family)" },
	{ value: "default", label: "Default", description: "Standard priority processing (OpenAI family)" },
	{ value: "flex", label: "Flex", description: "Flexible capacity tier (OpenAI/Google families)" },
	{ value: "scale", label: "Scale", description: "Scale Tier credits (OpenAI family)" },
	{ value: "priority", label: "Priority", description: "Priority on every supported family of the spawned model" },
];

export function serviceTierSettingToTier(value: string): ServiceTier | undefined {
	if (value === "none" || value === "" || value === "inherit") return undefined;
	return value as ServiceTier;
}

export function buildServiceTierByFamily(openai: string, anthropic: string, google: string): ServiceTierByFamily {
	const out: ServiceTierByFamily = {};
	const o = serviceTierSettingToTier(openai);
	if (o) out.openai = o;
	const a = serviceTierSettingToTier(anthropic);
	if (a) out.anthropic = a;
	const g = serviceTierSettingToTier(google);
	if (g) out.google = g;
	return out;
}

export function serviceTierForAllFamilies(tier: ServiceTier | undefined): ServiceTierByFamily {
	if (!tier) return {};
	const out: ServiceTierByFamily = { openai: tier };
	if (tier === "priority") out.anthropic = "priority";
	if (tier === "flex" || tier === "priority") out.google = tier;
	return out;
}

export function resolveSubagentServiceTier(setting: string, inherited: ServiceTierByFamily): ServiceTierByFamily {
	if (setting === "inherit") return inherited;
	return serviceTierForAllFamilies(serviceTierSettingToTier(setting));
}
