import type { EvalDisplayOutput } from "./types";

const MAX_DISPLAY_TEXT_BYTES = 8000;

function formatDisplayJsonForText(value: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		text = String(value);
	}
	if (text.length > MAX_DISPLAY_TEXT_BYTES) {
		text = `${text.slice(0, MAX_DISPLAY_TEXT_BYTES)}\n[…${text.length - MAX_DISPLAY_TEXT_BYTES}ch elided…]`;
	}
	return text;
}

/**
 * Text rendering of one sideband display for the tool response, or undefined when
 * the output has no text form. `jsonIndex` numbers JSON displays within a cell.
 */
export function formatDisplayOutputForText(output: EvalDisplayOutput, jsonIndex: number): string | undefined {
	if (output.type === "notice" || output.type === "text" || output.type === "markdown") return output.text;
	if (output.type !== "json") return undefined;
	return `display[${jsonIndex}]:\n${formatDisplayJsonForText(output.data)}`;
}
