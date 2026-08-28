import type { Context, ImageContent, Message, Model, TextContent } from "@oh-my-pi/pi-ai";
import { modelMatchesHost } from "@oh-my-pi/pi-catalog/hosts";

const URL_CAPABLE_OPENAI_APIS: Record<string, true> = {
	"openai-responses": true,
	"openai-codex-responses": true,
	"azure-openai-responses": true,
	"openai-completions": true,
	openrouter: true,
};

export function supportsRemoteImageUrls(model: Model): boolean {
	if (!model.input.includes("image")) return false;

	if (modelMatchesHost(model, "moonshotNative")) return false;
	if (URL_CAPABLE_OPENAI_APIS[model.api]) return true;
	if (model.api === "anthropic-messages") return model.provider === "anthropic";

	if (model.api === "google-gemini-cli") return model.provider === "google-antigravity";
	return model.api === "google-vertex";
}

type ImageBearingMessage = Extract<Message, { role: "user" | "developer" | "toolResult" }>;

function isImageBearing(message: Message): message is ImageBearingMessage {
	return message.role === "user" || message.role === "developer" || message.role === "toolResult";
}

function mapContextImages(context: Context, mapBlock: (block: ImageContent) => ImageContent): Context {
	let messagesChanged = false;
	const messages = context.messages.map(message => {
		if (!isImageBearing(message) || !Array.isArray(message.content)) return message;
		let contentChanged = false;
		const content = message.content.map((block): TextContent | ImageContent => {
			if (block.type !== "image") return block;
			const next = mapBlock(block);
			if (next !== block) contentChanged = true;
			return next;
		});
		if (!contentChanged) return message;
		messagesChanged = true;
		return { ...message, content } as Message;
	});
	return messagesChanged ? { ...context, messages } : context;
}

export function decorateContextImages(context: Context, urlFor: (block: ImageContent) => string | undefined): Context {
	return mapContextImages(context, block => {
		if (block.url || block.providerFile) return block;
		const url = urlFor(block);
		return url ? { ...block, url } : block;
	});
}

export function decorateContextProviderFiles(
	context: Context,
	referenceFor: (block: ImageContent) => ImageContent["providerFile"] | undefined,
): Context {
	return mapContextImages(context, block => {
		if (block.url) return block;
		const providerFile = referenceFor(block);
		if (!providerFile || providerFile === block.providerFile) return block;
		return { ...block, providerFile };
	});
}

export function contextHasImages(context: Context): boolean {
	return context.messages.some(
		message =>
			isImageBearing(message) &&
			Array.isArray(message.content) &&
			message.content.some(block => block.type === "image"),
	);
}

export async function inlineContextImages(
	context: Context,
	resolveData: (block: ImageContent) => Promise<string | null>,
): Promise<Context> {
	let messagesChanged = false;
	const messages = await Promise.all(
		context.messages.map(async message => {
			if (!isImageBearing(message) || !Array.isArray(message.content)) return message;
			let contentChanged = false;
			const content = await Promise.all(
				message.content.map(async (block): Promise<TextContent | ImageContent> => {
					if (block.type !== "image" || (!block.url && !block.providerFile)) return block;
					contentChanged = true;
					const { url: _url, providerFile: _providerFile, ...rest } = block;
					if (rest.data.length > 0) return rest;
					const data = await resolveData(block);
					if (data) return { ...rest, data };
					return { type: "text", text: "[image unavailable: render source expired]" };
				}),
			);
			if (!contentChanged) return message;
			messagesChanged = true;
			return { ...message, content } as Message;
		}),
	);
	return messagesChanged ? { ...context, messages } : context;
}

export function contextHasProviderFiles(context: Context): boolean {
	return context.messages.some(
		message =>
			isImageBearing(message) &&
			Array.isArray(message.content) &&
			message.content.some(block => block.type === "image" && block.providerFile !== undefined),
	);
}

export function contextHasImageUrls(context: Context): boolean {
	return context.messages.some(
		message =>
			isImageBearing(message) &&
			Array.isArray(message.content) &&
			message.content.some(block => block.type === "image" && block.url !== undefined),
	);
}
