import type { LineRange } from "./path-utils";
import { parseLineRanges } from "./path-utils";
import { ToolError } from "./tool-errors";

export type ParsedSelector =
	| { kind: "none" }
	| { kind: "raw" }
	| { kind: "conflicts" }
	| { kind: "lines"; ranges: [LineRange, ...LineRange[]]; raw?: boolean }
	| { kind: "tail"; count: number; ranges?: [LineRange, ...LineRange[]]; raw?: boolean };

export function isRawSelector(parsed: ParsedSelector): boolean {
	return parsed.kind === "raw" || ((parsed.kind === "lines" || parsed.kind === "tail") && parsed.raw === true);
}

export function isMultiRange(parsed: ParsedSelector): boolean {
	return (
		(parsed.kind === "lines" && parsed.ranges.length > 1) || (parsed.kind === "tail" && parsed.ranges !== undefined)
	);
}

function selectorChunkLooksReadLike(chunk: string): boolean {
	const lower = chunk.toLowerCase();
	return (
		lower === "raw" || lower === "conflicts" || /^-\d+(?:[-+]\d+)?$/.test(chunk) || parseLineRanges(chunk) !== null
	);
}

function invalidSelector(sel: string): ToolError {
	return new ToolError(
		`Invalid selector ':${sel}'. Use :N, :N-M, :N+K, :N- (open-ended), a comma-separated list of ranges, :raw, or a range combined with raw (e.g. :raw:50-100).`,
	);
}

export function resolveTailSelector(
	parsed: ParsedSelector,
	totalLines: number,
): Exclude<ParsedSelector, { kind: "tail" }> {
	if (parsed.kind !== "tail") return parsed;
	const start = Math.max(1, totalLines - parsed.count + 1);
	const chunks = [
		...(parsed.ranges ?? []).map(range => `${range.startLine}-${range.endLine ?? ""}`),
		`${start}-${Math.max(start, totalLines)}`,
	];
	return { kind: "lines", ranges: parseLineRanges(chunks.join(","))!, raw: parsed.raw };
}

function parseRangeOrTail(chunk: string, raw = false): ParsedSelector | null {
	const ranges = parseLineRanges(chunk);
	if (ranges) return { kind: "lines", ranges, raw };
	let count = 0;
	const listed: string[] = [];
	for (const part of chunk.split(",")) {
		if (/^-[1-9]\d*$/.test(part) && Number.isSafeInteger(Number(part.slice(1))))
			count = Math.max(count, Number(part.slice(1)));
		else listed.push(/^L?\d+$/i.test(part) ? `${part}-${part}` : part);
	}
	if (!count) return null;
	const listedRanges = listed.length ? parseLineRanges(listed.join(",")) : undefined;
	if (listedRanges === null) return null;
	return { kind: "tail", count, ranges: listedRanges, raw };
}

export function parseSel(sel: string | undefined): ParsedSelector {
	if (!sel || sel.length === 0) return { kind: "none" };

	if (sel.includes(":")) {
		const chunks = sel.split(":");
		if (chunks.length === 2) {
			const [a, b] = chunks as [string, string];
			const aIsRaw = a.toLowerCase() === "raw";
			const bIsRaw = b.toLowerCase() === "raw";
			const rangeChunk = aIsRaw ? b : bIsRaw ? a : null;
			const rawChunk = aIsRaw ? a : bIsRaw ? b : null;
			if (rangeChunk !== null && rawChunk !== null) {
				const parsed = parseRangeOrTail(rangeChunk, true);
				if (parsed) return parsed;
			}
		}
		if (chunks.every(selectorChunkLooksReadLike)) throw invalidSelector(sel);

		return { kind: "none" };
	}

	if (sel.toLowerCase() === "raw") return { kind: "raw" };
	if (sel.toLowerCase() === "conflicts") return { kind: "conflicts" };
	const parsed = parseRangeOrTail(sel);
	if (parsed) return parsed;

	return { kind: "none" };
}

export function selToOffsetLimit(parsed: ParsedSelector): { offset?: number; limit?: number } {
	if (parsed.kind === "lines") {
		const first = parsed.ranges[0];
		const limit = first.endLine !== undefined ? first.endLine - first.startLine + 1 : undefined;
		return { offset: first.startLine, limit };
	}
	return {};
}
