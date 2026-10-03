import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import type { MessageCountOptions, Tokenizer } from "../tokenizer";
import type { AgentMessage } from "../types";
import { calculateContextTokens, hasContextTokenUsage } from "./compaction";

export interface TranscriptUsageAnchor {
	index: number;

	message: AssistantMessage;

	tokens: number;
}

export function isTranscriptUsageAnchor(message: AgentMessage): message is AssistantMessage {
	if (message.role !== "assistant") return false;
	const assistant = message as AssistantMessage;
	if (assistant.stopReason === "aborted" || assistant.stopReason === "error") return false;
	return assistant.usage !== undefined && hasContextTokenUsage(assistant.usage);
}

export function findTranscriptUsageAnchor(
	messages: readonly AgentMessage[],
	fromIndex = 0,
): TranscriptUsageAnchor | undefined {
	for (let index = messages.length - 1; index >= fromIndex; index--) {
		const message = messages[index];
		if (!isTranscriptUsageAnchor(message)) continue;
		return { index, message, tokens: calculateContextTokens(message.usage) };
	}
	return undefined;
}

/**
 * Newest assistant turn in a provider request's `messages` whose usage still describes the prefix it sits on.
 * Request contexts carry no compaction index, so staleness is read from the rewrite markers: a summary
 * (`historyRewriteAt`, committed at its `timestamp`) or a pruned tool result (`prunedAt`) replaced text every report
 * made at or before the rewrite already counted.
 */
export function findRequestUsageAnchor(messages: readonly Message[]): TranscriptUsageAnchor | undefined {
	let rewriteAt = Number.NEGATIVE_INFINITY;
	let anchorIndex = -1;
	let anchor: AssistantMessage | undefined;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "user" && message.historyRewriteAt !== undefined) {
			rewriteAt = Math.max(rewriteAt, message.historyRewriteAt, message.timestamp);
		} else if (message.role === "toolResult" && message.prunedAt !== undefined) {
			rewriteAt = Math.max(rewriteAt, message.prunedAt);
		} else if (isTranscriptUsageAnchor(message) && message.timestamp > rewriteAt) {
			anchorIndex = index;
			anchor = message;
		}
	}
	return anchor && { index: anchorIndex, message: anchor, tokens: calculateContextTokens(anchor.usage) };
}

export interface TranscriptTokenOptions {
	anchorFromIndex?: number;

	countFromIndex?: number;

	excludeEncryptedReasoning?: boolean;
}

export function estimateTranscriptTokens(
	messages: readonly AgentMessage[],
	tokenizer: Tokenizer,
	options?: TranscriptTokenOptions,
): number {
	const estimateOptions: MessageCountOptions | undefined =
		options?.excludeEncryptedReasoning === true ? { excludeEncryptedReasoning: true } : undefined;
	const anchor = findTranscriptUsageAnchor(messages, options?.anchorFromIndex ?? 0);
	let total = anchor?.tokens ?? 0;
	for (let index = anchor ? anchor.index + 1 : (options?.countFromIndex ?? 0); index < messages.length; index++) {
		total += tokenizer.countMessage(messages[index], estimateOptions);
	}
	return total;
}
