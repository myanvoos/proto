export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Reads an own string-valued property without invoking accessors. */
export function stringProperty(value: object, key: string): string | undefined {
	const field = Object.getOwnPropertyDescriptor(value, key)?.value;
	return typeof field === "string" ? field : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/**
 * The one owner of "turn an unknown thrown value into one readable line".
 *
 * An `Error` reports its message, falling back to its constructor name when the
 * message is empty: `throw new TypeError()` used to yield `""`, and a caller
 * splicing that into a sentence produced text that trailed off after the colon
 * and told the reader nothing. Anything else reports its string form, so a thrown
 * string, number, or object still says something.
 */
export function errorMessage(value: unknown): string {
	if (!(value instanceof Error)) return String(value);
	return value.message || value.name;
}
