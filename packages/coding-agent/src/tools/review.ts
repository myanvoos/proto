/**
 * Review-finding shapes and priority helpers.
 *
 * The `report_finding` tool was removed; reviewers now record findings through
 * incremental `yield` sections (`type: ["findings"]`). These parsers and priority helpers support reviewer findings.
 */
// ─────────────────────────────────────────────────────────────────────────────

import { isRecord } from "@oh-my-pi/pi-utils";

type FindingPriority = "P0" | "P1" | "P2" | "P3";

function isFindingPriority(value: unknown): value is FindingPriority {
	return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}
interface FindingDetails {
	title: string;
	body: string;
	priority: FindingPriority;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

function normalizeFindingPriority(value: unknown): FindingPriority | undefined {
	if (isFindingPriority(value)) return value;
	if (value === 0) return "P0";
	if (value === 1) return "P1";
	if (value === 2) return "P2";
	if (value === 3) return "P3";
	return undefined;
}

export function parseFindingDetails(value: unknown): FindingDetails | undefined {
	if (!isRecord(value)) return undefined;

	const title = typeof value.title === "string" ? value.title : undefined;
	const body = typeof value.body === "string" ? value.body : undefined;
	const priority = normalizeFindingPriority(value.priority);
	const confidence =
		typeof value.confidence === "number" &&
		Number.isFinite(value.confidence) &&
		value.confidence >= 0 &&
		value.confidence <= 1
			? value.confidence
			: undefined;
	const filePath = typeof value.file_path === "string" && value.file_path.length > 0 ? value.file_path : undefined;
	const lineStart =
		typeof value.line_start === "number" && Number.isFinite(value.line_start) ? value.line_start : undefined;
	const lineEnd = typeof value.line_end === "number" && Number.isFinite(value.line_end) ? value.line_end : undefined;

	if (
		title === undefined ||
		body === undefined ||
		priority === undefined ||
		confidence === undefined ||
		filePath === undefined ||
		lineStart === undefined ||
		lineEnd === undefined
	) {
		return undefined;
	}

	return {
		title,
		body,
		priority,
		confidence,
		file_path: filePath,
		line_start: lineStart,
		line_end: lineEnd,
	};
}

// Re-export the finding shape for the reviewer render path.
export type { FindingDetails };
