import { type ResolvedThinkingLevel, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model, THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";

export { ThinkingLevel } from "@oh-my-pi/pi-agent-core";

export { CLI_THINKING_LEVELS } from "./cli/thinking-levels";

/**
 * Metadata used to render thinking selector values in the coding-agent UI.
 */
interface ThinkingLevelMetadata {
	value: ThinkingLevel;
	label: string;
	description: string;
}

const THINKING_LEVEL_METADATA: Record<ThinkingLevel, ThinkingLevelMetadata> = {
	[ThinkingLevel.Inherit]: {
		value: ThinkingLevel.Inherit,
		label: "inherit",
		description: "Inherit session default",
	},
	[ThinkingLevel.Off]: { value: ThinkingLevel.Off, label: "off", description: "No reasoning" },
	[ThinkingLevel.Minimal]: {
		value: ThinkingLevel.Minimal,
		label: "min",
		description: "Very brief reasoning (~1k tokens)",
	},
	[ThinkingLevel.Low]: { value: ThinkingLevel.Low, label: "low", description: "Light reasoning (~2k tokens)" },
	[ThinkingLevel.Medium]: {
		value: ThinkingLevel.Medium,
		label: "medium",
		description: "Moderate reasoning (~8k tokens)",
	},
	[ThinkingLevel.High]: { value: ThinkingLevel.High, label: "high", description: "Deep reasoning (~16k tokens)" },
	[ThinkingLevel.XHigh]: {
		value: ThinkingLevel.XHigh,
		label: "xhigh",
		description: "Extended reasoning (~32k tokens)",
	},
	[ThinkingLevel.Max]: {
		value: ThinkingLevel.Max,
		label: "max",
		description: "Maximum reasoning the model supports",
	},
};

const EFFORT_BY_SELECTOR: Readonly<Record<string, Effort>> = {
	[Effort.Minimal]: Effort.Minimal,
	[Effort.Low]: Effort.Low,
	[Effort.Medium]: Effort.Medium,
	[Effort.High]: Effort.High,
	[Effort.XHigh]: Effort.XHigh,
	[Effort.Max]: Effort.Max,
};
const THINKING_LEVEL_BY_SELECTOR: Readonly<Record<string, ThinkingLevel>> = {
	[ThinkingLevel.Inherit]: ThinkingLevel.Inherit,
	[ThinkingLevel.Off]: ThinkingLevel.Off,
	[ThinkingLevel.Minimal]: ThinkingLevel.Minimal,
	[ThinkingLevel.Low]: ThinkingLevel.Low,
	[ThinkingLevel.Medium]: ThinkingLevel.Medium,
	[ThinkingLevel.High]: ThinkingLevel.High,
	[ThinkingLevel.XHigh]: ThinkingLevel.XHigh,
	[ThinkingLevel.Max]: ThinkingLevel.Max,
};

function getOwnSelector<T>(selectors: Readonly<Record<string, T>>, value: string | null | undefined): T | undefined {
	if (value === undefined || value === null) return undefined;
	if (Object.hasOwn(selectors, value)) return selectors[value];
	// Accept unambiguous abbreviations (`xhi` → xhigh, `med` → medium) so every
	// selector surface (`--thinking`, `:suffix`, role values) parses alike.
	// Two-character minimum keeps single letters (`m`) from guessing.
	if (value.length < 2) return undefined;
	const matches = Object.keys(selectors).filter(selector => selector.startsWith(value));
	return matches.length === 1 ? selectors[matches[0]] : undefined;
}

/**
 * Parses a provider-facing effort value. Accepts unambiguous abbreviations.
 */
export function parseEffort(value: string | null | undefined): Effort | undefined {
	return getOwnSelector(EFFORT_BY_SELECTOR, value);
}

/**
 * Parses an agent-local thinking selector. Accepts unambiguous abbreviations.
 */
export function parseThinkingLevel(value: string | null | undefined): ThinkingLevel | undefined {
	return getOwnSelector(THINKING_LEVEL_BY_SELECTOR, value);
}

/**
 * Returns display metadata for a thinking selector.
 */
export function getThinkingLevelMetadata(level: ThinkingLevel): ThinkingLevelMetadata {
	return THINKING_LEVEL_METADATA[level];
}

/**
 * Converts an agent-local selector into the effort sent to providers.
 */
export function toReasoningEffort(level: ThinkingLevel | undefined): Effort | undefined {
	if (level === undefined || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) {
		return undefined;
	}
	return level;
}

/**
 * True when a selector explicitly requests provider-side reasoning disablement.
 */
export function shouldDisableReasoning(level: ThinkingLevel | undefined): boolean {
	return level === ThinkingLevel.Off;
}

/**
 * Resolves a selector against the current model while preserving explicit "off".
 */
export function resolveThinkingLevelForModel(
	model: Model | undefined,
	level: ThinkingLevel | undefined,
): ResolvedThinkingLevel | undefined {
	if (level === undefined || level === ThinkingLevel.Inherit) {
		return undefined;
	}
	if (level === ThinkingLevel.Off) {
		return ThinkingLevel.Off;
	}
	return clampThinkingLevelForModel(model, level);
}

/**
 * True when a prewalk hand-off from `current`/`currentLevel` to
 * `target`/`targetLevel` would change nothing observable: same model id and the
 * same model-clamped effective effort. Prewalk arms and switches only when this
 * is false.
 *
 * An effort-only delta on the same model id is a legitimate cheapening hand-off
 * — on a reasoning model the effort is the bulk of the cost — so it is NOT a
 * no-op and must still switch. A `targetLevel` of `undefined` means the prewalk
 * pattern carried no explicit `:level` suffix (no effort change requested),
 * which on the same model is a no-op.
 *
 * Efforts are compared AFTER model clamping, so a target the model cannot honor
 * (e.g. `:xhigh` on a model capped at `high`) — which `setThinkingLevel` would
 * clamp straight back to the active effort — is recognized as a no-op instead of
 * triggering an ephemeral reset and the plan/checklist nudges for nothing.
 */
export function prewalkWouldBeNoop(
	current: Model | undefined,
	currentLevel: ThinkingLevel | undefined,
	target: Model,
	targetLevel: ThinkingLevel | undefined,
): boolean {
	if (!modelsAreEqual(current, target)) return false;
	if (targetLevel === undefined) return true;
	return resolveThinkingLevelForModel(target, targetLevel) === resolveThinkingLevelForModel(target, currentLevel);
}

/**
 * Parses a `--thinking` CLI value. Accepts every {@link parseThinkingLevel}
 * selector (`off`, `minimal`..`max`) but rejects `inherit`: an explicit
 * `inherit` on the command line would suppress the settings/scoped-model
 * fallback during startup resolution only to resolve back to the provider
 * default, which is never what the user means.
 */
export function parseCliThinkingLevel(value: string | null | undefined): ThinkingLevel | undefined {
	const level = parseThinkingLevel(value);
	return level === ThinkingLevel.Inherit ? undefined : level;
}

/** Coarse per-spawn effort selectors accepted by orchestrate_spawn. */
export const WORKER_EFFORTS = ["lo", "med", "hi"] as const;

/** Coarse task-spawn effort: the lowest, middle, or highest thinking level the target model supports. */
export type WorkerEffort = (typeof WORKER_EFFORTS)[number];

/**
 * Maps a coarse task effort onto the model's supported thinking range:
 * `lo` = lowest supported level, `hi` = highest (whatever the model tops out
 * at — high, xhigh, or max), `med` = the middle (lower of the two middles for
 * an even-sized range). Without a model, maps over the full canonical range.
 * Returns `undefined` when the model has no controllable effort surface, so
 * callers fall back to their default selector (e.g. `auto`). Throws when the
 * configured ceiling is below the model's lowest supported effort.
 */
export function resolveWorkerEffortLevel(
	model: Model | undefined,
	effort: WorkerEffort,
	maxEffort?: Effort,
): Effort | undefined {
	const supported = model ? getSupportedEfforts(model) : THINKING_EFFORTS;
	if (supported.length === 0) return undefined;
	let resolved: Effort;
	switch (effort) {
		case "lo":
			resolved = supported[0];
			break;
		case "med":
			resolved = supported[(supported.length - 1) >> 1];
			break;
		case "hi":
			resolved = supported[supported.length - 1];
			break;
	}
	if (maxEffort === undefined) return resolved;
	const maxIndex = THINKING_EFFORTS.indexOf(maxEffort);
	const ceiling = supported.findLast(candidate => THINKING_EFFORTS.indexOf(candidate) <= maxIndex);
	if (ceiling === undefined) {
		const modelName = model ? `${model.provider}/${model.id}` : "Selected model";
		throw new RangeError(
			`${modelName} has no supported thinking effort at or below orchestrator.maxEffort=${maxEffort}`,
		);
	}
	return THINKING_EFFORTS.indexOf(resolved) > THINKING_EFFORTS.indexOf(ceiling) ? ceiling : resolved;
}

/**
 * Clamps a concrete thinking selector to a per-session effort ceiling (e.g. a
 * worker spawn's `orchestrator.maxEffort`-capped effort hint). `off`/`inherit`/
 * `undefined` pass through, as do levels already at or below the ceiling.
 * Levels above it snap to the highest model-supported effort at or below the
 * ceiling. A model whose floor exceeds the ceiling has nothing valid to snap
 * to; the requested level is returned unchanged and the caller is responsible
 * for rejecting or skipping such models (see {@link modelSupportsEffortCeiling}).
 */
export function clampThinkingLevelToCeiling(
	model: Model | undefined,
	level: Effort | undefined,
	ceiling: Effort | undefined,
): Effort | undefined;
export function clampThinkingLevelToCeiling(
	model: Model | undefined,
	level: ThinkingLevel | undefined,
	ceiling: Effort | undefined,
): ThinkingLevel | undefined;
export function clampThinkingLevelToCeiling(
	model: Model | undefined,
	level: ThinkingLevel | undefined,
	ceiling: Effort | undefined,
): ThinkingLevel | undefined {
	if (ceiling === undefined || level === undefined || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) {
		return level;
	}
	const maxIndex = THINKING_EFFORTS.indexOf(ceiling);
	if (THINKING_EFFORTS.indexOf(level) <= maxIndex) return level;
	const supported = model ? getSupportedEfforts(model) : THINKING_EFFORTS;
	return supported.findLast(candidate => THINKING_EFFORTS.indexOf(candidate) <= maxIndex) ?? level;
}

/**
 * True when `model` can honor a thinking-effort ceiling: it either has no
 * controllable effort surface (nothing to cap) or supports at least one effort
 * at or below the ceiling. Retry-fallback candidate filtering uses this to
 * skip models whose floor would force the session above the ceiling.
 */
export function modelSupportsEffortCeiling(model: Model, ceiling: Effort): boolean {
	const supported = getSupportedEfforts(model);
	if (supported.length === 0) return true;
	const maxIndex = THINKING_EFFORTS.indexOf(ceiling);
	return supported.some(candidate => THINKING_EFFORTS.indexOf(candidate) <= maxIndex);
}
