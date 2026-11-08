export function tryParseJson<T = unknown>(content: string): T | null {
	try {
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

export function stringifyJson(value: unknown, space?: string | number): string | undefined {
	try {
		return JSON.stringify(value, null, space);
	} catch {
		return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), space);
	}
}
