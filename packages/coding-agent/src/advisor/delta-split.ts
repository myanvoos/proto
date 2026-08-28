import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";

export interface AdvisorObfuscator {
	obfuscate(text: string, sharedRegexSecretValues?: ReadonlySet<string>): string;
}

export const ADVISOR_RENDER_OPTIONS = {
	includeToolIntent: true,
	watchedRoles: true,
	expandPrimaryContext: true,
	expandEditDiffs: true,
} as const;

interface RenderAdvisorDeltaChunksOptions {
	wip: boolean;
	includeThinking: boolean;
	obfuscator?: AdvisorObfuscator;
	advisorRegexSecretValues: ReadonlySet<string>;
}

export function renderAdvisorDeltaChunks(
	delta: AgentMessage[],
	opts: RenderAdvisorDeltaChunksOptions,
): AgentMessage[] | null {
	if (delta.length === 0) return null;

	const resultsByCallId = new Map<string, ToolResultMessage>();
	for (const msg of delta) {
		if (msg.role === "toolResult") resultsByCallId.set(msg.toolCallId, msg);
	}
	const consumed = new Set<string>();
	const watchedRoleState = { lastLabel: undefined as string | undefined };

	const renderChunk = (chunk: AgentMessage[]): string =>
		formatSessionHistoryMarkdown(chunk, {
			...ADVISOR_RENDER_OPTIONS,
			includeThinking: opts.includeThinking,
			toolResultIndex: resultsByCallId,
			consumedToolCallIds: consumed,
			watchedRoleState,
		});

	const heading = "### Session update";

	const chunks: { role: "user"; content: TextContent[]; timestamp: number }[] = [];
	for (let i = 0; i < delta.length; i++) {
		const text = renderChunk([delta[i]]);
		if (!text.trim()) continue;
		chunks.push({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	}
	if (chunks.length === 0) return null;
	if (opts.obfuscator) {
		const fullText = chunks.map(chunk => chunk.content[0].text).join("\n");
		const individuallyObfuscated = chunks.map(chunk =>
			opts.obfuscator!.obfuscate(chunk.content[0].text, opts.advisorRegexSecretValues),
		);
		if (opts.obfuscator.obfuscate(fullText, opts.advisorRegexSecretValues) !== individuallyObfuscated.join("\n")) {
			return null;
		}
		for (let i = 0; i < chunks.length; i++) chunks[i].content[0].text = individuallyObfuscated[i];
	}
	chunks[0].content[0].text = `${heading}\n\n${chunks[0].content[0].text}`;
	if (chunks.length === 0) return null;
	if (opts.wip) {
		const last = chunks[chunks.length - 1];
		last.content[0].text += `\n\n---\n\n[in progress — more steps follow]`;
	}
	return chunks as AgentMessage[];
}
