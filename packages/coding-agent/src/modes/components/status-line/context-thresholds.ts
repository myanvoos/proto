import { formatNumber } from "@oh-my-pi/pi-utils";
import type { ThemeColor } from "../../../modes/theme/theme";

export type ContextUsageLevel = "normal" | "warning" | "high" | "error";

const CONTEXT_WARNING_PERCENT_THRESHOLD = 50;
const CONTEXT_HIGH_PERCENT_THRESHOLD = 70;
const CONTEXT_ERROR_PERCENT_THRESHOLD = 90;

export function getContextUsageLevel(usedPercent: number | null | undefined): ContextUsageLevel {
	if (usedPercent === null || usedPercent === undefined || !Number.isFinite(usedPercent)) return "normal";
	if (usedPercent >= CONTEXT_ERROR_PERCENT_THRESHOLD) return "error";
	if (usedPercent >= CONTEXT_HIGH_PERCENT_THRESHOLD) return "high";
	if (usedPercent >= CONTEXT_WARNING_PERCENT_THRESHOLD) return "warning";
	return "normal";
}

export function formatContextUsage(usedTokens: number, limitTokens: number): string {
	const used = Number.isFinite(usedTokens) && usedTokens > 0 ? usedTokens : 0;
	if (!Number.isFinite(limitTokens) || limitTokens <= 0) return `${formatNumber(used)}/?`;
	return `${formatNumber(used)}/${formatNumber(limitTokens)}`;
}

export function formatContextRemainingPercent(usedPercent: number | null | undefined): string {
	if (usedPercent === null || usedPercent === undefined || !Number.isFinite(usedPercent)) return "? left";
	return `${Math.max(0, Math.min(100, Math.round(100 - usedPercent)))}% left`;
}

export function getContextUsageThemeColor(level: ContextUsageLevel): ThemeColor {
	switch (level) {
		case "error":
			return "error";
		case "high":
			return "thinkingHigh";
		case "warning":
			return "warning";
		case "normal":
			return "statusLineContext";
	}
}
