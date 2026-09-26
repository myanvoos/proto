/** UTF-8 payload ceilings; count bounds also cover per-entry overhead. */
export const EDITOR_LIMITS = {
	draftBytes: 4 * 1024 * 1024,
	historyBytes: 8 * 1024 * 1024,
	undoBytes: 16 * 1024 * 1024,
	attachmentBytes: 16 * 1024 * 1024,
	attachmentCount: 256,
	expandedBytes: 16 * 1024 * 1024,
} as const;
