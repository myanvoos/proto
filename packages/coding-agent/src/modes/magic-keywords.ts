import { containsUltrathink, highlightUltrathink } from "./ultrathink";
import { containsWorkflow, highlightWorkflow } from "./workflow";

export function highlightMagicKeywords(text: string, resetTo?: string, phase?: number): string {
	return highlightWorkflow(highlightUltrathink(text, resetTo, phase), resetTo, phase);
}

export function hasMagicKeyword(text: string): boolean {
	if (!text.includes("ultrathink") && !text.includes("workflowz")) return false;
	return containsUltrathink(text) || containsWorkflow(text);
}
