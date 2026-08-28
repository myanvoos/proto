import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";

export function isProviderRefusalMessage(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	const stopType = message.stopDetails?.type;
	return stopType === "refusal" || stopType === "sensitive";
}

export function filterProviderReplayMessages(messages: readonly Message[]): Message[] {
	return messages.filter(message => message.role !== "assistant" || !isProviderRefusalMessage(message));
}
