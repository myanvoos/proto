import type { ImageContent, Model, UserContent } from "@oh-my-pi/pi-ai";
import { sendsImageInputOnWire } from "@oh-my-pi/pi-ai/providers/vision-guard";
import {
	parseImageMetadata,
	parseMediaMetadata,
	SUPPORTED_AUDIO_MIME_TYPES,
	SUPPORTED_IMAGE_MIME_TYPES,
	SUPPORTED_VIDEO_MIME_TYPES,
} from "@oh-my-pi/pi-utils";
import { assertImagePixelSize } from "../utils/image-resources";
import { MAX_MEDIA_INPUT_BYTES, type MediaKind } from "../utils/media-loading";
import {
	decodeEvalArtifactBase64,
	type EvalArtifactOptions,
	type EvalArtifactRef,
	isEvalArtifactRef,
	resolveEvalArtifact,
} from "./artifact-values";

export const MAX_EVAL_COMPLETION_PARTS = 64;
export const MAX_EVAL_COMPLETION_BYTES = MAX_MEDIA_INPUT_BYTES;
export const MAX_EVAL_COMPLETION_TEXT_BYTES = 1024 * 1024;

export type EvalCompletionContentPart =
	| { type: "text"; text: string }
	| { type: "artifact"; ref: EvalArtifactRef }
	| EvalArtifactRef
	| { type: MediaKind; artifact: EvalArtifactRef; detail?: ImageContent["detail"] }
	| { type: MediaKind; data: string; mimeType: string; detail?: ImageContent["detail"] };
export type EvalCompletionInput = string | readonly EvalCompletionContentPart[] | EvalArtifactRef;
export interface EvalCompletionContentOptions extends EvalArtifactOptions {
	model: Model;
}

function assertFields(part: Record<string, unknown>, allowed: readonly string[]): void {
	for (const key of Object.keys(part))
		if (!allowed.includes(key)) throw new Error(`Unsupported completion content field: ${key}`);
}

function assertModality(kind: MediaKind, model: Model): void {
	if (!model.input?.includes(kind))
		throw new Error(`completion() model ${model.provider}/${model.id} does not support ${kind} input`);
	if (kind === "image") {
		const imageApis = [
			"openai-completions",
			"openai-responses",
			"openai-codex-responses",
			"azure-openai-responses",
			"openrouter",
			"anthropic-messages",
			"bedrock-converse-stream",
			"google-generative-ai",
			"google-gemini-cli",
			"google-vertex",
			"ollama-chat",
		];
		if (!imageApis.includes(model.api) || !sendsImageInputOnWire(model))
			throw new Error(`completion() provider API ${model.api} does not send image input for this model`);
	} else if (
		!["openai-completions", "google-generative-ai", "google-gemini-cli", "google-vertex"].includes(model.api)
	) {
		// Responses, Anthropic, Ollama, and Bedrock adapters currently omit audio/video.
		throw new Error(`completion() provider API ${model.api} does not support ${kind} content`);
	}
}

function contentKind(mimeType: string): "text" | MediaKind {
	if (mimeType.startsWith("text/") || mimeType === "application/json" || mimeType.endsWith("+json")) return "text";
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("audio/")) return "audio";
	if (mimeType.startsWith("video/")) return "video";
	throw new Error(`completion() does not support artifact MIME type ${mimeType}`);
}

function textPart(text: unknown): UserContent {
	if (typeof text !== "string") throw new Error("Completion text content must be a string");
	if (Buffer.byteLength(text) > MAX_EVAL_COMPLETION_TEXT_BYTES)
		throw new Error(`Completion text exceeds ${MAX_EVAL_COMPLETION_TEXT_BYTES} byte limit`);
	return { type: "text", text };
}

function mediaPart(kind: MediaKind, mimeType: unknown, data: Uint8Array, detail: unknown, model: Model): UserContent {
	assertModality(kind, model);
	const supported =
		kind === "image"
			? SUPPORTED_IMAGE_MIME_TYPES
			: kind === "audio"
				? SUPPORTED_AUDIO_MIME_TYPES
				: SUPPORTED_VIDEO_MIME_TYPES;
	if (typeof mimeType !== "string" || !supported.has(mimeType))
		throw new Error(`Unsupported completion ${kind} MIME type: ${String(mimeType)}`);
	if (kind === "audio" && model.api === "openai-completions" && mimeType !== "audio/wav" && mimeType !== "audio/mpeg")
		throw new Error("completion() openai-completions audio supports only audio/wav or audio/mpeg");
	let limit = MAX_MEDIA_INPUT_BYTES;
	if (kind === "image" && model.api === "anthropic-messages") limit = 5 * 1024 * 1024;
	if (kind === "image" && model.api === "bedrock-converse-stream") limit = 3.75 * 1024 * 1024;
	if (data.byteLength === 0 || data.byteLength > limit)
		throw new Error(`Completion ${kind} must contain 1–${limit} bytes`);
	const metadata = kind === "image" ? parseImageMetadata(data) : parseMediaMetadata(data);
	if (!metadata || metadata.mimeType !== mimeType)
		throw new Error(`Completion ${kind} bytes do not match MIME type ${mimeType}`);
	if (kind === "image" && "width" in metadata && metadata.width && metadata.height)
		assertImagePixelSize(metadata.width, metadata.height);
	if (detail !== undefined) {
		if (kind !== "image" || !["auto", "low", "high", "original"].includes(String(detail)))
			throw new Error("Invalid completion image detail");
		if (
			![
				"openai-completions",
				"openai-responses",
				"openai-codex-responses",
				"azure-openai-responses",
				"openrouter",
			].includes(model.api)
		)
			throw new Error(`completion() image detail is unsupported by ${model.api}`);
		const originalDetail =
			model.compat &&
			"supportsImageDetailOriginal" in model.compat &&
			model.compat.supportsImageDetailOriginal === true;
		if (detail === "original" && (model.api === "openai-completions" || !originalDetail))
			throw new Error("completion() selected model does not support original image detail");
	}
	const encoded = Buffer.from(data).toString("base64");
	return kind === "image"
		? {
				type: kind,
				mimeType,
				data: encoded,
				...(detail !== undefined ? { detail: detail as ImageContent["detail"] } : {}),
			}
		: { type: kind, mimeType, data: encoded };
}

async function artifactPart(
	ref: EvalArtifactRef,
	options: EvalCompletionContentOptions,
	kind?: MediaKind,
	detail?: unknown,
): Promise<UserContent> {
	if (!isEvalArtifactRef(ref)) throw new Error("Invalid completion artifact reference");
	const inferred = contentKind(ref.mimeType);
	if (kind !== undefined && kind !== inferred)
		throw new Error(`Completion ${kind} reference has incompatible MIME type ${ref.mimeType}`);
	if (inferred !== "text") assertModality(inferred, options.model);
	const { data } = await resolveEvalArtifact(ref, options);
	if (inferred !== "text") return mediaPart(inferred, ref.mimeType, data, detail, options.model);
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
	} catch {
		throw new Error("Completion text artifact is not valid UTF-8");
	}
	return textPart(text);
}

/** Resolve session-owned content snapshots, never ambient file paths, URLs, or provider file IDs. */
export async function resolveEvalCompletionContent(
	input: unknown,
	options: EvalCompletionContentOptions,
): Promise<UserContent[]> {
	options.signal?.throwIfAborted();
	if (typeof input === "string") {
		if (!input.length) throw new Error("completion() prompt must not be empty");
		return [textPart(input)];
	}
	const parts = isEvalArtifactRef(input) ? [input] : input;
	if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_EVAL_COMPLETION_PARTS)
		throw new Error(
			`completion() prompt must be text, an artifact reference, or 1–${MAX_EVAL_COMPLETION_PARTS} content parts`,
		);
	const content: UserContent[] = [];
	let bytes = 0;
	for (const value of parts) {
		options.signal?.throwIfAborted();
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("Completion content part must be an object");
		const part = value as Record<string, unknown>;
		let resolved: UserContent;
		if (isEvalArtifactRef(part)) {
			resolved = await artifactPart(part, options);
		} else if (part.type === "artifact") {
			assertFields(part, ["type", "ref"]);
			resolved = await artifactPart(part.ref as EvalArtifactRef, options);
		} else if (part.type === "text") {
			assertFields(part, ["type", "text"]);
			resolved = textPart(part.text);
		} else if (part.type === "image" || part.type === "audio" || part.type === "video") {
			if (Object.hasOwn(part, "artifact")) {
				assertFields(part, ["type", "artifact", "detail"]);
				resolved = await artifactPart(part.artifact as EvalArtifactRef, options, part.type, part.detail);
			} else {
				assertFields(part, ["type", "mimeType", "data", "detail"]);
				assertModality(part.type, options.model);
				resolved = mediaPart(
					part.type,
					part.mimeType,
					decodeEvalArtifactBase64(part.data),
					part.detail,
					options.model,
				);
			}
		} else {
			throw new Error(`Unsupported completion content type: ${String(part.type)}`);
		}
		bytes += resolved.type === "text" ? Buffer.byteLength(resolved.text) : Buffer.byteLength(resolved.data, "base64");
		if (bytes > MAX_EVAL_COMPLETION_BYTES)
			throw new Error(`Completion content exceeds ${MAX_EVAL_COMPLETION_BYTES} total byte limit`);
		content.push(resolved);
	}
	options.signal?.throwIfAborted();
	return content;
}
