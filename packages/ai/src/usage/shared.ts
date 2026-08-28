import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import type { UsageStatus } from "../usage";

export const HOUR_MS = 60 * 60 * 1000;

export const DAY_MS = 24 * HOUR_MS;

export const WEEK_MS = 7 * DAY_MS;

export function parsePositiveTimestamp(value: unknown): number | undefined {
	const parsed = toNumber(value);
	if (parsed === undefined || parsed <= 0) return undefined;
	return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

export function parseIsoTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string" || !value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function usageStatus(usedFraction: number | undefined): UsageStatus {
	if (usedFraction === undefined) return "unknown";
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}
