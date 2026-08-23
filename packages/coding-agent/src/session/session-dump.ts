import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model, ToolExample } from "@oh-my-pi/pi-ai";

export interface SessionDumpOptions {
	messages: AgentMessage[];
	systemPrompt?: string[];
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	tools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
}

/** Format a portable, human-readable snapshot of a coding-agent conversation. */
export function formatSessionDumpText(options: SessionDumpOptions): string {
	const metadata = {
		model: options.model
			? { provider: options.model.provider, id: options.model.id, api: options.model.api }
			: undefined,
		thinkingLevel: options.thinkingLevel,
		systemPrompt: options.systemPrompt,
		tools: options.tools,
	};
	return [
		"# Session Dump",
		"",
		"## Metadata",
		"",
		"```json",
		JSON.stringify(metadata, null, 2),
		"```",
		"",
		"## Messages",
		"",
		"```json",
		JSON.stringify(options.messages, null, 2),
		"```",
	].join("\n");
}
