import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AudioContent,
	completeSimple,
	type ImageContent,
	type Model,
	type ToolExample,
	type VideoContent,
} from "@oh-my-pi/pi-ai";
import { prompt, readImageMetadata, readMediaMetadata } from "@oh-my-pi/pi-utils";
import { extractTextContent } from "../commit/utils";

import {
	expandRoleAlias,
	extractExplicitThinkingSelector,
	getModelMatchPreferences,
	resolveModelFromString,
} from "../config/model-resolver";
import inspectMediaDescription from "../prompts/tools/inspect-media.md" with { type: "text" };
import inspectMediaSystemPromptTemplate from "../prompts/tools/inspect-media-system.md" with { type: "text" };
import { resolveThinkingLevelForModel, toReasoningEffort } from "../thinking";
import {
	ImageInputTooLargeError,
	type LoadedImageInput,
	loadImageAttachmentInput,
	loadImageInput,
	MAX_IMAGE_INPUT_BYTES,
	webpExclusionForModel,
} from "../utils/image-loading";
import { modelSupportsImageInput } from "../utils/inspect-media-mode";
import {
	type LoadedMediaFileInput,
	loadMediaFileInput,
	MediaInputTooLargeError,
	supportedMediaFormats,
} from "../utils/media-loading";
import type { ToolSession } from "./index";
import { resolveReadPath } from "./path-utils";
import { ToolError } from "./tool-errors";

async function detectFileMediaKind(path: string, cwd: string): Promise<MediaKind> {
	const resolvedPath = resolveReadPath(path, cwd);
	if (await readImageMetadata(resolvedPath)) return "image";
	const media = await readMediaMetadata(resolvedPath);
	if (media) return media.kind;
	throw new ToolError(
		`inspect_media supports images, audio, and video detected by file content. Supported formats: ${supportedMediaFormats()}.`,
	);
}

const inspectMediaSchema = type({
	path: type("string").describe("media file path, Image #N label, or attachment://N URI"),
	question: type("string").describe("question about the media"),
	"+": "reject",
});

type InspectMediaParams = typeof inspectMediaSchema.infer;

type MediaKind = "image" | "audio" | "video";

interface LoadedMedia {
	kind: MediaKind;
	resolvedPath: string;
	mimeType: string;
	data: string;
}

interface ImageAttachmentReference {
	index: number;
}

const IMAGE_ATTACHMENT_REFERENCE_REGEX =
	/^\s*(?:\[?Image #([1-9]\d*)(?:,[^\]\n]*)?\]?|(?:attachment|image):\/\/([1-9]\d*))\s*$/i;

function parseImageAttachmentReference(path: string): ImageAttachmentReference | null {
	const match = IMAGE_ATTACHMENT_REFERENCE_REGEX.exec(path);
	if (!match) return null;
	const rawIndex = match[1] ?? match[2];
	if (!rawIndex) return null;
	return { index: Number(rawIndex) };
}

function formatAvailableImageAttachments(attachments: readonly { label: string; uri: string }[]): string {
	if (attachments.length === 0) return "none";
	return attachments.map(attachment => `${attachment.label} -> ${attachment.uri}`).join(", ");
}

async function loadAttachmentReferenceInput(options: {
	path: string;
	reference: ImageAttachmentReference;
	attachments: readonly { label: string; uri: string; image: ImageContent }[];
	autoResize: boolean;
	excludeWebP: boolean | undefined;
}): Promise<LoadedMedia | null> {
	const attachment = options.attachments[options.reference.index - 1];
	if (!attachment) {
		const available = formatAvailableImageAttachments(options.attachments);
		if (options.attachments.length === 0) {
			throw new ToolError(
				`No image attachments are available in this turn. path="${options.path}" must be a readable file path or attachment URI.`,
			);
		}
		throw new ToolError(
			`Could not resolve image attachment '${options.path}'. Available image attachments: ${available}. Pass an attachment URI or a readable filesystem path.`,
		);
	}
	const loaded = await loadImageAttachmentInput({
		image: attachment.image,
		label: attachment.label,
		uri: attachment.uri,
		autoResize: options.autoResize,
		maxBytes: MAX_IMAGE_INPUT_BYTES,
		excludeWebP: options.excludeWebP,
	});
	if (!loaded) return null;
	return { kind: "image", resolvedPath: loaded.resolvedPath, mimeType: loaded.mimeType, data: loaded.data };
}

interface InspectMediaToolDetails {
	model: string;
	mediaPath: string;
	mimeType: string;
}

export class InspectMediaTool implements AgentTool<typeof inspectMediaSchema, InspectMediaToolDetails> {
	readonly name = "inspect_media";
	readonly label = "InspectMedia";
	readonly loadMode = "essential";
	readonly summary = "Describe or analyze an image, audio, or video file";
	readonly description: string;
	readonly parameters = inspectMediaSchema;
	readonly strict = false;

	readonly examples: readonly ToolExample<typeof inspectMediaSchema.infer>[] = [
		{
			caption: "OCR with strict formatting",
			call: {
				path: "screenshots/error.png",
				question: "Extract all visible text verbatim. Return as bullet list in reading order.",
			},
		},
		{
			caption: "Screenshot debugging",
			call: {
				path: "screenshots/settings.png",
				question:
					"Identify the likely cause of the disabled Save button. Return: (1) observations, (2) likely cause, (3) confidence.",
			},
		},
		{
			caption: "Audio transcription check",
			call: {
				path: "recordings/interview.mp3",
				question:
					"List the distinct speakers and quote one verbatim sentence per speaker. Mark inaudible segments.",
			},
		},
		{
			caption: "Video scene question",
			call: {
				path: "captures/demo.mp4",
				question: "Describe the UI flow shown: each screen, the action taken, and the order they appear.",
			},
		},
	];

	constructor(
		private readonly session: ToolSession,
		private readonly completeMediaRequest: typeof completeSimple = completeSimple,
	) {
		this.description = prompt.render(inspectMediaDescription);
	}

	async execute(
		_toolCallId: string,
		params: InspectMediaParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<InspectMediaToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<InspectMediaToolDetails>> {
		const modelRegistry = this.session.modelRegistry;
		if (!modelRegistry) {
			throw new ToolError("Model registry is unavailable for inspect_media.");
		}

		const availableModels = modelRegistry.getAvailable();
		if (availableModels.length === 0) {
			throw new ToolError("No models available for inspect_media.");
		}

		const matchPreferences = getModelMatchPreferences(this.session.settings);
		const resolvePattern = (pattern: string | undefined): Model<Api> | undefined => {
			if (!pattern) return undefined;
			const expanded = expandRoleAlias(pattern, this.session.settings);
			return resolveModelFromString(expanded, availableModels, matchPreferences);
		};

		const activeModelPattern = this.session.getActiveModelString?.() ?? this.session.getModelString?.();
		const candidates: { model: Model<Api>; pattern: string | undefined }[] = [];
		for (const pattern of ["@vision", "@default", activeModelPattern]) {
			const resolved = resolvePattern(pattern);
			if (resolved && !candidates.some(candidate => candidate.model === resolved)) {
				candidates.push({ model: resolved, pattern });
			}
		}
		if (candidates.length === 0) {
			candidates.push({ model: availableModels[0]!, pattern: undefined });
		}
		const model = candidates[0]!.model;
		if (!model) {
			throw new ToolError("Unable to resolve a model for inspect_media.");
		}

		const attachmentReference = parseImageAttachmentReference(params.path);
		let kind: MediaKind;
		if (attachmentReference) {
			kind = "image";
		} else {
			kind = await detectFileMediaKind(params.path, this.session.cwd);
		}

		if (kind === "image" && this.session.settings.get("images.blockImages")) {
			throw new ToolError(
				"Image submission is disabled by settings (images.blockImages=true). Disable it to inspect images with inspect_media.",
			);
		}

		// The active model reads images natively -> hand the image itself to the
		// conversation instead of round-tripping a lossy description through a
		// side completion. Audio/video and text-only actives keep the side model.
		const activeModel = this.session.getActiveModel?.();
		if (kind === "image" && modelSupportsImageInput(activeModel)) {
			const inlineModel = activeModel!;
			let inlineInput: LoadedMedia | null;
			try {
				if (attachmentReference) {
					inlineInput = await loadAttachmentReferenceInput({
						path: params.path,
						reference: attachmentReference,
						attachments: this.session.getImageAttachments?.() ?? [],
						autoResize: this.session.settings.get("images.autoResize"),
						excludeWebP: webpExclusionForModel(inlineModel),
					});
				} else {
					const loaded: LoadedImageInput | null = await loadImageInput({
						path: params.path,
						cwd: this.session.cwd,
						autoResize: this.session.settings.get("images.autoResize"),
						maxBytes: MAX_IMAGE_INPUT_BYTES,
						excludeWebP: webpExclusionForModel(inlineModel),
					});
					inlineInput = loaded
						? { kind: "image", resolvedPath: loaded.resolvedPath, mimeType: loaded.mimeType, data: loaded.data }
						: null;
				}
			} catch (error) {
				if (error instanceof ImageInputTooLargeError) {
					throw new ToolError(error.message);
				}
				throw error;
			}
			if (!inlineInput) {
				throw new ToolError(
					"inspect_media could not decode the file as a supported image (PNG, JPEG, GIF, or WEBP detected by file content).",
				);
			}
			return {
				content: [
					{
						type: "text",
						text: `Image attached below (${inlineInput.mimeType}); analyze it directly to answer the question.`,
					},
					{ type: "image", data: inlineInput.data, mimeType: inlineInput.mimeType },
				],
				details: {
					model: `${inlineModel.provider}/${inlineModel.id}`,
					mediaPath: inlineInput.resolvedPath,
					mimeType: inlineInput.mimeType,
				},
			};
		}

		const supporting = candidates.find(candidate => candidate.model.input.includes(kind));
		const selected = supporting ?? candidates[0]!;
		const selectedModel = selected.model;
		const selectedPattern = selected.pattern;

		if (!selectedModel.input.includes(kind)) {
			if (kind === "image") {
				throw new ToolError(
					`Resolved model ${selectedModel.provider}/${selectedModel.id} does not support image input. Configure a vision-capable model for modelRoles.vision.`,
				);
			}
			throw new ToolError(
				`Resolved model ${selectedModel.provider}/${selectedModel.id} does not support ${kind} input. Configure a model with ${kind} input support (e.g. via modelRoles) and retry.`,
			);
		}

		const apiKey = await modelRegistry.getApiKey(selectedModel);
		if (!apiKey) {
			throw new ToolError(
				`No API key available for ${selectedModel.provider}/${selectedModel.id}. Configure credentials for this provider or choose another ${kind}-capable model.`,
			);
		}

		let mediaInput: LoadedMedia | null;
		try {
			if (attachmentReference) {
				mediaInput = await loadAttachmentReferenceInput({
					path: params.path,
					reference: attachmentReference,
					attachments: this.session.getImageAttachments?.() ?? [],
					autoResize: this.session.settings.get("images.autoResize"),
					excludeWebP: webpExclusionForModel(selectedModel),
				});
			} else if (kind === "image") {
				const loaded: LoadedImageInput | null = await loadImageInput({
					path: params.path,
					cwd: this.session.cwd,
					autoResize: this.session.settings.get("images.autoResize"),
					maxBytes: MAX_IMAGE_INPUT_BYTES,
					excludeWebP: webpExclusionForModel(selectedModel),
				});
				mediaInput = loaded
					? { kind: "image", resolvedPath: loaded.resolvedPath, mimeType: loaded.mimeType, data: loaded.data }
					: null;
			} else {
				const loaded: LoadedMediaFileInput | null = await loadMediaFileInput({
					path: params.path,
					cwd: this.session.cwd,
				});
				mediaInput = loaded
					? {
							kind: loaded.kind,
							resolvedPath: loaded.resolvedPath,
							mimeType: loaded.mimeType,
							data: loaded.data,
						}
					: null;
			}
		} catch (error) {
			if (error instanceof ImageInputTooLargeError || error instanceof MediaInputTooLargeError) {
				throw new ToolError(error.message);
			}
			throw error;
		}

		if (!mediaInput) {
			if (kind === "image") {
				throw new ToolError(
					"inspect_media could not decode the file as a supported image (PNG, JPEG, GIF, or WEBP detected by file content).",
				);
			}
			throw new ToolError(
				`inspect_media could not decode the file as supported media. Supported formats (detected by file content): ${supportedMediaFormats()}.`,
			);
		}

		const telemetry = resolveTelemetry(this.session.getTelemetry?.(), this.session.getSessionId?.() ?? undefined);
		const timeoutMs = this.session.settings.get("inspect_media.timeoutMs");
		const hasTimeout = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0;
		const timeoutSignal = hasTimeout ? AbortSignal.timeout(timeoutMs) : undefined;
		const effectiveSignal = timeoutSignal
			? signal
				? AbortSignal.any([signal, timeoutSignal])
				: timeoutSignal
			: signal;
		const timedOut = (): boolean => Boolean(timeoutSignal?.aborted) && !signal?.aborted;
		const formatTimeoutMessage = (): string => {
			const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}` : (timeoutMs / 1000).toFixed(1);
			return `inspect_media request timed out after ${seconds}s. Increase inspect_media.timeoutMs (currently ${timeoutMs}ms; 0 disables) or check the model provider.`;
		};

		const configuredThinking = extractExplicitThinkingSelector(selectedPattern, this.session.settings, {
			isLiteralModelId: (provider, id) =>
				availableModels.some(candidate => candidate.provider === provider && candidate.id === id),
		});
		const reasoning = toReasoningEffort(resolveThinkingLevelForModel(selectedModel, configuredThinking));

		const mediaPart: ImageContent | AudioContent | VideoContent = {
			type: mediaInput.kind,
			data: mediaInput.data,
			mimeType: mediaInput.mimeType,
		};

		let response: AssistantMessage;
		try {
			response = await instrumentedCompleteSimple(
				selectedModel,
				{
					systemPrompt: [prompt.render(inspectMediaSystemPromptTemplate)],
					messages: [
						{
							role: "user",
							content: [mediaPart, { type: "text", text: params.question }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: modelRegistry.resolver(selectedModel, this.session.getSessionId?.() ?? undefined),
					signal: effectiveSignal,
					reasoning,
				},
				{ telemetry, oneshotKind: "inspect_media", completeImpl: this.completeMediaRequest },
			);
		} catch (error) {
			if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
				if (timedOut()) throw new ToolError(formatTimeoutMessage());
			}
			throw error;
		}

		if (response.stopReason === "error") {
			throw new ToolError(response.errorMessage ?? "inspect_media request failed.");
		}
		if (response.stopReason === "aborted") {
			if (timedOut()) throw new ToolError(formatTimeoutMessage());
			throw new ToolError("inspect_media request aborted.");
		}

		const text = extractTextContent(response);
		if (!text) {
			throw new ToolError("inspect_media model returned no text output.");
		}

		return {
			content: [{ type: "text", text }],
			details: {
				model: `${selectedModel.provider}/${selectedModel.id}`,
				mediaPath: mediaInput.resolvedPath,
				mimeType: mediaInput.mimeType,
			},
		};
	}
}

export { inspectMediaToolRenderer } from "./inspect-media-renderer";
