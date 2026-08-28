export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isJsonObjectEmpty(value: JsonObject): boolean {
	return Object.keys(value).length === 0;
}
