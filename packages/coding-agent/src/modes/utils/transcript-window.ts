export const TRANSCRIPT_WINDOW_MESSAGES = 256;
export const TRANSCRIPT_WINDOW_BYTES = 2 * 1024 * 1024;

/** Conservative retained string storage plus object overhead; stops once over budget. */
export function estimateTranscriptBytes(value: unknown, limit: number): number {
	const stack: unknown[] = [value];
	const seen = new WeakSet<object>();
	let bytes = 0;
	while (stack.length > 0 && bytes <= limit) {
		const item = stack.pop();
		if (typeof item === "string") bytes += item.length * 2;
		else if (item && typeof item === "object") {
			if (seen.has(item)) continue;
			seen.add(item);
			bytes += 32;
			if (Array.isArray(item)) {
				bytes += item.length * 8;
				if (bytes > limit) break;
				for (const child of item) stack.push(child);
			} else {
				for (const key in item) {
					if (!Object.hasOwn(item, key)) continue;
					bytes += key.length * 2 + 8;
					if (bytes > limit) break;
					stack.push((item as Record<string, unknown>)[key]);
				}
			}
		} else bytes += 8;
	}
	return bytes;
}
