import type {
	ImageContent,
	Message,
	MessageAttribution,
	ProviderPayload,
	TextContent,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "../types";
import branchSummaryContextPrompt from "./prompts/branch-summary-context.md" with { type: "text" };
import compactionSummaryContextPrompt from "./prompts/compaction-summary-context.md" with { type: "text" };
import handoffSummaryContextPrompt from "./prompts/handoff-summary-context.md" with { type: "text" };

const COMPACTION_SUMMARY_TEMPLATE = compactionSummaryContextPrompt;
const HANDOFF_SUMMARY_TEMPLATE = handoffSummaryContextPrompt;
const BRANCH_SUMMARY_TEMPLATE = branchSummaryContextPrompt;

function escapeSummaryBoundaryTags(summary: string): string {
	return summary.replace(/<\/?(summary|handoff)>/gi, tag => {
		const name = tag.slice(tag.startsWith("</") ? 2 : 1, -1).toLowerCase();
		return tag.startsWith("</") ? `&lt;/${name}>` : `&lt;${name}>`;
	});
}

export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;

	attribution?: MessageAttribution;
	timestamp: number;
}

export interface HookMessage<T = unknown> {
	role: "hookMessage";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;

	attribution?: MessageAttribution;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	shortSummary?: string;
	tokensBefore: number;

	tokensAfter?: number;

	method?: string;
	providerPayload?: ProviderPayload;

	warning?: string;
	timestamp: number;
}

export type CoreCompactionMessage = CustomMessage | HookMessage | BranchSummaryMessage | CompactionSummaryMessage;

declare module "../types" {
	interface CustomAgentMessages {
		custom: CustomMessage;
		hookMessage: HookMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}
export type ConvertToLlm = (messages: AgentMessage[]) => Message[];

function getPrunedToolResultContent(message: ToolResultMessage): (TextContent | ImageContent)[] {
	if (message.prunedAt === undefined) {
		return message.content;
	}
	const textBlocks = message.content.filter((content): content is TextContent => content.type === "text");
	const text = textBlocks.map(block => block.text).join("") || "[Output truncated]";
	return [{ type: "text", text }];
}

export function renderBranchSummaryContext(summary: string): string {
	return prompt.render(BRANCH_SUMMARY_TEMPLATE, { summary: escapeSummaryBoundaryTags(summary) });
}

export function renderCompactionSummaryContext(summary: string): string {
	return prompt.render(COMPACTION_SUMMARY_TEMPLATE, { summary: escapeSummaryBoundaryTags(summary) });
}

export function renderHandoffSummaryContext(summary: string): string {
	return prompt.render(HANDOFF_SUMMARY_TEMPLATE, { summary: escapeSummaryBoundaryTags(summary) });
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export interface CompactionSummaryMessageOptions {
	shortSummary?: string;
	providerPayload?: ProviderPayload;
	warning?: string;

	method?: string;

	tokensAfter?: number;
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	options: CompactionSummaryMessageOptions = {},
): CompactionSummaryMessage {
	const { shortSummary, providerPayload, warning, method, tokensAfter } = options;
	return {
		role: "compactionSummary",
		summary,
		shortSummary,
		tokensBefore,
		tokensAfter,
		method,
		providerPayload,
		warning,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
	attribution?: MessageAttribution,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		attribution,
		timestamp: new Date(timestamp).getTime(),
	};
}

function isCoreCompactionMessage(message: AgentMessage): message is AgentMessage & CoreCompactionMessage {
	return (
		message.role === "custom" ||
		message.role === "hookMessage" ||
		message.role === "branchSummary" ||
		message.role === "compactionSummary"
	);
}

export function convertMessageToLlm(message: AgentMessage): Message | undefined {
	if (isCoreCompactionMessage(message)) {
		switch (message.role) {
			case "custom":
			case "hookMessage": {
				const content =
					typeof message.content === "string"
						? [{ type: "text" as const, text: message.content }]
						: message.content;
				return {
					role: "developer",
					content,
					attribution: message.attribution,
					timestamp: message.timestamp,
				};
			}
			case "branchSummary":
				return {
					role: "user",
					content: [
						{
							type: "text" as const,
							text: renderBranchSummaryContext(message.summary),
						},
					],
					attribution: "agent",
					timestamp: message.timestamp,
				};
			case "compactionSummary":
				return {
					role: "user",
					content: [
						{
							type: "text" as const,
							text:
								message.method === "handoff"
									? renderHandoffSummaryContext(message.summary)
									: renderCompactionSummaryContext(message.summary),
						},
					],
					attribution: "agent",
					providerPayload: message.providerPayload,
					timestamp: message.timestamp,
				};
		}
	}

	switch (message.role) {
		case "user":
			return { ...message, attribution: message.attribution ?? "user" };
		case "developer":
			return { ...message, attribution: message.attribution ?? "agent" };
		case "assistant":
			return message;
		case "toolResult":
			return {
				...message,
				content: getPrunedToolResultContent(message as ToolResultMessage),
				attribution: message.attribution ?? "agent",
			};
		default:
			return undefined;
	}
}

export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.map(convertMessageToLlm).filter(message => message !== undefined);
}
