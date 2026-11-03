export function dateToAgeSeconds(dateStr: string | null | undefined): number | undefined {
	if (!dateStr) return undefined;
	try {
		const date = new Date(dateStr);
		if (Number.isNaN(date.getTime())) return undefined;
		return Math.floor((Date.now() - date.getTime()) / 1000);
	} catch {
		return undefined;
	}
}

export function clampNumResults(value: number | undefined, defaultVal: number, maxVal: number): number {
	if (!value || Number.isNaN(value)) return defaultVal;
	return Math.min(maxVal, Math.max(1, value));
}

const RECENCY_DAYS = { day: 1, week: 7, month: 30, year: 365 };
/** UTC lower bound for search engines accepting absolute dates. */
export function recencyAfterDate(recency: "day" | "week" | "month" | "year"): string {
	return new Date(Date.now() - RECENCY_DAYS[recency] * 86_400_000).toISOString().slice(0, 10);
}
