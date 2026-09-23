import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { formatModelStringWithRouting } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { collectOnlineTinyCandidates, expandOnlineTinyModelFallbacks } from "./online-candidates";

const primary = getBundledModel("google", "gemini-2.5-flash")!;
const secondary = getBundledModel("openai", "gpt-4o-mini")!;
const fallback = getBundledModel("google-vertex", "gemini-2.5-flash")!;
const routed = getBundledModel("openrouter", "google/gemini-2.5-flash")!;
const models = [primary, secondary, fallback];
const primarySelector = `${primary.provider}/${primary.id}`;
const secondarySelector = `${secondary.provider}/${secondary.id}`;
const fallbackSelector = `${fallback.provider}/${fallback.id}`;

function candidates(chains: Record<string, string[]>, modelFallback = true) {
	const settings = Settings.isolated({ "retry.modelFallback": modelFallback, "retry.fallbackChains": chains });
	settings.setModelRole("tiny", primarySelector);
	settings.setModelRole("smol", secondarySelector);
	return collectOnlineTinyCandidates(["tiny", "smol"], settings, models).map(candidate => candidate.model);
}

describe("online tiny fallback candidates", () => {
	it("stops at the first resolvable role primary when model fallback is disabled", () => {
		expect(candidates({ tiny: [fallbackSelector] }, false)).toEqual([primary]);
		const settings = Settings.isolated({ "retry.modelFallback": false });
		settings.setModelRole("tiny", "missing/unavailable");
		settings.setModelRole("smol", secondarySelector);
		expect(collectOnlineTinyCandidates(["tiny", "smol"], settings, models)).toEqual([
			{ role: "smol", model: secondary },
		]);
	});

	it("keeps role primaries ahead of fallback hops, skipping unavailable, invalid, and duplicate entries", () => {
		expect(
			candidates({ tiny: ["missing/model", "invalid", primarySelector, fallbackSelector, fallbackSelector] }),
		).toEqual(models);
	});

	it("inherits default only for roles without their own chain; an empty chain suppresses it", () => {
		expect(candidates({ tiny: [], default: [fallbackSelector] })).toEqual(models);
		expect(candidates({ tiny: [], smol: [], default: [fallbackSelector] })).toEqual([primary, secondary]);
	});

	it("uses a model-keyed chain over the role chain and follows each hop's own chain", () => {
		expect(candidates({ [primarySelector]: [fallbackSelector], tiny: [secondarySelector], default: [] })).toEqual(
			models,
		);
		const settings = Settings.isolated({
			"retry.fallbackChains": { tiny: [secondarySelector], [secondarySelector]: [fallbackSelector] },
		});
		settings.setModelRole("tiny", primarySelector);
		expect(collectOnlineTinyCandidates(["tiny"], settings, models).map(candidate => candidate.model)).toEqual(models);
	});

	it("expands chains for bare role selectors and wildcards against the resolved model", () => {
		const bare = Settings.isolated({ "retry.fallbackChains": { smol: [fallbackSelector] } });
		bare.setModelRole("smol", secondary.id);
		expect(collectOnlineTinyCandidates(["smol"], bare, models).map(candidate => candidate.model)).toEqual([
			secondary,
			fallback,
		]);
		const wildcard = Settings.isolated({ "retry.fallbackChains": { "openrouter/*": ["google-vertex/*"] } });
		wildcard.setModelRole("tiny", "openrouter/google/gemini-2.5-flash@cerebras");
		expect(
			collectOnlineTinyCandidates(["tiny"], wildcard, [...models, routed]).map(
				candidate => `${candidate.model.provider}/${candidate.model.id}`,
			),
		).toEqual(["openrouter/google/gemini-2.5-flash", fallbackSelector]);
	});

	it("keeps distinct @upstream routes and resolves routed fallback selectors", () => {
		const roles = Settings.isolated({});
		roles.setModelRole("tiny", "openrouter/google/gemini-2.5-flash@cerebras");
		roles.setModelRole("smol", "openrouter/google/gemini-2.5-flash@openai");
		expect(
			collectOnlineTinyCandidates(["tiny", "smol"], roles, [...models, routed]).map(candidate =>
				formatModelStringWithRouting(candidate.model),
			),
		).toEqual(["openrouter/google/gemini-2.5-flash@cerebras", "openrouter/google/gemini-2.5-flash@openai"]);

		const chain = Settings.isolated({
			"retry.fallbackChains": { tiny: ["openrouter/google/gemini-2.5-flash@cerebras"] },
		});
		chain.setModelRole("tiny", primarySelector);
		expect(
			collectOnlineTinyCandidates(["tiny"], chain, [...models, routed]).map(candidate =>
				formatModelStringWithRouting(candidate.model),
			),
		).toEqual([primarySelector, "openrouter/google/gemini-2.5-flash@cerebras"]);
	});

	it("expands an appended seed model's own chain without merging role chains", () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				[primarySelector]: [secondarySelector],
				[secondarySelector]: [fallbackSelector],
				tiny: [routed.id],
			},
		});
		settings.setModelRole("tiny", primarySelector);
		expect(expandOnlineTinyModelFallbacks(primary, settings, models)).toEqual(models);
	});
});
