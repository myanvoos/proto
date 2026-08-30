import type {
	AudioContent,
	Context,
	DeveloperMessage,
	ImageContent,
	Model,
	TextContent,
	ToolResultMessage,
	UserMessage,
	VideoContent,
} from "@oh-my-pi/pi-ai";

const PROVIDER_IMAGE_BUDGETS: Record<string, number> = {
	anthropic: 90,
	"amazon-bedrock": 90,
	openai: 200,
	"openai-codex": 200,
	google: 200,
	"google-vertex": 200,
	"google-gemini-cli": 200,
	openrouter: 90,
	umans: 10,
};

const DEFAULT_PROVIDER_IMAGE_BUDGET = 5;

function providerImageBudget(provider: string | undefined): number {
	return (provider !== undefined ? PROVIDER_IMAGE_BUDGETS[provider] : undefined) ?? DEFAULT_PROVIDER_IMAGE_BUDGET;
}

const TOOL_RESULT_IMAGE_OMISSION: TextContent = {
	type: "text",
	text: "[image omitted: provider image limit]",
};

function countImages(context: Context): number {
	let count = 0;
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") count++;
		}
	}
	return count;
}

function clampContent(
	content: readonly (TextContent | ImageContent | AudioContent | VideoContent)[],
	state: { remainingDrops: number },
): (TextContent | ImageContent | AudioContent | VideoContent)[] | undefined {
	let changed = false;
	const clamped: (TextContent | ImageContent | AudioContent | VideoContent)[] = [];
	for (const part of content) {
		if (part.type === "image" && state.remainingDrops > 0) {
			state.remainingDrops--;
			changed = true;
			continue;
		}
		clamped.push(part);
	}
	return changed ? clamped : undefined;
}

function clampUserMessage(message: UserMessage, state: { remainingDrops: number }): UserMessage {
	if (!Array.isArray(message.content) || state.remainingDrops <= 0) return message;
	const content = clampContent(message.content, state);
	return content ? { ...message, content, providerPayload: undefined } : message;
}

function clampDeveloperMessage(message: DeveloperMessage, state: { remainingDrops: number }): DeveloperMessage {
	if (!Array.isArray(message.content) || state.remainingDrops <= 0) return message;
	const content = clampContent(message.content, state);
	return content ? { ...message, content, providerPayload: undefined } : message;
}

function clampToolResultMessage(message: ToolResultMessage, state: { remainingDrops: number }): ToolResultMessage {
	if (state.remainingDrops <= 0) return message;
	const content = clampContent(message.content, state);
	if (!content) return message;
	// toolResult content is text/image only at the type level; the widened result
	// cannot actually carry audio/video blocks here.
	return {
		...message,
		content: (content.length > 0 ? content : [TOOL_RESULT_IMAGE_OMISSION]) as ToolResultMessage["content"],
	};
}

export function clampProviderContextImages(context: Context, model: Model): Context {
	if (!model.input.includes("image")) return context;
	const limit = providerImageBudget(model.provider);
	const totalImages = countImages(context);
	if (totalImages <= limit) return context;

	const state = { remainingDrops: totalImages - limit };
	const messages = context.messages.map(message => {
		switch (message.role) {
			case "user":
				return clampUserMessage(message, state);
			case "developer":
				return clampDeveloperMessage(message, state);
			case "toolResult":
				return clampToolResultMessage(message, state);
			case "assistant":
				return message;
		}
		return message;
	});
	return { ...context, messages };
}
