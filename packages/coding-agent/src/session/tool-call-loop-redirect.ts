import type { RepeatedToolCallDetection } from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";
import { prompt } from "@oh-my-pi/pi-utils";
import toolCallLoopRedirectTemplate from "../prompts/system/tool-call-loop-redirect.md" with { type: "text" };

/**
 * Renders the corrective a repeated tool call earns. Shared by the primary session's stream guards and the advisor's
 * own loop guard so both bounds speak with one wording; each wraps it in the message shape its agent converts.
 */
export function renderToolCallLoopRedirect(detection: RepeatedToolCallDetection): string {
	return prompt.render(toolCallLoopRedirectTemplate, {
		tool_name: detection.toolName,
		count: detection.count,
		arguments_summary: detection.argumentsSummary,
		result_summary: detection.resultSummary || "(no text result)",
	});
}
