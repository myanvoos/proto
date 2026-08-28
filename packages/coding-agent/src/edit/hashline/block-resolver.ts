import type { BlockResolver } from "@oh-my-pi/hashline";
import { blockRangeAt } from "@oh-my-pi/pi-natives";

const resolutionCache = new Map<string, { start: number; end: number } | null>();
const RESOLUTION_CACHE_MAX = 512;

export const nativeBlockResolver: BlockResolver = ({ path, text, line }) => {
	const key = `${Bun.hash(text).toString(36)}:${text.length}:${line}:${path}`;
	const cached = resolutionCache.get(key);
	if (cached !== undefined) return cached;
	const range = blockRangeAt({ code: text, path, line });
	const result = range ? { start: range.startLine, end: range.endLine } : null;
	if (resolutionCache.size >= RESOLUTION_CACHE_MAX) {
		const oldest = resolutionCache.keys().next().value;
		if (oldest !== undefined) resolutionCache.delete(oldest);
	}
	resolutionCache.set(key, result);
	return result;
};
