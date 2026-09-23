import { isDashscopeCompatibleModeUrl, modelMatchesHost } from "@oh-my-pi/pi-catalog/hosts";
import { isDeepseekModelIdOrName, isQwenModelId } from "@oh-my-pi/pi-catalog/identity";
import { $env } from "@oh-my-pi/pi-utils";

import type { AudioContent, ImageContent, Model, TextContent, VideoContent } from "../types";

export const NON_VISION_IMAGE_PLACEHOLDER = "[image omitted: model does not support vision]";
export const NON_AUDIO_PLACEHOLDER = "[audio omitted: model does not support audio input]";
export const NON_VIDEO_PLACEHOLDER = "[video omitted: model does not support video input]";

export function mediaOmissionNote(kind: "image" | "audio" | "video"): string {
	if (kind === "audio") return NON_AUDIO_PLACEHOLDER;
	if (kind === "video") return NON_VIDEO_PLACEHOLDER;
	return NON_VISION_IMAGE_PLACEHOLDER;
}

export interface MediaSupport {
	image: boolean;
	audio: boolean;
	video: boolean;
}

export function mediaSupportForModel(model: Pick<Model, "input">): MediaSupport {
	return {
		image: model.input.includes("image"),
		audio: model.input.includes("audio"),
		video: model.input.includes("video"),
	};
}

export interface PartitionedMediaContent {
	textBlocks: TextContent[];
	imageBlocks: ImageContent[];
	audioBlocks: AudioContent[];
	videoBlocks: VideoContent[];
	omissions: string[];
}

export function partitionUserMediaContent(
	content: readonly (TextContent | ImageContent | AudioContent | VideoContent)[],
	supports: MediaSupport,
): PartitionedMediaContent {
	const out: PartitionedMediaContent = {
		textBlocks: [],
		imageBlocks: [],
		audioBlocks: [],
		videoBlocks: [],
		omissions: [],
	};
	for (const block of content) {
		if (block.type === "text") {
			out.textBlocks.push(block);
		} else if (block.type === "image") {
			if (supports.image) out.imageBlocks.push(block);
			else out.omissions.push(NON_VISION_IMAGE_PLACEHOLDER);
		} else if (block.type === "audio") {
			if (supports.audio) out.audioBlocks.push(block);
			else out.omissions.push(NON_AUDIO_PLACEHOLDER);
		} else if (supports.video) {
			out.videoBlocks.push(block);
		} else {
			out.omissions.push(NON_VIDEO_PLACEHOLDER);
		}
	}
	return out;
}

export function joinTextWithOmissions(text: string, omissions: readonly string[]): string {
	const parts: string[] = [];
	if (text.length > 0) {
		parts.push(text);
	}
	parts.push(...omissions);
	return parts.join("\n");
}

export function joinTextWithImagePlaceholder(text: string, omittedImages: boolean): string {
	return joinTextWithOmissions(text, omittedImages ? [NON_VISION_IMAGE_PLACEHOLDER] : []);
}

export function isDashscopeCompatibleModeTextOnlyQwen(model: Model<"openai-completions" | "openrouter">): boolean {
	if (!isDashscopeCompatibleModeUrl(model.baseUrl)) {
		return false;
	}
	if (!isQwenModelId(model.id)) return false;
	const id = model.id.toLowerCase();
	if (/\bqwen(?:[\d.]+)?-coder\b/.test(id)) return true;
	const maxMatch = id.match(/\bqwen(?:(\d+)(?:\.(\d+))?)?-max\b/);
	if (!maxMatch) return false;

	const major = maxMatch[1] ? Number.parseInt(maxMatch[1], 10) : 0;
	const minor = maxMatch[2] ? Number.parseInt(maxMatch[2], 10) : 0;
	return major < 3 || (major === 3 && minor < 8);
}

// DeepSeek SKUs that genuinely accept image_url parts. Tokens are bounded by
// non-alphanumerics so `revision`/`provisioned` never read as `vision`; V4.1
// Flash is natively multimodal but its ids carry no such token.
const DEEPSEEK_IMAGE_SKU_TOKEN = /(?<![a-z0-9])(?:vision|ocr)(?![a-z0-9])/;

export function isTextOnlyDeepSeek(model: Model<"openai-completions" | "openrouter">): boolean {
	const id = model.id.toLowerCase();
	const name = (model.name ?? "").toLowerCase();

	if (DEEPSEEK_IMAGE_SKU_TOKEN.test(id) || DEEPSEEK_IMAGE_SKU_TOKEN.test(name)) return false;
	if (id.includes("v4.1-flash") || model.id === "deepseek-flash") return false;
	return (
		modelMatchesHost(model, "deepseekFamily") ||
		isDeepseekModelIdOrName(model.id) ||
		isDeepseekModelIdOrName(model.name ?? "") ||
		model.provider === "deepseek"
	);
}

export function isOpenAICompletionsVisionSupported(model: Model<"openai-completions" | "openrouter">): boolean {
	if (!model.input.includes("image")) return false;
	const stripImageInput = model.compat.stripImageInput;
	if (stripImageInput !== undefined) return !stripImageInput;
	if (isDashscopeCompatibleModeTextOnlyQwen(model)) return false;
	if (isTextOnlyDeepSeek(model)) return false;
	return true;
}

// Wire truth, not declared capability (`model.input`): pi-native forwards the
// original context to the gateway, so only Chat Completions and the OpenRouter
// chat fallback run the text-only guard client-side.
export function sendsImageInputOnWire(model: Model): boolean {
	if (model.transport === "pi-native") return model.input.includes("image");
	if (isGuardedCompletionsTransport(model)) return isOpenAICompletionsVisionSupported(model);
	return model.input.includes("image");
}

function isGuardedCompletionsTransport(model: Model): model is Model<"openai-completions" | "openrouter"> {
	if (model.api === "openai-completions") return true;
	return model.api === "openrouter" && $env.PI_OPENROUTER_RESPONSES === "0";
}
