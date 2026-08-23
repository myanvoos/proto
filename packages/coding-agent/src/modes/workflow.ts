import { prompt } from "@oh-my-pi/pi-utils";
import workflowNoticeTemplate from "../prompts/system/workflow-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/**
 * "workflowz" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a warm
 * amber→green gradient ({@link highlightWorkflow}); submitting a message that
 * mentions it appends a hidden workflow notice that steers the model to author
 * a deterministic multi-worker workflow through the shared subagent backend.
 * Matching is prose-delimited and case-sensitive (lowercase only) —
 * "workflowz" triggers, but "workflowzed", "Workflowz", and "workflowz.ts"
 * never do.
 */

// Detection: lowercase keyword flanked by prose punctuation, whitespace, or a string edge.
const WORKFLOW_WORD = magicKeywordRegex("workflowz");

/** Default hidden workflow notice. */
export const WORKFLOW_NOTICE: string = renderWorkflowNotice();

/** Render the workflow notice. */
export function renderWorkflowNotice(options?: { scoutAvailable?: boolean }): string {
	return prompt.render(workflowNoticeTemplate, { scoutAvailable: options?.scoutAvailable ?? true }).trim();
}

/**
 * Whether `text` contains the standalone keyword "workflowz"
 * (lowercase, prose-delimited) in prose — never inside a code block, inline
 * code span, or XML/HTML section.
 */
export function containsWorkflow(text: string): boolean {
	return keywordInProse(text, WORKFLOW_WORD);
}

/**
 * Highlight every standalone "workflowz" in `text` for editor display
 * with a warm amber→green gradient (hue 30..150), visually distinct from
 * ultrathink's rainbow and orchestrate's teal→violet.
 */
export const highlightWorkflow: KeywordHighlighter = createGradientHighlighter({
	probe: /workflowz/,
	highlight: magicKeywordRegex("workflowz", "g"),
	stops: 14,
	hue: t => 30 + t * 120,
});
