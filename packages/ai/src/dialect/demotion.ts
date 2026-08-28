import { preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import { getDialectDefinition } from "./factory";

export function renderDemotedThinking(modelId: string, text: string): string {
	if (!text) return "";
	text = text.toWellFormed();
	const dialect = preferredDialect(modelId);
	if (dialect === "anthropic") return text;
	if (dialect === "harmony" || dialect === "gemma") return `<think>\n${text}\n</think>`;
	return getDialectDefinition(dialect).renderThinking(text);
}
