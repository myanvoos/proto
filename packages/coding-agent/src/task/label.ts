import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import workerLabelSystemPrompt from "../prompts/system/worker-label.md" with { type: "text" };
import { generateSessionTitle } from "../utils/title-generator";

const WORKER_LABEL_SYSTEM_PROMPT = prompt.render(workerLabelSystemPrompt);

export function labelEchoesHandle(handle: string | undefined, label: string): boolean {
	if (!handle) return false;
	if (label.localeCompare(handle, undefined, { sensitivity: "accent" }) === 0) return true;
	const separator = handle.lastIndexOf("-");
	if (separator <= 0) return false;
	const prefix = handle.slice(0, separator);
	const suffix = handle.slice(separator + 1);
	return /^\d+$/.test(suffix) && prefix.localeCompare(label, undefined, { sensitivity: "accent" }) === 0;
}

export async function generateTaskLabel(
	assignment: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const text = assignment.trim();
	if (!text) return null;
	try {
		const label = await generateSessionTitle(
			text,
			registry,
			settings,
			sessionId,
			undefined,
			undefined,
			WORKER_LABEL_SYSTEM_PROMPT,
			signal,
		);
		if (!label || labelEchoesHandle(sessionId, label)) return null;
		return label;
	} catch (err) {
		logger.debug("worker-label: generation failed", {
			sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}
