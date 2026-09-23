import type { EffectiveTokenCost, LongContextTokenCost, PeakPricingWindow, TimeBasedCost, TokenCost } from "./types";
import { isRecord } from "./utils";

function nonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRates(value: unknown): value is TokenCost {
	return (
		isRecord(value) &&
		nonnegative(value.input) &&
		nonnegative(value.output) &&
		nonnegative(value.cacheRead) &&
		nonnegative(value.cacheWrite)
	);
}

function isLongContext(value: unknown): value is LongContextTokenCost {
	return (
		isRecord(value) &&
		isRates(value) &&
		typeof value.inputThreshold === "number" &&
		Number.isFinite(value.inputThreshold) &&
		value.inputThreshold > 0 &&
		(value.inputThresholdInclusive === undefined || typeof value.inputThresholdInclusive === "boolean")
	);
}

function isPeakWindow(value: unknown): value is PeakPricingWindow {
	return (
		isRecord(value) &&
		Array.isArray(value.weekdays) &&
		value.weekdays.length > 0 &&
		value.weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6) &&
		new Set(value.weekdays).size === value.weekdays.length &&
		typeof value.startMinute === "number" &&
		Number.isInteger(value.startMinute) &&
		typeof value.endMinute === "number" &&
		Number.isInteger(value.endMinute) &&
		value.startMinute >= 0 &&
		value.endMinute <= 1440 &&
		value.startMinute < value.endMinute
	);
}

function isEffectiveRate(value: unknown): value is EffectiveTokenCost {
	return (
		isRecord(value) &&
		isRates(value) &&
		typeof value.effectiveFrom === "number" &&
		Number.isSafeInteger(value.effectiveFrom) &&
		(value.longContext === undefined || isLongContext(value.longContext))
	);
}

/** Validate a serialized schedule before admitting cached model rows. */
export function isTimeBasedCost(value: unknown): value is TimeBasedCost {
	if (
		!isRecord(value) ||
		!nonnegative(value.offPeakMultiplier) ||
		!Array.isArray(value.peakWindows) ||
		!value.peakWindows.every(isPeakWindow)
	) {
		return false;
	}
	if (value.effectiveRates === undefined) return true;
	if (!Array.isArray(value.effectiveRates) || !value.effectiveRates.every(isEffectiveRate)) return false;
	return new Set(value.effectiveRates.map(rate => rate.effectiveFrom)).size === value.effectiveRates.length;
}
