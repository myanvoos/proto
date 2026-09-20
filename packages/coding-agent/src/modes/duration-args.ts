/** Shared parsing for the compound duration tokens accepted by `/loop` and `/wait` (`10m`, `1h30m`, `2d`). */

const DURATION_UNITS_MS: Readonly<Record<string, number>> = {
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
};

export const DURATION_UNIT_LIST = "seconds, minutes, hours, or days";

export type DurationParseFailure = "unknown-unit" | "non-positive";

/** Milliseconds for a bare unit word (`m`, `hours`), or `undefined` when the word is not a unit. */
export function durationUnitMs(unit: string): number | undefined {
	const lower = unit.toLowerCase();
	return Object.hasOwn(DURATION_UNITS_MS, lower) ? DURATION_UNITS_MS[lower] : undefined;
}

/** Milliseconds for `<amount><unit>` repeated at least once, or `undefined` when the token has another shape. */
export function parseCompoundDurationMs(token: string): number | DurationParseFailure | undefined {
	const lower = token.toLowerCase();
	if (!/^(?:\d+[a-z]+)+$/.test(lower)) return undefined;
	const segments = lower.match(/\d+[a-z]+/g);
	if (!segments) return undefined;
	let totalMs = 0;
	for (const segment of segments) {
		const match = /^(\d+)([a-z]+)$/.exec(segment);
		if (!match) return undefined;
		const unitMs = durationUnitMs(match[2]);
		if (unitMs === undefined) return "unknown-unit";
		const amount = Number(match[1]);
		if (!Number.isSafeInteger(amount) || amount <= 0) return "non-positive";
		totalMs += amount * unitMs;
	}
	return totalMs > 0 ? totalMs : "non-positive";
}
