const UNIFIED_HUNK_HEADER_REGEX = /^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@(?:\s*(.*))?$/;

export interface UnifiedHunkHeader {
	oldStart: number;

	oldLines: number;

	newStart: number;

	newLines: number;

	changeContext?: string;
}

export function parseUnifiedHunkHeader(line: string): UnifiedHunkHeader | undefined {
	const match = line.match(UNIFIED_HUNK_HEADER_REGEX);
	if (!match) return undefined;

	const changeContext = match[5]?.trim();
	return {
		oldStart: Number(match[1]),
		oldLines: match[2] ? Number(match[2]) : 1,
		newStart: Number(match[3]),
		newLines: match[4] ? Number(match[4]) : 1,
		changeContext: changeContext && changeContext.length > 0 ? changeContext : undefined,
	};
}
