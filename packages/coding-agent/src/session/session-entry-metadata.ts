import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { materializeString } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "./session-entries";
import { SUBAGENT_USAGE_CUSTOM_TYPE } from "./session-entries";

const PREVIEW_CHARACTERS = 256;

function previewText(text: string): string {
	return text.length <= PREVIEW_CHARACTERS
		? materializeString(text)
		: `${materializeString(text.slice(0, PREVIEW_CHARACTERS))}…`;
}

function contentPreview(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return previewText(message.content);
	let text = "";
	for (const block of message.content) {
		if (block.type !== "text") continue;
		text += previewText(block.text).slice(0, Math.max(0, PREVIEW_CHARACTERS - text.length));
		if (text.length >= PREVIEW_CHARACTERS) break;
	}
	return materializeString(text);
}

/** Structural index and bounded human preview, never a lifetime copy of the entry payload. */
function messageMetadata(message: AgentMessage): AgentMessage {
	switch (message.role) {
		case "assistant":
			return {
				role: message.role,
				api: message.api,
				provider: message.provider,
				model: message.model,
				responseId: message.responseId,
				usage: structuredClone(message.usage),
				stopReason: message.stopReason,
				timestamp: message.timestamp,
				contextSnapshot: message.contextSnapshot ? structuredClone(message.contextSnapshot) : undefined,
				retryRecovery: message.retryRecovery,
				content: [
					...(contentPreview(message) ? [{ type: "text" as const, text: contentPreview(message) }] : []),
					...message.content.flatMap(block =>
						block.type === "toolCall"
							? [{ type: "toolCall" as const, id: block.id, name: block.name, arguments: {} }]
							: [],
					),
				],
			};
		case "user":
		case "developer":
			return {
				role: message.role,
				content: contentPreview(message),
				timestamp: message.timestamp,
				attribution: message.attribution,
			};
		case "toolResult":
			return {
				role: message.role,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				isError: message.isError,
				content: [{ type: "text", text: contentPreview(message) }],
				timestamp: message.timestamp,
			};
		case "custom":
		case "hookMessage":
			return {
				role: message.role,
				customType: message.customType,
				content: contentPreview(message),
				display: message.display,
				attribution: message.attribution,
				timestamp: message.timestamp,
			};
		case "bashExecution":
			return {
				role: message.role,
				command: "",
				output: "",
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				truncated: message.truncated,
				timestamp: message.timestamp,
				excludeFromContext: message.excludeFromContext,
			};
		case "pythonExecution":
			return {
				role: message.role,
				code: "",
				output: "",
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				truncated: message.truncated,
				timestamp: message.timestamp,
				excludeFromContext: message.excludeFromContext,
			};
		case "fileMention":
			return { role: message.role, files: [], timestamp: message.timestamp };
		case "branchSummary":
			return {
				role: message.role,
				fromId: message.fromId,
				summary: previewText(message.summary),
				timestamp: message.timestamp,
			};
		case "compactionSummary":
			return { role: message.role, summary: "", tokensBefore: message.tokensBefore, timestamp: message.timestamp };
	}
}

export function sessionEntryMetadata(entry: SessionEntry): SessionEntry {
	const base = { id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp };
	switch (entry.type) {
		case "message":
			return { ...base, type: entry.type, message: messageMetadata(entry.message) };
		case "custom_message":
			return {
				...base,
				type: entry.type,
				customType: entry.customType,
				content: "",
				display: entry.display,
				attribution: entry.attribution,
			};
		case "compaction":
			return {
				...base,
				type: entry.type,
				summary: previewText(entry.summary),
				shortSummary: entry.shortSummary ? previewText(entry.shortSummary) : undefined,
				firstKeptEntryId: entry.firstKeptEntryId,
				tokensBefore: entry.tokensBefore,
				tokensAfter: entry.tokensAfter,
				method: entry.method,
				providerReplayThroughEntryId: entry.providerReplayThroughEntryId,
				fromExtension: entry.fromExtension,
			};
		case "branch_summary":
			return {
				...base,
				type: entry.type,
				fromId: entry.fromId,
				summary: previewText(entry.summary),
				fromExtension: entry.fromExtension,
			};
		case "custom":
			return {
				...base,
				type: entry.type,
				customType: entry.customType,
				data: entry.customType === SUBAGENT_USAGE_CUSTOM_TYPE ? structuredClone(entry.data) : undefined,
			};
		case "session_init":
			return {
				...base,
				type: entry.type,
				systemPrompt: "",
				task: "",
				tools: [],
				agent: entry.agent,
				modelRole: entry.modelRole,
				modelOverride: entry.modelOverride,
				resolvedModel: entry.resolvedModel,
				readOnly: entry.readOnly,
			};
		case "mode_change":
			return { ...base, type: entry.type, mode: entry.mode };
		default:
			return structuredClone(entry);
	}
}
