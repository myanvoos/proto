import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "../config/settings";
import {
	findRetryFallbackCandidates,
	getRetryFallbackRole,
	installRetryFallbackRole,
	type RetryFallbackChains,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "./retry-fallback-chains";

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
const fallback = getBundledModel("openai", "gpt-4o-mini");

function context(chains: RetryFallbackChains, roles: Record<string, string> = {}): RetryFallbackResolutionContext {
	const models = [model, fallback].filter(candidate => candidate !== undefined);
	return {
		chains,
		getModelRole: role => roles[role],
		modelLookup: {
			find: (provider, id) => models.find(candidate => candidate.provider === provider && candidate.id === id),
			hasProvider: provider => models.some(candidate => candidate.provider === provider),
		},
	};
}

describe("retry fallback chain keys across effort changes", () => {
	const low = "anthropic/claude-sonnet-4-5:low";
	const high = "anthropic/claude-sonnet-4-5:high";

	it("keeps a role's chain when the live effort differs from the role's explicit effort", () => {
		// A spawn `effort` or `/thinking` moved the session off the role's effort.
		const roleOnly = context({ task: ["openai/gpt-4o-mini"] }, { task: low });
		expect(resolveRetryFallbackChainKey(roleOnly, high, model)).toBe("task");
		expect(findRetryFallbackCandidates(roleOnly, "task", high, model).map(candidate => candidate.raw)).toEqual([
			"openai/gpt-4o-mini",
		]);
	});

	it("prefers a role assigned the live effort over one assigned another effort", () => {
		const roles = context({ task: ["openai/gpt-4o-mini"], slow: ["openai/gpt-4o-mini"] }, { task: low, slow: high });
		expect(resolveRetryFallbackChainKey(roles, high, model)).toBe("slow");
	});

	it("keeps model-selector keys effort-exact", () => {
		expect(resolveRetryFallbackChainKey(context({ [low]: ["openai/gpt-4o-mini"] }), high, model)).toBeUndefined();
	});
});

describe("installed fallback roles", () => {
	it("round-trips a role ahead of configured chains without touching other roles", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "openai/gpt-4o-mini" },
			"retry.fallbackChains": { default: ["anthropic/claude-sonnet-4-5"] },
		});
		installRetryFallbackRole(settings, "subagent:w1", {
			primary: "anthropic/claude-sonnet-4-5:low",
			chain: ["openai/gpt-4o-mini"],
		});

		expect(getRetryFallbackRole(settings, "subagent:w1")).toEqual({
			primary: "anthropic/claude-sonnet-4-5:low",
			chain: ["openai/gpt-4o-mini"],
		});
		expect(Object.keys(settings.get("retry.fallbackChains"))).toEqual(["subagent:w1", "default"]);
		expect(settings.getModelRole("default")).toBe("openai/gpt-4o-mini");
		expect(getRetryFallbackRole(settings, "subagent:missing")).toBeUndefined();
	});
});
