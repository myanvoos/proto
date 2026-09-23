import type { Model } from "./types";

// Codex reports a 272K default and a stale 872K maximum for Astra; OpenAI documents 1.05M total context with at most
// 922K input, so the curated input ceiling is 922K. A higher live maximum still wins.
const CURATED_MAX_CONTEXT_WINDOWS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
	"openai-codex": {
		"gpt-6-astra": 922_000,
		"gpt-6-astra-wm": 922_000,
	},
};

// Every Codex SKU clamps explicit context-window overrides to the server-honored ceiling
// (codex-rs `with_config_overrides`: `min(override, max_context_window)`).
const CLAMP_CONTEXT_OVERRIDE_PROVIDERS: ReadonlySet<string> = new Set(["openai-codex"]);

/** Extended-context capacity: the larger of the live/declared maximum and the curated one. */
export function resolveMaxContextWindow(
	model: Pick<Model, "provider" | "id" | "maxContextWindow">,
): number | undefined {
	const curated = CURATED_MAX_CONTEXT_WINDOWS[model.provider]?.[model.id];
	const maximum = model.maxContextWindow;
	if (typeof maximum === "number" && Number.isFinite(maximum) && maximum > 0) {
		return Math.max(maximum, curated ?? 0);
	}
	return curated;
}

export function clampsContextOverride(model: Pick<Model, "provider">): boolean {
	return CLAMP_CONTEXT_OVERRIDE_PROVIDERS.has(model.provider);
}

/**
 * Clamps a requested window to the override ceiling. `model` is the pre-override row: the ceiling never shrinks the
 * request below the window that already works, and without a curated or live maximum the request passes through.
 */
export function clampContextOverride(
	model: Pick<Model, "provider" | "id" | "maxContextWindow" | "contextWindow">,
	requested: number,
): number {
	if (!Number.isFinite(requested) || requested <= 0) return requested;
	const ceiling = resolveMaxContextWindow(model);
	if (ceiling === undefined || requested <= ceiling) return requested;
	const current = model.contextWindow;
	const floor = typeof current === "number" && Number.isFinite(current) && current > 0 ? current : 0;
	return Math.min(requested, Math.max(ceiling, floor));
}
