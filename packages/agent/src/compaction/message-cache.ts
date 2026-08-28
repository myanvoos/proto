import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "../types";

const externalInvalidators = new Set<(message: AgentMessage) => void>();

export function registerMessageCacheInvalidator(invalidate: (message: AgentMessage) => void): () => void {
	externalInvalidators.add(invalidate);
	return () => {
		externalInvalidators.delete(invalidate);
	};
}

const kEstimateVersion = Symbol("proto.messageEstimateVersion");

interface VersionedMessage {
	[kEstimateVersion]?: number;
}

export function messageEstimateVersion(message: AgentMessage): number {
	return (message as VersionedMessage)[kEstimateVersion] ?? 0;
}

export function isEstimateCacheable(message: AgentMessage): boolean {
	if (message.role !== "assistant") return true;
	const assistant = message as AssistantMessage;
	return (
		assistant.stopReason !== "aborted" &&
		assistant.stopReason !== "error" &&
		assistant.usage != null &&
		assistant.usage.totalTokens > 0
	);
}

export function invalidateMessageCache(message: AgentMessage): void {
	const versioned = message as VersionedMessage;
	versioned[kEstimateVersion] = ((versioned[kEstimateVersion] ?? 0) + 1) | 0;
	for (const invalidate of externalInvalidators) invalidate(message);
}
