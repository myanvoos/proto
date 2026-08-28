import { prompt } from "@oh-my-pi/pi-utils";
import workflowNoticeTemplate from "../prompts/system/workflow-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

const WORKFLOW_WORD = magicKeywordRegex("workflowz");

export const WORKFLOW_NOTICE: string = renderWorkflowNotice();

export function renderWorkflowNotice(options?: { scoutAvailable?: boolean }): string {
	return prompt.render(workflowNoticeTemplate, { scoutAvailable: options?.scoutAvailable ?? true }).trim();
}

export function containsWorkflow(text: string): boolean {
	return keywordInProse(text, WORKFLOW_WORD);
}

export const highlightWorkflow: KeywordHighlighter = createGradientHighlighter({
	probe: /workflowz/,
	highlight: magicKeywordRegex("workflowz", "g"),
	stops: 14,
	hue: t => 30 + t * 120,
});
