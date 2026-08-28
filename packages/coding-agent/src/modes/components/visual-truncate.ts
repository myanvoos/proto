import { Text } from "@oh-my-pi/pi-tui";

interface VisualTruncateResult {
	visualLines: readonly string[];

	skippedCount: number;
}

const textCache = new Map<number, Text>();

function getCachedText(paddingX: number): Text {
	let text = textCache.get(paddingX);
	if (!text) {
		text = new Text("", paddingX, 0);
		textCache.set(paddingX, text);
	}
	return text;
}

export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX: number = 0,
): VisualTruncateResult {
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}

	const tempText = getCachedText(paddingX);
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
