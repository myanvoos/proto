import { DURATION_UNIT_LIST, durationUnitMs, parseCompoundDurationMs } from "./duration-args";

type LoopLimitConfig =
	| {
			kind: "iterations";
			iterations: number;
	  }
	| {
			kind: "duration";
			durationMs: number;
	  };

export type LoopLimitRuntime =
	| {
			kind: "iterations";
			initial: number;
			remaining: number;
	  }
	| {
			kind: "duration";
			durationMs: number;
			deadlineMs: number;
	  };

const LOOP_USAGE = "Usage: /loop [count|duration]. Examples: /loop 10, /loop 10m, /loop 10min.";

interface ParsedLoopArgs {
	limit?: LoopLimitConfig;

	prompt?: string;
}

export function parseLoopLimitArgs(args: string): ParsedLoopArgs | string {
	const trimmed = args.trim();
	if (!trimmed) return {};

	const firstSpace = trimmed.search(/\s/);
	const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
	const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
	const token = firstToken.toLowerCase();

	if (!/^[+-]?\d/.test(token)) {
		return { prompt: trimmed };
	}

	if (/^\d+$/.test(token)) {
		if (rest) {
			const restTokens = rest.split(/\s+/);
			const unitMs = durationUnitMs(restTokens[0]);
			if (unitMs !== undefined) {
				const limit = makeDuration(token, unitMs);
				if (typeof limit === "string") return limit;
				return { limit, prompt: restTokens.slice(1).join(" ").trim() || undefined };
			}
		}
		const limit = makeIterations(token);
		if (typeof limit === "string") return limit;
		return { limit, prompt: rest || undefined };
	}

	const duration = parseCompoundDuration(token);
	if (duration !== undefined) {
		if (typeof duration === "string") return duration;
		return { limit: duration, prompt: rest || undefined };
	}

	return LOOP_USAGE;
}

function makeIterations(amountText: string): LoopLimitConfig | string {
	const amount = Number(amountText);
	if (!Number.isSafeInteger(amount) || amount <= 0) {
		return "Loop count must be a positive integer.";
	}
	return { kind: "iterations", iterations: amount };
}

function makeDuration(amountText: string, unitMs: number): LoopLimitConfig | string {
	const amount = Number(amountText);
	if (!Number.isSafeInteger(amount) || amount <= 0) {
		return "Loop duration must be positive.";
	}
	return { kind: "duration", durationMs: amount * unitMs };
}

function parseCompoundDuration(token: string): LoopLimitConfig | string | undefined {
	const parsed = parseCompoundDurationMs(token);
	if (parsed === undefined) return undefined;
	if (parsed === "unknown-unit") return `Loop duration unit must be ${DURATION_UNIT_LIST}.`;
	if (parsed === "non-positive") return "Loop duration must be positive.";
	return { kind: "duration", durationMs: parsed };
}

export function createLoopLimitRuntime(
	config: LoopLimitConfig | undefined,
	nowMs = Date.now(),
): LoopLimitRuntime | undefined {
	if (!config) return undefined;
	if (config.kind === "iterations") {
		return { kind: "iterations", initial: config.iterations, remaining: config.iterations };
	}
	return { kind: "duration", durationMs: config.durationMs, deadlineMs: nowMs + config.durationMs };
}

export function consumeLoopLimitIteration(limit: LoopLimitRuntime | undefined, nowMs = Date.now()): boolean {
	if (!limit) return true;
	if (limit.kind === "duration") {
		return nowMs < limit.deadlineMs;
	}
	if (limit.remaining <= 0) return false;
	limit.remaining -= 1;
	return true;
}

export function isLoopDurationExpired(limit: LoopLimitRuntime | undefined, nowMs = Date.now()): boolean {
	return limit?.kind === "duration" && nowMs >= limit.deadlineMs;
}

export function describeLoopLimit(config: LoopLimitConfig): string {
	if (config.kind === "iterations") {
		return `${config.iterations} ${config.iterations === 1 ? "iteration" : "iterations"}`;
	}
	return formatDuration(config.durationMs);
}

export function describeLoopLimitRuntime(limit: LoopLimitRuntime): string {
	if (limit.kind === "iterations") {
		return `${limit.remaining} of ${limit.initial} ${limit.initial === 1 ? "iteration" : "iterations"} remaining`;
	}
	return `${formatDuration(limit.durationMs)} limit`;
}

function formatDuration(durationMs: number): string {
	if (durationMs % 3_600_000 === 0) {
		const hours = durationMs / 3_600_000;
		return `${hours} ${hours === 1 ? "hour" : "hours"}`;
	}
	if (durationMs % 60_000 === 0) {
		const minutes = durationMs / 60_000;
		return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
	}
	const seconds = durationMs / 1_000;
	return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}
