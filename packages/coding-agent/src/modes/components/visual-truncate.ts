import { Text } from "@oh-my-pi/pi-tui/components/text";
import { sanitizeText } from "@oh-my-pi/pi-utils";

interface VisualTruncateResult {
	visualLines: readonly string[];

	skippedCount: number;
}

const textCache = new Map<string, Text>();
const TEXT_CACHE_MAX = 8;

// Keyed by (padding, width, text): one slot per padding thrashed Text's render cache with 2+ live cards.
function getCachedText(text: string, width: number, paddingX: number): Text {
	const key = `${paddingX} ${width} ${text.length} ${Bun.hash(text).toString(36)}`;
	let cached = textCache.get(key);
	if (!cached) {
		cached = new Text("", paddingX, 0);
		if (textCache.size >= TEXT_CACHE_MAX) textCache.clear();
		textCache.set(key, cached);
	}
	return cached;
}

export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX: number = 0,
): VisualTruncateResult {
	maxVisualLines = Math.max(0, Math.trunc(maxVisualLines));
	text = sanitizeText(text);
	if (!text || maxVisualLines === 0) {
		return { visualLines: [], skippedCount: 0 };
	}

	const tempText = getCachedText(text, width, paddingX);
	if (tempText.getText() !== text) {
		tempText.setText(text);
	}
	const allVisualLines = tempText.render(width);

	if (allVisualLines.length <= maxVisualLines) {
		return { visualLines: allVisualLines, skippedCount: 0 };
	}

	const truncatedLines = allVisualLines.slice(-maxVisualLines);
	const skippedCount = allVisualLines.length - maxVisualLines;

	return { visualLines: truncatedLines, skippedCount };
}
