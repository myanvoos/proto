import type { TokenCost } from "./types";

export const OPENAI_GPT_56_SOL_STANDARD_COST = {
	input: 5,
	output: 30,
	cacheRead: 0.5,
	cacheWrite: 6.25,
} as const satisfies TokenCost;

export const OPENAI_GPT_56_CYBER_STANDARD_COST = {
	input: 12.5,
	output: 75,
	cacheRead: 1.25,
	cacheWrite: 15.625,
} as const satisfies TokenCost;

export function resolveOpenAIDaybreakStandardCost(modelId: string): TokenCost | undefined {
	switch (modelId) {
		case "gpt-daybreak-blue-latest":
			return OPENAI_GPT_56_SOL_STANDARD_COST;
		case "gpt-daybreak-red-latest":
			return OPENAI_GPT_56_CYBER_STANDARD_COST;
		default:
			return undefined;
	}
}

// Codex subscription credit-equivalent rates: no cache-write charge and no API long-context multiplier. Discovery
// reports API list prices (with the >272K tier) for these SKUs, so the curated rates win for the plain and `-wm` ids.
const CODEX_SUBSCRIPTION_COST: Readonly<Record<string, TokenCost>> = {
	"gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
	"gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
	"gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0 },
};

export function resolveCodexSubscriptionCost(canonicalModelId: string): TokenCost | undefined {
	return CODEX_SUBSCRIPTION_COST[canonicalModelId];
}
