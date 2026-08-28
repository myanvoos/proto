import type { Theme } from "../modes/theme/theme";
import { replaceTabs } from "../tools/render-utils";

export function formatWorkerId(id: string): string {
	const segments = replaceTabs(id).split(".");
	return segments.length < 2 ? (segments[0] ?? "") : segments.join(">");
}

export function workerTypeBadge(agent: string | undefined, theme: Theme): string {
	const trimmed = agent?.trim();
	if (!trimmed || trimmed === "worker") return "";
	return ` ${theme.fg("dim", `${theme.format.bracketLeft}${replaceTabs(trimmed)}${theme.format.bracketRight}`)}`;
}
