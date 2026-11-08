export function tryParseJson<T = unknown>(content: string): T | null {
	try {
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

/**
 * Index just past the JSON object or array that opens at `text[start]`, or -1
 * when it does not close within `text`. String literals are skipped, honoring
 * escapes, so brackets inside values do not count. Malformed input yields some
 * end that a parser then rejects.
 */
export function jsonContainerEnd(text: string, start: number): number {
	let depth = 0;
	for (let index = start; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 0x22) {
			for (index++; index < text.length; index++) {
				const inner = text.charCodeAt(index);
				if (inner === 0x5c) index++;
				else if (inner === 0x22) break;
			}
		} else if (code === 0x7b || code === 0x5b) {
			depth++;
		} else if ((code === 0x7d || code === 0x5d) && --depth === 0) {
			return index + 1;
		}
	}
	return -1;
}

export function stringifyJson(value: unknown, space?: string | number): string | undefined {
	try {
		return JSON.stringify(value, null, space);
	} catch {
		return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), space);
	}
}
