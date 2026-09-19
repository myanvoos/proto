import type {
	AnthropicServerToolContent,
	AssistantMessage,
	AudioContent,
	ImageContent,
	Message,
	TextContent,
	ToolCall,
	UserContent,
	VideoContent,
} from "@oh-my-pi/pi-ai";
import { type Dialect, getDialectDefinition } from "@oh-my-pi/pi-ai/dialect";
import { escapeHarmonyControlTokens } from "@oh-my-pi/pi-ai/utils/harmony-leak";
import { formatGroupedPaths, prompt, stringifyJson } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "../types";
import type { CoreCompactionMessage } from "./messages";
import fileOperationsTemplate from "./prompts/file-operations.md" with { type: "text" };
import selfSummarySectionTemplate from "./prompts/self-summary-section.md" with { type: "text" };
import summarizationSystemPrompt from "./prompts/summarization-system.md" with { type: "text" };

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

const RANGE_CHUNK_SRC = String.raw`L?\d+(?:(?:[-+]|\.\.)L?\d+|-|\.\.)?`;
const RANGE_LIST_SRC = `${RANGE_CHUNK_SRC}(?:,${RANGE_CHUNK_SRC})*`;
const READ_SELECTOR_RE = new RegExp(`^(?:${RANGE_LIST_SRC}|raw|conflicts)$`, "i");
const READ_RANGE_ONLY_RE = new RegExp(`^${RANGE_LIST_SRC}$`, "i");
const READ_RAW_ONLY_RE = /^raw$/i;

export function splitReadSelector(path: string): { path: string; sel?: string } {
	const colon = path.lastIndexOf(":");
	if (colon <= 0) return { path };
	const candidate = path.slice(colon + 1);
	if (!READ_SELECTOR_RE.test(candidate)) return { path };
	let base = path.slice(0, colon);
	let sel = candidate;

	const inner = base.lastIndexOf(":");
	if (inner > 0) {
		const innerCandidate = base.slice(inner + 1);
		const innerIsRaw = READ_RAW_ONLY_RE.test(innerCandidate);
		const outerIsRaw = READ_RAW_ONLY_RE.test(candidate);
		const innerIsRange = READ_RANGE_ONLY_RE.test(innerCandidate);
		const outerIsRange = READ_RANGE_ONLY_RE.test(candidate);
		if ((innerIsRaw && outerIsRange) || (innerIsRange && outerIsRaw)) {
			sel = `${innerCandidate}:${candidate}`;
			base = base.slice(0, inner);
		}
	}
	return { path: base, sel };
}

export function stripReadSelector(path: string): string {
	return splitReadSelector(path).path;
}

const URL_SCHEME_RE = /[a-z][a-z0-9+.-]*:\/\//i;

export function isUrlSchemePath(path: string): boolean {
	return URL_SCHEME_RE.test(path);
}

export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		if (isUrlSchemePath(path)) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(stripReadSelector(path));
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written].filter(f => !isUrlSchemePath(f)));
	const readOnly = [...fileOps.read].filter(f => !isUrlSchemePath(f) && !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

const FILE_OPERATION_SUMMARY_LIMIT = 20;

function stripFileOperationTags(summary: string): string {
	return summary
		.replace(/<files>[\s\S]*?<\/files>\s*/g, "")
		.replace(/<read-files>[\s\S]*?<\/read-files>\s*/g, "")
		.replace(/<modified-files>[\s\S]*?<\/modified-files>\s*/g, "")
		.trimEnd();
}
export function formatFileOperations(
	readFiles: string[],
	modifiedFiles: string[],
	readSet?: ReadonlySet<string>,
): string {
	if (readFiles.length === 0 && modifiedFiles.length === 0) return "";
	const mode = new Map<string, "Read" | "Write" | "RW">();
	for (const file of readFiles) mode.set(file, "Read");
	for (const file of modifiedFiles) mode.set(file, readSet?.has(file) ? "RW" : "Write");
	const all = [...mode.keys()].sort();
	let files = formatGroupedPaths(all.slice(0, FILE_OPERATION_SUMMARY_LIMIT), path => ` (${mode.get(path)})`);
	if (all.length > FILE_OPERATION_SUMMARY_LIMIT) {
		files += `\n[…${all.length - FILE_OPERATION_SUMMARY_LIMIT} files elided…]`;
	}
	return prompt.render(fileOperationsTemplate, { files });
}

export function upsertFileOperations(
	summary: string,
	readFiles: string[],
	modifiedFiles: string[],
	readSet?: ReadonlySet<string>,
): string {
	const baseSummary = stripFileOperationTags(summary);
	const fileOperations = formatFileOperations(readFiles, modifiedFiles, readSet);
	if (!fileOperations) return baseSummary;
	if (!baseSummary) return fileOperations;
	return `${baseSummary}\n\n${fileOperations}`;
}

const SELF_SUMMARY_TAG_RE = /<self-summary>[\s\S]*?<\/self-summary>\s*/g;

/**
 * The session model's own note is regenerated on every compaction, and the summary it is appended
 * to carries the previous round's note forward, so the old section is replaced rather than stacked.
 */
export function upsertSelfSummary(summary: string, note: string): string {
	const baseSummary = summary.replace(SELF_SUMMARY_TAG_RE, "").trimEnd();
	const trimmedNote = note.trim();
	if (!trimmedNote) return baseSummary;
	const section = prompt.render(selfSummarySectionTemplate, { note: trimmedNote });
	if (!baseSummary) return section;
	return `${baseSummary}\n\n${section}`;
}

export const TOOL_RESULT_MIN_CHARS = 2000;

export const TOOL_RESULT_MAX_CHARS = 24_000;

/**
 * Detail-heavy tool results carry their verdict at both ends: the head names what ran, the tail
 * carries the failure, the totals, the final diff. Dropping the tail is what silently loses the
 * facts a summary exists to preserve, so keep both ends and cut from the middle.
 */
export function truncateToolResultForSummary(text: string, maxChars: number = TOOL_RESULT_MIN_CHARS): string {
	const limit = Math.max(TOOL_RESULT_MIN_CHARS, Math.floor(maxChars));
	if (text.length <= limit) return text;
	const headLength = Math.ceil(limit / 2);
	const tailLength = limit - headLength;
	const truncatedChars = text.length - limit;
	return `${text.slice(0, headLength)}\n\n[... ${truncatedChars} characters truncated from middle ...]\n\n${text.slice(text.length - tailLength)}`;
}

const SUMMARY_BOUNDARY_TAG_RE = /<\s*\/?\s*(?:conversation|previous-summary)\s*>/gi;

export function escapeSummaryBoundaryTags(text: string): string {
	return text.replace(SUMMARY_BOUNDARY_TAG_RE, tag => `&lt;${tag.slice(1)}`);
}

export type SummaryMessage = Message | CoreCompactionMessage;

type AssistantContent = AssistantMessage["content"][number];

function assertNever(value: never): never {
	throw new Error(`Unhandled compaction summary value: ${stringifyJson(value) ?? String(value)}`);
}

function mediaPlaceholder(content: ImageContent | AudioContent | VideoContent): string {
	switch (content.type) {
		case "image":
			return `[Image: ${content.mimeType}]`;
		case "audio":
			return `[Audio: ${content.mimeType}]`;
		case "video":
			return `[Video: ${content.mimeType}]`;
		default:
			return assertNever(content);
	}
}

function userContentText(content: UserContent): string {
	switch (content.type) {
		case "text":
			return content.text;
		case "image":
		case "audio":
		case "video":
			return mediaPlaceholder(content);
		default:
			return assertNever(content);
	}
}

function anthropicServerToolText(content: AnthropicServerToolContent): string {
	const block = content.block;
	switch (block.type) {
		case "server_tool_use":
			return `[Anthropic server tool call: ${block.name}(${stringifyJson(block.input ?? {}) ?? "null"})]`;
		case "web_search_tool_result":
		case "tool_search_tool_result":
			return `[Anthropic server tool result for ${block.tool_use_id}: ${stringifyJson(block.content) ?? "null"}]`;
		default:
			return assertNever(block);
	}
}

function assistantContent(content: AssistantContent): TextContent | AssistantContent {
	switch (content.type) {
		case "text":
		case "thinking":
		case "toolCall":
			return content;
		case "image":
			return { type: "text", text: mediaPlaceholder(content) };
		case "redactedThinking":
			return { type: "text", text: "[Redacted thinking]" };
		case "fallback":
			return { type: "text", text: `[Model fallback: ${content.from.model} -> ${content.to.model}]` };
		case "anthropicServerTool":
			return { type: "text", text: anthropicServerToolText(content) };
		default:
			return assertNever(content);
	}
}

function contentText(content: string | UserContent[]): string {
	if (typeof content === "string") return content;
	return content.map(userContentText).join("");
}

export interface SummarySerializationOptions {
	toolResultMaxChars?: number;
}

function normalizeSummaryMessage(
	message: SummaryMessage,
	uselessCallIds: ReadonlySet<string>,
	toolResultMaxChars: number,
): Message | undefined {
	switch (message.role) {
		case "user":
		case "developer":
			return {
				...message,
				content: [{ type: "text", text: contentText(message.content) }],
			};
		case "assistant": {
			const content = message.content
				.filter(block => block.type !== "toolCall" || !uselessCallIds.has(block.id))
				.map(assistantContent);
			return content.length > 0 ? { ...message, content } : undefined;
		}
		case "toolResult": {
			if (uselessCallIds.has(message.toolCallId)) return undefined;
			return {
				...message,
				content: [
					{ type: "text", text: truncateToolResultForSummary(contentText(message.content), toolResultMaxChars) },
				],
			};
		}
		case "custom":
		case "hookMessage":
			return {
				role: "developer",
				content: [{ type: "text", text: `[${message.customType}]\n${contentText(message.content)}` }],
				attribution: message.attribution,
				timestamp: message.timestamp,
			};
		case "branchSummary":
			return {
				role: "user",
				content: [{ type: "text", text: `[Branch Summary]\n${message.summary}` }],
				attribution: "agent",
				timestamp: message.timestamp,
			};
		case "compactionSummary":
			return {
				role: "user",
				content: [{ type: "text", text: `[Compaction Summary]\n${message.summary}` }],
				attribution: "agent",
				providerPayload: message.providerPayload,
				timestamp: message.timestamp,
			};
		default:
			return assertNever(message);
	}
}

export function serializeConversationForSummary(
	messages: readonly SummaryMessage[],
	dialect?: Dialect,
	options?: SummarySerializationOptions,
): string {
	const conversation = serializeConversation(messages, dialect, options);
	const escaped = dialect === "harmony" ? escapeHarmonyControlTokens(conversation) : conversation;
	return escapeSummaryBoundaryTags(escaped);
}

export function serializeConversation(
	messages: readonly SummaryMessage[],
	dialect?: Dialect,
	options?: SummarySerializationOptions,
): string {
	const uselessCallIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.useless === true && message.isError !== true) {
			uselessCallIds.add(message.toolCallId);
		}
	}
	const toolResultMaxChars = options?.toolResultMaxChars ?? TOOL_RESULT_MIN_CHARS;
	const processed = messages
		.map(message => normalizeSummaryMessage(message, uselessCallIds, toolResultMaxChars))
		.filter((message): message is Message => message !== undefined);

	if (dialect) return getDialectDefinition(dialect).renderTranscript(processed);

	const parts: string[] = [];
	for (const message of processed) {
		switch (message.role) {
			case "user":
				parts.push(`[User]: ${contentText(message.content)}`);
				break;
			case "developer":
				parts.push(`[Developer]: ${contentText(message.content)}`);
				break;
			case "assistant": {
				const textParts: string[] = [];
				const thinkingParts: string[] = [];
				const toolCalls: ToolCall[] = [];
				for (const block of message.content) {
					switch (block.type) {
						case "text":
							textParts.push(block.text);
							break;
						case "thinking":
							thinkingParts.push(block.thinking);
							break;
						case "toolCall":
							toolCalls.push(block);
							break;
						case "image":
							textParts.push(mediaPlaceholder(block));
							break;
						case "redactedThinking":
							textParts.push("[Redacted thinking]");
							break;
						case "fallback":
							textParts.push(`[Model fallback: ${block.from.model} -> ${block.to.model}]`);
							break;
						case "anthropicServerTool":
							textParts.push(anthropicServerToolText(block));
							break;
						default:
							return assertNever(block);
					}
				}
				if (thinkingParts.length > 0) parts.push(`[Think]: ${thinkingParts.join("\n")}`);
				if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
				if (toolCalls.length > 0) parts.push(`[Tool Call]: ${renderToolCalls(toolCalls)}`);
				break;
			}
			case "toolResult":
				parts.push(`[Tool Result]: ${contentText(message.content)}`);
				break;
			default:
				return assertNever(message);
		}
	}
	return parts.join("\n\n");
}

function renderToolCalls(calls: ToolCall[]): string {
	return calls
		.map(call => {
			const argsStr = Object.entries(call.arguments as Record<string, unknown>)
				.map(([k, v]) => `${k}=${stringifyJson(v) ?? "null"}`)
				.join(", ");
			return `${call.name}(${argsStr})`;
		})
		.join("; ");
}

export const SUMMARIZATION_SYSTEM_PROMPT = prompt.render(summarizationSystemPrompt);
