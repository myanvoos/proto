export const INTENT_FIELD = "i";

/** Trim an intent and drop trailing periods so "Reading config." and "Reading config" display alike; empty → undefined. */
export function normalizeIntent(intent: string): string | undefined {
	const normalized = intent
		.trim()
		.replace(/\s*\.+$/, "")
		.trim();
	return normalized.length > 0 ? normalized : undefined;
}
