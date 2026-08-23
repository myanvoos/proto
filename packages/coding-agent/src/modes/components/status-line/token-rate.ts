export const MIN_RATE_DURATION_MS = 100;

export function tokensPerSecond(outputTokens: number, durationMs: number | null | undefined): number | null {
	if (!Number.isFinite(outputTokens) || outputTokens <= 0) return null;
	if (durationMs === null || durationMs === undefined) return null;
	if (!Number.isFinite(durationMs) || durationMs < MIN_RATE_DURATION_MS) return null;

	const rate = (outputTokens * 1000) / durationMs;
	return Number.isFinite(rate) && rate > 0 ? rate : null;
}

type AssistantUsage = {
	output: number;
};

type AssistantLikeMessage = {
	role: "assistant";
	timestamp: number;
	duration?: number;
	usage: AssistantUsage;
};

type MaybeAssistantMessage = {
	role?: string;
	timestamp?: number;
	duration?: number;
	usage?: {
		output?: number;
	};
};

function isRateableAssistantTurn(message: MaybeAssistantMessage | undefined): message is AssistantLikeMessage {
	return (
		message?.role === "assistant" &&
		typeof message.timestamp === "number" &&
		message.usage !== undefined &&
		typeof message.usage.output === "number"
	);
}

function getLastAssistantMessage(messages: ReadonlyArray<MaybeAssistantMessage>): AssistantLikeMessage | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isRateableAssistantTurn(message)) {
			return message;
		}
	}
	return null;
}

export function calculateTokensPerSecond(
	messages: ReadonlyArray<MaybeAssistantMessage>,
	isStreaming: boolean,
	nowMs: number = Date.now(),
): number | null {
	const assistant = getLastAssistantMessage(messages);
	if (!assistant) return null;

	const resolvedDurationMs =
		typeof assistant.duration === "number" && Number.isFinite(assistant.duration) && assistant.duration > 0
			? assistant.duration
			: isStreaming
				? nowMs - assistant.timestamp
				: null;

	return tokensPerSecond(assistant.usage.output, resolvedDurationMs);
}
