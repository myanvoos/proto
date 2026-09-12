import { type ResolvedThinkingLevel, ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type { Model } from "@oh-my-pi/pi-ai";
import { Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";

export { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";

export { CLI_THINKING_LEVELS } from "./cli/thinking-levels";

export * from "./thinking-level-metadata";

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

	if (value.length < 2) return undefined;
	const matches = Object.keys(selectors).filter(selector => selector.startsWith(value));
	return matches.length === 1 ? selectors[matches[0]] : undefined;
}

export function parseEffort(value: string | null | undefined): Effort | undefined {
	return getOwnSelector(EFFORT_BY_SELECTOR, value);
}

export function parseThinkingLevel(value: string | null | undefined): ThinkingLevel | undefined {
	return getOwnSelector(THINKING_LEVEL_BY_SELECTOR, value);
}

export function toReasoningEffort(level: ThinkingLevel | undefined): Effort | undefined {
	if (level === undefined || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) {
		return undefined;
	}
	return level;
}

export function shouldDisableReasoning(level: ThinkingLevel | undefined): boolean {
	return level === ThinkingLevel.Off;
}

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

export function parseCliThinkingLevel(value: string | null | undefined): ThinkingLevel | undefined {
	const level = parseThinkingLevel(value);
	return level === ThinkingLevel.Inherit ? undefined : level;
}

export const WORKER_EFFORTS = ["lo", "med", "hi"] as const;

export type WorkerEffort = (typeof WORKER_EFFORTS)[number];

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

export function modelSupportsEffortCeiling(model: Model, ceiling: Effort): boolean {
	const supported = getSupportedEfforts(model);
	if (supported.length === 0) return true;
	const maxIndex = THINKING_EFFORTS.indexOf(ceiling);
	return supported.some(candidate => THINKING_EFFORTS.indexOf(candidate) <= maxIndex);
}
