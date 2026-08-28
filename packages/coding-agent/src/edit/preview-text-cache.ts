import { errorMessage } from "@oh-my-pi/pi-utils";
import { readEditFileText } from "./read-file";

interface CachedText {
	mtimeMs: number;
	size: number;
	rawContent: string;
}

const MAX_ENTRIES = 8;
const cache = new Map<string, CachedText>();

async function readFresh(absolutePath: string, displayPath: string): Promise<string> {
	try {
		return await readEditFileText(absolutePath, displayPath);
	} catch (error) {
		const message = errorMessage(error);
		throw new Error(message || `Unable to read ${displayPath}`);
	}
}

export async function readPreviewText(
	absolutePath: string,
	displayPath: string,
	streaming: boolean | undefined,
): Promise<string> {
	if (!streaming) return readFresh(absolutePath, displayPath);

	let stamp: { mtimeMs: number; size: number } | undefined;
	try {
		const stat = await Bun.file(absolutePath).stat();
		stamp = { mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		stamp = undefined;
	}
	if (stamp) {
		const cached = cache.get(absolutePath);
		if (cached && cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size) return cached.rawContent;
	}
	const rawContent = await readFresh(absolutePath, displayPath);
	if (stamp) {
		if (cache.size >= MAX_ENTRIES && !cache.has(absolutePath)) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		cache.set(absolutePath, { mtimeMs: stamp.mtimeMs, size: stamp.size, rawContent });
	}
	return rawContent;
}

export function clearPreviewTextCache(): void {
	cache.clear();
}
