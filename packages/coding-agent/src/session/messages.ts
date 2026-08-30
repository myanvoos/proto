import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	invalidateMessageCache,
	registerMessageCacheInvalidator,
} from "@oh-my-pi/pi-agent-core/compaction/message-cache";
import {
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	convertMessageToLlm,
} from "@oh-my-pi/pi-agent-core/compaction/messages";
import type {
	AssistantMessage,
	AudioContent,
	ImageContent,
	Message,
	MessageAttribution,
	TextContent,
	ToolResultMessage,
	UserMessage,
	VideoContent,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import userInterjectionTemplate from "../prompts/steering/user-interjection.md" with { type: "text" };
import { formatTitleConversationContext, type TitleConversationTurn } from "../tiny/message-preproc";

export {
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "@oh-my-pi/pi-agent-core/compaction/messages";

import type { OutputMeta } from "../tools/output-meta";
import { formatOutputNotice } from "../tools/output-meta";
import { titleTextFromSkillPrompt } from "./skill-title-input";

export const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";
export const LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE = "lsp-late-diagnostic";
// Value is the persisted session-JSONL message type; do not change - older sessions render via this id.
export const BACKGROUND_SIDE_DISPATCH_MESSAGE_TYPE = "background-tan-dispatch";
export const PREWALK_PLAN_MESSAGE_TYPE = "prewalk-plan";

export function logProviderTurnError(msg: AssistantMessage): void {
	if (msg.stopReason !== "error") return;
	logger.warn("agent turn ended with provider error", {
		provider: msg.provider,
		model: msg.model,
		errorMessage: msg.errorMessage,
		errorStatus: msg.errorStatus,
		errorId: msg.errorId,
	});
}

const EPHEMERAL_REPLY_MAX_BYTES = 4096;
const REPLAN_TITLE_CONTEXT_TURN_LIMIT = 6;

export function sanitizeAssistantForReparentedHistory(message: AssistantMessage): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "redactedThinking" || block.type === "anthropicServerTool") continue;
		if (block.type === "thinking") {
			content.push({ type: "thinking", thinking: block.thinking });
			continue;
		}
		content.push(block);
	}
	return { ...message, content, providerPayload: undefined };
}

export function dedupeEphemeralReply(text: string): string {
	if (!text) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		let j = i + 1;
		while (j < lines.length && lines[j] === lines[i]) j++;
		const runLen = j - i;
		if (runLen > 3) {
			out.push(lines[i], `[…${runLen}×]`);
		} else {
			for (let k = 0; k < runLen; k++) out.push(lines[i]);
		}
		i = j;
	}
	let result = out.join("\n");
	if (Buffer.byteLength(result, "utf8") > EPHEMERAL_REPLY_MAX_BYTES) {
		const suffix = "\n[…truncated]";
		const budget = EPHEMERAL_REPLY_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
		while (Buffer.byteLength(result, "utf8") > budget) {
			result = result.slice(0, -1);
		}
		result += suffix;
	}
	return result;
}

export function buildReplanTitleContext(messages: AgentMessage[]): string {
	const turns: TitleConversationTurn[] = [];
	for (let i = messages.length - 1; i >= 0 && turns.length < REPLAN_TITLE_CONTEXT_TURN_LIMIT; i--) {
		const message = messages[i];
		if (!message) continue;
		const turn = titleConversationTurnFromMessage(message);
		if (turn) turns.push(turn);
	}
	turns.reverse();
	return formatTitleConversationContext(turns);
}

export function didSessionMessagesChange(previousMessages: AgentMessage[], nextMessages: AgentMessage[]): boolean {
	if (previousMessages.length !== nextMessages.length) return true;
	return previousMessages.some(
		(message, i) =>
			!Bun.deepEquals(
				normalizeSessionMessageForProviderReplay(message),
				normalizeSessionMessageForProviderReplay(nextMessages[i]),
			),
	);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		const text = block.text.trim();
		if (text) parts.push(text);
	}
	return parts.join("\n\n");
}

function thinkingFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "thinking" || typeof block.thinking !== "string") continue;
		const thinking = block.thinking.trim();
		if (thinking) parts.push(thinking);
	}
	return parts.join("\n\n");
}

function titleConversationTurnFromMessage(message: AgentMessage): TitleConversationTurn | undefined {
	if (message.role === "custom") {
		const text = titleTextFromSkillPrompt(message);
		if (!text) return undefined;
		return { role: "user", text };
	}
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const text = textFromContent(message.content);
	const thinking = message.role === "assistant" ? thinkingFromContent(message.content) : undefined;
	if (!text && !thinking) return undefined;
	return { role: message.role, ...(text ? { text } : {}), ...(thinking ? { thinking } : {}) };
}

function normalizeProviderReplayValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(normalizeProviderReplayValue);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, entryValue]) => [key, normalizeProviderReplayValue(entryValue)]),
		);
	}
	return value;
}

function normalizeSessionMessageForProviderReplay(message: AgentMessage): unknown {
	switch (message.role) {
		case "user":
		case "developer":
			return {
				role: message.role,
				content: normalizeProviderReplayValue(message.content),
				providerPayload: message.providerPayload,
			};
		case "assistant": {
			const isResponsesFamilyMessage =
				message.api === "openai-responses" || message.api === "openai-codex-responses";
			return {
				role: message.role,
				content:
					isResponsesFamilyMessage && Array.isArray(message.content)
						? message.content.flatMap(block => {
								if (block.type === "thinking") {
									return [];
								}
								if (block.type === "toolCall") {
									return [
										{
											type: block.type,
											id: block.id,
											name: block.name,
											arguments: block.arguments,
										},
									];
								}
								if (block.type === "text") {
									return [{ type: block.type, text: block.text, textSignature: block.textSignature }];
								}
								return [normalizeProviderReplayValue(block)];
							})
						: normalizeProviderReplayValue(message.content),
				api: message.api,
				provider: message.provider,
				model: message.model,
				stopReason: message.stopReason,
				errorMessage: message.errorMessage,
				providerPayload: isResponsesFamilyMessage ? undefined : message.providerPayload,
			};
		}
		case "toolResult":
			return {
				role: message.role,
				toolName: message.toolName,
				toolCallId: message.toolCallId,
				isError: message.isError,
				content: normalizeProviderReplayValue(message.content),
			};
		case "bashExecution":
			return {
				role: message.role,
				command: message.command,
				output: message.output,
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				meta: message.meta
					? {
							truncation: normalizeProviderReplayValue(message.meta.truncation),
							limits: normalizeProviderReplayValue(message.meta.limits),
							diagnostics: message.meta.diagnostics
								? normalizeProviderReplayValue({
										summary: message.meta.diagnostics.summary,
										messages: message.meta.diagnostics.messages,
									})
								: undefined,
						}
					: undefined,
				excludeFromContext: message.excludeFromContext,
			};
		case "pythonExecution":
			return {
				role: message.role,
				code: message.code,
				output: message.output,
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				meta: message.meta
					? {
							truncation: normalizeProviderReplayValue(message.meta.truncation),
							limits: normalizeProviderReplayValue(message.meta.limits),
							diagnostics: message.meta.diagnostics
								? normalizeProviderReplayValue({
										summary: message.meta.diagnostics.summary,
										messages: message.meta.diagnostics.messages,
									})
								: undefined,
						}
					: undefined,
				excludeFromContext: message.excludeFromContext,
			};
		case "custom":
		case "hookMessage":
			return {
				role: message.role,
				customType: message.customType,
				content: normalizeProviderReplayValue(message.content),
			};
		case "branchSummary":
			return { role: message.role, summary: message.summary };
		case "compactionSummary":
			return {
				role: message.role,
				summary: message.summary,
				providerPayload: message.providerPayload,
			};
		case "fileMention":
			return {
				role: message.role,
				files: message.files.map(file => ({
					path: file.path,
					content: file.content,
					image: file.image,
				})),
			};
		default:
			return normalizeProviderReplayValue(message);
	}
}

const DEFAULT_CUSTOM_MESSAGE_TYPE = "custom-message";

export const LIVE_DELEGATION_MESSAGE_TYPE = "live-delegation";

type CustomMessageContent = string | (TextContent | ImageContent)[];

export type CustomMessagePayload<T = unknown> =
	| string
	| Partial<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">>;

type NormalizedCustomMessagePayload<T = unknown> = Pick<
	CustomMessage<T>,
	"customType" | "content" | "display" | "details" | "attribution"
>;

export const INTERRUPTED_THINKING_MESSAGE_TYPE = "interrupted-thinking";

export const CHECKPOINT_ACTIVE_REMINDER_TYPE = "checkpoint-active-reminder";

export interface InterruptedThinkingDetails {
	interruptedAt: number;
	provider: AssistantMessage["provider"];
	model: string;
	blockCount: number;
}

interface DemotedInterruptedThinking {
	reasoning: string;
	strippedContent: AssistantMessage["content"];
	blockCount: number;
}

export function demoteInterruptedThinking(
	message: Pick<AssistantMessage, "content">,
): DemotedInterruptedThinking | undefined {
	const content = message.content;
	let scanEnd = content.length;
	while (scanEnd > 0) {
		const block = content[scanEnd - 1]!;
		if (block.type !== "text" || block.text.trim().length > 0) {
			break;
		}
		scanEnd--;
	}

	let runStart = scanEnd;
	while (runStart > 0) {
		const block = content[runStart - 1]!;
		if (block.type !== "thinking" || block.thinking.trim().length === 0 || block.thinkingSignature) {
			break;
		}
		runStart--;
	}

	const blockCount = scanEnd - runStart;
	if (blockCount === 0) {
		return undefined;
	}

	const reasoningBlocks: string[] = [];
	for (let index = runStart; index < scanEnd; index++) {
		const block = content[index]!;
		if (block.type === "thinking") {
			reasoningBlocks.push(block.thinking.trim());
		}
	}

	return {
		reasoning: reasoningBlocks.join("\n\n"),
		strippedContent: content.slice(0, runStart),
		blockCount,
	};
}

function followedByInterruptedThinking(messages: AgentMessage[], index: number): boolean {
	const next = messages[index + 1];
	return next !== undefined && next.role === "custom" && next.customType === INTERRUPTED_THINKING_MESSAGE_TYPE;
}

function stripDemotedThinkingForLlm(message: AssistantMessage): AssistantMessage {
	const demoted = demoteInterruptedThinking(message);
	return demoted ? { ...message, content: demoted.strippedContent } : message;
}

export interface BackgroundSideDispatchDetails {
	jobId: string;
	work: string;

	sessionFile: string;
}

export interface SkillPromptDetails {
	name: string;
	path: string;
	args?: string;
	lineCount: number;

	__queueChipText?: string;
}

export const USER_INTERRUPT_LABEL = "Interrupted by user";

export function isUserInterruptAbort(message: Pick<AssistantMessage, "errorId" | "errorMessage">): boolean {
	return AIError.is(message.errorId, AIError.Flag.UserInterrupt) || message.errorMessage === USER_INTERRUPT_LABEL;
}

export function shouldRenderAbortReason(message: Pick<AssistantMessage, "errorId" | "errorMessage">): boolean {
	return !isUserInterruptAbort(message);
}

export function isEmptyErrorTurn(message: Pick<AssistantMessage, "stopReason" | "content">): boolean {
	if (message.stopReason !== "error") return false;
	return !message.content.some(block => {
		switch (block.type) {
			case "text":
				return block.text.trim().length > 0;
			case "thinking":
				return block.thinking.trim().length > 0 || (block.thinkingSignature?.trim().length ?? 0) > 0;
			case "redactedThinking":
				return block.data.trim().length > 0;
			case "toolCall":
				return true;
			case "fallback":
				return false;

			default:
				return true;
		}
	});
}

function hasText(content: { text?: unknown }): boolean {
	return typeof content.text === "string" && content.text.trim().length > 0;
}

function isActionableContent(content: AssistantMessage["content"][number] | undefined): boolean {
	switch (content?.type) {
		case "toolCall":
		case "image":
		case "redactedThinking":
		case "anthropicServerTool":
			return true;
		case "text":
			return hasText(content);
		case "thinking":
			return typeof content.thinkingSignature === "string" && content.thinkingSignature.trim().length > 0;
		default:
			return false;
	}
}

export function isEmptyAssistantStop(message: Pick<AssistantMessage, "stopReason" | "content">): boolean {
	switch (message.stopReason) {
		case "stop":
			return !message.content.some(isActionableContent);
		case "toolUse":
			return !message.content.some(
				content => content?.type === "toolCall" || (content?.type === "text" && hasText(content)),
			);
		default:
			return false;
	}
}

export function assistantTurnProducedOutput(message: Pick<AssistantMessage, "stopReason" | "content">): boolean {
	if (message.stopReason === "error" || message.stopReason === "aborted") return false;
	return !isEmptyAssistantStop(message) && message.content.some(isActionableContent);
}

const GENERIC_ABORT_SENTINEL = "Request was aborted";

export function resolveAbortLabel(
	message: Pick<AssistantMessage, "errorId" | "errorMessage">,
	retryAttempt = 0,
): string {
	const genericAbort =
		AIError.is(message.errorId, AIError.Flag.Abort) ||
		!message.errorMessage ||
		message.errorMessage === GENERIC_ABORT_SENTINEL;
	if (!genericAbort) {
		return message.errorMessage!;
	}
	if (retryAttempt > 0) {
		return `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`;
	}
	return "Operation aborted";
}

export function readQueueChipText(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const candidate = (details as { __queueChipText?: unknown }).__queueChipText;
	return typeof candidate === "string" ? candidate : undefined;
}

export const INTERNAL_DETAILS_FIELDS = ["__queueChipText"] as const;

export function stripInternalDetailsFields<T>(details: T | undefined): T | undefined {
	if (details == null || typeof details !== "object") return details;
	const obj = details as Record<string, unknown>;
	let hit = false;
	for (const key of INTERNAL_DETAILS_FIELDS) {
		if (key in obj) {
			hit = true;
			break;
		}
	}
	if (!hit) return details;
	const cleaned: Record<string, unknown> = { ...obj };
	for (const key of INTERNAL_DETAILS_FIELDS) {
		delete cleaned[key];
	}
	return cleaned as T;
}

export function isCustomMessageContent(content: unknown): content is CustomMessageContent {
	return typeof content === "string" || Array.isArray(content);
}

function normalizeCustomMessageContent(content: unknown): CustomMessageContent {
	return isCustomMessageContent(content) ? content : "";
}

function normalizeCustomMessageType(customType: unknown): string {
	return typeof customType === "string" && customType.length > 0 ? customType : DEFAULT_CUSTOM_MESSAGE_TYPE;
}

function normalizeCustomMessageAttribution(attribution: unknown): MessageAttribution {
	return attribution === "user" ? "user" : "agent";
}

function isCustomMessagePayloadObject<T>(
	payload: unknown,
): payload is Partial<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">> {
	return payload !== null && typeof payload === "object" && !Array.isArray(payload);
}

export function normalizeCustomMessagePayload<T = unknown>(
	payload: CustomMessagePayload<T> | unknown,
): NormalizedCustomMessagePayload<T> {
	if (typeof payload === "string") {
		return {
			customType: DEFAULT_CUSTOM_MESSAGE_TYPE,
			content: payload,
			display: true,
			attribution: "agent",
		};
	}
	if (!isCustomMessagePayloadObject<T>(payload)) {
		const content = payload === undefined || payload === null ? "" : String(payload);
		return {
			customType: DEFAULT_CUSTOM_MESSAGE_TYPE,
			content,
			display: content.length > 0,
			attribution: "agent",
		};
	}
	return {
		customType: normalizeCustomMessageType(payload.customType),
		content: normalizeCustomMessageContent(payload.content),
		display: typeof payload.display === "boolean" ? payload.display : false,
		details: payload.details,
		attribution: normalizeCustomMessageAttribution(payload.attribution),
	};
}

type SteeringUserMessage = UserMessage & { steering: true };

function isSteeringUserMessage(message: AgentMessage | undefined): message is SteeringUserMessage {
	return message?.role === "user" && message.steering === true;
}

function userMessageWithoutSteering(message: UserMessage): UserMessage {
	const { steering, ...rest } = message;
	void steering;
	return rest;
}

function renderSteeringEnvelope(message: string): string {
	return prompt.render(userInterjectionTemplate, { message });
}

function getArrayContentText(content: readonly (TextContent | ImageContent | AudioContent | VideoContent)[]): string {
	let firstText: string | undefined;
	let textParts: string[] | undefined;
	for (const part of content) {
		if (part.type !== "text") continue;
		if (firstText === undefined) {
			firstText = part.text;
			continue;
		}
		if (textParts === undefined) {
			textParts = [firstText];
		}
		textParts.push(part.text);
	}
	return textParts === undefined ? (firstText ?? "") : textParts.join("\n");
}

function getArrayContentImages(
	content: readonly (TextContent | ImageContent | AudioContent | VideoContent)[],
): ImageContent[] {
	let images: ImageContent[] | undefined;
	for (const part of content) {
		if (part.type !== "image") continue;
		if (images === undefined) images = [];
		images.push(part);
	}
	return images ?? [];
}

function wrapSteeringUserMessage(message: SteeringUserMessage): UserMessage {
	const userMessage = userMessageWithoutSteering(message);
	if (typeof message.content === "string") {
		if (message.content.length === 0) return message;
		return { ...userMessage, content: renderSteeringEnvelope(message.content) };
	}

	const text = getArrayContentText(message.content);
	if (text.length === 0) return message;
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: renderSteeringEnvelope(text) }];
	content.push(...getArrayContentImages(message.content));
	return { ...userMessage, content };
}

export function wrapSteeringForModel(messages: AgentMessage[]): AgentMessage[] {
	let wrappedMessages: AgentMessage[] | undefined;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (!isSteeringUserMessage(message)) continue;
		const wrappedMessage = wrapSteeringUserMessage(message);
		if (wrappedMessage === message) continue;
		if (wrappedMessages === undefined) {
			wrappedMessages = messages.slice();
		}
		wrappedMessages[i] = wrappedMessage;
	}
	return wrappedMessages ?? messages;
}

interface StripContentResult {
	content: (AudioContent | ImageContent | TextContent | VideoContent)[];
	removed: number;
}

function stripImagesFromArrayContent(
	content: (AudioContent | ImageContent | TextContent | VideoContent)[],
): StripContentResult {
	let removed = 0;
	const kept: (AudioContent | ImageContent | TextContent | VideoContent)[] = [];
	for (const part of content) {
		if (part.type === "image") {
			removed++;
		} else {
			kept.push(part);
		}
	}
	if (removed === 0) {
		return { content, removed };
	}

	if (kept.length === 0) {
		kept.push({ type: "text", text: "[image removed]" });
	}
	return { content: kept, removed };
}

export function stripImagesFromMessage(message: AgentMessage): number {
	const removed = stripImagesFromMessageContent(message);

	if (removed > 0) invalidateMessageCache(message);
	return removed;
}

function stripImagesFromMessageContent(message: AgentMessage): number {
	switch (message.role) {
		case "user":
		case "developer":
		case "custom":
		case "hookMessage": {
			if (typeof message.content === "string") return 0;
			const { content, removed } = stripImagesFromArrayContent(message.content);
			if (removed > 0) {
				(message as { content: typeof content }).content = content;
			}
			return removed;
		}
		case "toolResult": {
			let removed = 0;
			const { content, removed: contentRemoved } = stripImagesFromArrayContent(message.content);
			if (contentRemoved > 0) {
				// toolResult content is text/image only at the type level; the widened result
				// cannot actually carry audio/video blocks here.
				message.content = content as ToolResultMessage["content"];
				removed += contentRemoved;
			}
			const details = message.details as { images?: unknown } | null | undefined;
			if (details && Array.isArray(details.images)) {
				const original = details.images as unknown[];
				const kept: unknown[] = [];
				for (const candidate of original) {
					const looksLikeImageBlock =
						!!candidate && typeof candidate === "object" && (candidate as { type?: unknown }).type === "image";
					if (looksLikeImageBlock) {
						removed++;
					} else {
						kept.push(candidate);
					}
				}
				if (kept.length !== original.length) {
					details.images = kept;
				}
			}
			return removed;
		}
		case "fileMention": {
			let removed = 0;
			for (const file of message.files) {
				if (file.image) {
					file.image = undefined;
					removed++;
				}
			}
			return removed;
		}
		default:
			return 0;
	}
}

export function replaceLlmImagesWithText(messages: Message[], placeholder: string): Message[] {
	let out: Message[] | undefined;
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "user" && msg.role !== "developer" && msg.role !== "toolResult") continue;
		const content = msg.content;
		if (!Array.isArray(content) || !content.some(part => part.type === "image")) continue;
		const replaced: (AudioContent | ImageContent | TextContent | VideoContent)[] = [];
		for (const part of content) {
			if (part.type !== "image") {
				replaced.push(part);
				continue;
			}
			const prev = replaced[replaced.length - 1];
			if (prev?.type === "text" && prev.text === placeholder) continue;
			replaced.push({ type: "text", text: placeholder });
		}
		if (out === undefined) out = messages.slice();
		out[i] = { ...msg, content: replaced } as Message;
	}
	return out ?? messages;
}

export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;

	excludeFromContext?: boolean;
}

export interface PythonExecutionMessage {
	role: "pythonExecution";
	code: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;

	excludeFromContext?: boolean;
}

export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: CustomMessageContent;
	display: boolean;
	details?: T;

	attribution?: MessageAttribution;
	timestamp: number;
}

export interface HookMessage<T = unknown> {
	role: "hookMessage";
	customType: string;
	content: CustomMessageContent;
	display: boolean;
	details?: T;

	attribution?: MessageAttribution;
	timestamp: number;
}

export interface FileMentionMessage {
	role: "fileMention";
	files: Array<{
		path: string;
		content: string;
		lineCount?: number;

		byteSize?: number;

		skippedReason?: "tooLarge" | "binary";
		image?: ImageContent;
	}>;
	timestamp: number;
}

declare module "@oh-my-pi/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		pythonExecution: PythonExecutionMessage;
		custom: CustomMessage;
		hookMessage: HookMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
		fileMention: FileMentionMessage;
	}
}

function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	text += formatOutputNotice(msg.meta);
	return text;
}

function pythonExecutionToText(msg: PythonExecutionMessage): string {
	let text = `Ran Python:\n\`\`\`python\n${msg.code}\n\`\`\`\n`;
	if (msg.output) {
		text += `Output:\n\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(execution cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nExecution failed with code ${msg.exitCode}`;
	}
	text += formatOutputNotice(msg.meta);
	return text;
}

export function sanitizeRehydratedOpenAIResponsesAssistantMessage(message: AssistantMessage): AssistantMessage {
	if (message.providerPayload?.type !== "openaiResponsesHistory") {
		return message;
	}

	if (message.provider !== "github-copilot") {
		return message;
	}

	let didSanitizeContent = false;
	const sanitizedContent = message.content.map(block => {
		if (block.type !== "thinking" || block.thinkingSignature === undefined) {
			return block;
		}
		didSanitizeContent = true;
		return { ...block, thinkingSignature: undefined };
	});

	return {
		...message,
		...(didSanitizeContent ? { content: sanitizedContent } : {}),
		providerPayload: undefined,
	};
}

function customMessageContentToLlmContent(content: CustomMessage["content"]): (TextContent | ImageContent)[] {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

export function isUserInvokedSkillPrompt(message: CustomMessage): boolean {
	return message.customType === SKILL_PROMPT_MESSAGE_TYPE && message.attribution === "user";
}

function convertImageBearingCustomMessage(message: CustomMessage | HookMessage): Message[] | undefined {
	if (!isCustomMessageContent(message.content)) return undefined;
	if (typeof message.content === "string") return undefined;
	const textBlocks = message.content.filter((content): content is TextContent => content.type === "text");
	const imageBlocks = message.content.filter((content): content is ImageContent => content.type === "image");
	if (imageBlocks.length === 0) return undefined;

	const converted: Message[] = [];
	if (textBlocks.length > 0) {
		converted.push({
			role: "developer",
			content: textBlocks,
			attribution: message.attribution,
			timestamp: message.timestamp,
		});
	}
	converted.push({
		role: "user",
		content: [{ type: "text", text: `Images attached to ${message.customType}.` }, ...imageBlocks],
		attribution: message.attribution,
		timestamp: message.timestamp,
	});
	return converted;
}

interface ConvertMemoEntry {
	interruptedNext: boolean;
	fragment: Message[];
}
const convertCache = new WeakMap<AgentMessage, ConvertMemoEntry>();

interface ConvertArrayMemo {
	generation: number;
	length: number;
	output: Message[];
	tail: AgentMessage | undefined;
	prefixOutputLen: number;
}

let convertGeneration = 0;
const convertArrayCache = new WeakMap<AgentMessage[], ConvertArrayMemo>();

registerMessageCacheInvalidator(message => {
	convertCache.delete(message);
	convertGeneration++;
});

function convertOne(m: AgentMessage, interruptedNext: boolean): Message[] {
	switch (m.role) {
		case "bashExecution":
			if (m.excludeFromContext) {
				return [];
			}
			return [
				{
					role: "user",
					content: [{ type: "text", text: bashExecutionToText(m) }],
					attribution: "user",
					timestamp: m.timestamp,
				},
			];
		case "pythonExecution":
			if (m.excludeFromContext) {
				return [];
			}
			return [
				{
					role: "user",
					content: [{ type: "text", text: pythonExecutionToText(m) }],
					attribution: "user",
					timestamp: m.timestamp,
				},
			];
		case "fileMention": {
			const wrap = (file: FileMentionMessage["files"][number]): string => {
				const inner = file.content ? `\n${file.content}\n` : "\n";
				return `<file path="${file.path}">${inner}</file>`;
			};
			const textFiles = m.files.filter(file => !file.image);
			const imageFiles = m.files.filter(file => file.image);
			const out: Message[] = [];
			if (textFiles.length > 0) {
				out.push({
					role: "developer",
					content: [{ type: "text" as const, text: textFiles.map(wrap).join("\n") }],
					attribution: "user",
					timestamp: m.timestamp,
				});
			}
			if (imageFiles.length > 0) {
				const content: (TextContent | ImageContent)[] = [
					{ type: "text" as const, text: imageFiles.map(wrap).join("\n") },
				];
				for (const file of imageFiles) {
					if (file.image) content.push(file.image);
				}
				out.push({
					role: "user",
					content,
					attribution: "user",
					timestamp: m.timestamp,
				});
			}
			return out;
		}
		case "custom": {
			if (!isCustomMessageContent(m.content)) return [];
			if (isSteeringUserMessage(m)) {
				const converted = convertMessageToLlm(wrapSteeringUserMessage(m));
				return converted ? [converted] : [];
			}
			if (isUserInvokedSkillPrompt(m)) {
				return [
					{
						role: "user",
						content: customMessageContentToLlmContent(m.content),
						attribution: "user",
						timestamp: m.timestamp,
					},
				];
			}
			const split = convertImageBearingCustomMessage(m);
			if (split) return split;
			const converted = convertMessageToLlm(m);
			return converted ? [converted] : [];
		}
		case "hookMessage": {
			if (!isCustomMessageContent(m.content)) return [];
			const split = convertImageBearingCustomMessage(m);
			if (split) return split;
			const converted = convertMessageToLlm(m);
			return converted ? [converted] : [];
		}
		case "assistant": {
			const userInterrupted = m.stopReason === "aborted" && isUserInterruptAbort(m);
			const source = interruptedNext || userInterrupted ? stripDemotedThinkingForLlm(m) : m;
			if (userInterrupted && !interruptedNext && source.content.length === 0) return [];
			const converted = convertMessageToLlm(source);
			return converted ? [converted] : [];
		}
		case "branchSummary":
		case "compactionSummary":
		case "user":
		case "developer":
		case "toolResult": {
			const converted = convertMessageToLlm(m);
			return converted ? [converted] : [];
		}
		default:
			m satisfies never;
			return [];
	}
}

function convertOneCached(m: AgentMessage, interruptedNext: boolean): Message[] {
	const cached = convertCache.get(m);
	if (cached !== undefined && cached.interruptedNext === interruptedNext) return cached.fragment;
	const fragment = convertOne(m, interruptedNext);
	convertCache.set(m, { interruptedNext, fragment });
	return fragment;
}

export function convertToLlm(messages: AgentMessage[]): Message[] {
	const len = messages.length;
	const memo = convertArrayCache.get(messages);
	const sameGeneration = memo !== undefined && memo.generation === convertGeneration;
	const tail = len > 0 ? messages[len - 1] : undefined;

	if (sameGeneration && memo.length === len && tail === memo.tail) {
		return memo.output;
	}

	let out: Message[];
	let start: number;
	if (
		sameGeneration &&
		len > memo.length &&
		memo.length > 0 &&
		messages[memo.length - 1] === memo.tail &&
		memo.prefixOutputLen <= memo.output.length
	) {
		out = memo.output.slice(0, memo.prefixOutputLen);
		start = memo.length - 1;
	} else {
		out = [];
		start = 0;
	}

	let prefixOutputLen = 0;
	for (let i = start; i < len; i++) {
		if (i === len - 1) prefixOutputLen = out.length;
		const m = messages[i];
		const interruptedNext = m.role === "assistant" && followedByInterruptedThinking(messages, i);
		const fragment = convertOneCached(m, interruptedNext);
		for (const msg of fragment) out.push(msg);
	}
	if (len === 0) prefixOutputLen = 0;

	convertArrayCache.set(messages, {
		generation: convertGeneration,
		length: len,
		output: out,
		tail,
		prefixOutputLen,
	});
	return out;
}
