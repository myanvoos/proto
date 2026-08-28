import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, Message, Model, SimpleStreamOptions, TextContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { validateProviderMaxInFlightRequests } from "../config/settings";
import type { LocalProtocolOptions } from "../internal-urls";
import { deobfuscateSessionContext, obfuscateMessages } from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { stripPendingSecretPlaceholderSuffix } from "../secrets/placeholder";
import { normalizeModelContextImages } from "../utils/image-loading";
import { describeAttachedImagesForTextModel } from "../utils/image-vision-fallback";
import { blobExtensionForImageMimeType } from "./blob-store";
import { type CustomMessage, convertToLlm } from "./messages";
import { IMAGE_ATTACHMENT_DESCRIPTION_TYPE } from "./queued-messages";
import type { BuildSessionContextOptions, SessionContext } from "./session-context";
import type { SessionManager } from "./session-manager";

type NormalizableContentBlock = AssistantMessage["content"][number] | TextContent | ImageContent;

export interface SessionProviderBoundaryHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	model(): Model | undefined;
	sessionId(): string;
	localProtocolOptions(): LocalProtocolOptions;
	transformContext(messages: AgentMessage[], signal?: AbortSignal): AgentMessage[] | Promise<AgentMessage[]>;
	convertToLlm(messages: AgentMessage[]): Message[] | Promise<Message[]>;
	onPayload: SimpleStreamOptions["onPayload"] | undefined;
	onResponse: SimpleStreamOptions["onResponse"] | undefined;
	onSseEvent: SimpleStreamOptions["onSseEvent"] | undefined;
	obfuscator: SecretObfuscator | undefined;
}

export class SessionProviderBoundary {
	readonly #host: SessionProviderBoundaryHost;

	constructor(host: SessionProviderBoundaryHost) {
		this.#host = host;
	}

	getImageAttachments(): { label: string; uri: string; image: ImageContent; sourcePath: string }[] {
		for (let i = this.#host.agent.state.messages.length - 1; i >= 0; i--) {
			const message = this.#host.agent.state.messages[i];
			if (!message || (message.role !== "user" && message.role !== "developer") || !Array.isArray(message.content)) {
				continue;
			}
			const images = message.content.filter((part): part is ImageContent => part.type === "image");
			if (images.length === 0) continue;
			return images.flatMap((image, index) => {
				const label = `Image #${index + 1}`;
				const uri = `attachment://${index + 1}`;
				try {
					const sourcePath = this.#host.sessionManager.putBlobSync(Buffer.from(image.data, "base64"), {
						extension: blobExtensionForImageMimeType(image.mimeType),
					}).displayPath;
					return [{ label, uri, image, sourcePath }];
				} catch (error) {
					logger.warn("failed to materialize image attachment; attachment omitted", {
						label,
						error: error instanceof Error ? error.message : String(error),
					});
					return [];
				}
			});
		}
		return [];
	}

	buildDisplaySessionContext(): SessionContext {
		return deobfuscateSessionContext(this.#host.sessionManager.buildSessionContext(), this.#host.obfuscator);
	}

	buildTranscriptSessionContext(
		options?: Pick<BuildSessionContextOptions, "collapseCompactedHistory" | "keepDanglingToolCalls">,
	): SessionContext {
		return deobfuscateSessionContext(
			this.#host.sessionManager.buildSessionContext({
				transcript: true,
				collapseCompactedHistory: options?.collapseCompactedHistory,
				keepDanglingToolCalls: options?.keepDanglingToolCalls,
			}),
			this.#host.obfuscator,
		);
	}

	obfuscateText(text: string | undefined): string | undefined {
		if (!text || !this.#host.obfuscator?.hasSecrets()) return text;
		return this.#host.obfuscator.obfuscate(text);
	}

	obfuscateCompactionPreparation(preparation: CompactionPreparation): CompactionPreparation {
		if (!this.#host.obfuscator?.hasSecrets()) return preparation;
		const previousSummary = this.obfuscateText(preparation.previousSummary);
		if (previousSummary === preparation.previousSummary) return preparation;
		return { ...preparation, previousSummary };
	}

	deobfuscateText(text: string): string {
		if (!this.#host.obfuscator?.hasSecrets()) return text;
		return this.#host.obfuscator.deobfuscate(text);
	}

	deobfuscateDelta(text: string): string {
		const deobfuscated = this.deobfuscateText(text);
		if (!this.#host.obfuscator?.hasSecrets()) return deobfuscated;
		return stripPendingSecretPlaceholderSuffix(deobfuscated);
	}

	convertToLlmForSideRequest(messages: AgentMessage[]): Message[] {
		const converted = convertToLlm(messages);
		return this.#host.obfuscator?.hasSecrets() ? obfuscateMessages(this.#host.obfuscator, converted) : converted;
	}

	async convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]> {
		const transformedMessages = await this.#host.transformContext(messages, signal);
		return await this.#host.convertToLlm(transformedMessages);
	}

	prepareSimpleStreamOptions(options: SimpleStreamOptions, provider = "anthropic"): SimpleStreamOptions {
		const sessionOnPayload = this.#host.onPayload;
		const sessionOnResponse = this.#host.onResponse;
		const sessionMetadata = this.#host.agent.metadataForProvider(provider);
		const sessionOnSseEvent = this.#host.onSseEvent;
		const openrouterRoutingPreset =
			provider === "openrouter" ? this.#host.settings.get("providers.openrouterVariant") : "default";
		const openrouterVariant =
			openrouterRoutingPreset !== "default" && options.openrouterVariant === undefined
				? openrouterRoutingPreset
				: undefined;
		const antigravityEndpointMode =
			provider === "google-antigravity" ? this.#host.settings.get("providers.antigravityEndpoint") : undefined;

		const preparedOptions: SimpleStreamOptions = {
			...options,
			...(openrouterVariant !== undefined && { openrouterVariant }),
			...(antigravityEndpointMode !== undefined && { antigravityEndpointMode }),
			maxInFlightRequests: validateProviderMaxInFlightRequests(
				options.maxInFlightRequests ?? this.#host.settings.get("providers.maxInFlightRequests"),
			),
			loopGuard: {
				enabled: this.#host.settings.get("model.loopGuard.enabled"),
				checkAssistantContent: this.#host.settings.get("model.loopGuard.checkAssistantContent"),
				...options.loopGuard,
			},
		};

		if (sessionMetadata && !options.metadata) {
			preparedOptions.metadata = sessionMetadata;
		}

		if (sessionOnPayload) {
			if (!options.onPayload) {
				preparedOptions.onPayload = sessionOnPayload;
			} else {
				const requestOnPayload = options.onPayload;
				preparedOptions.onPayload = async (payload, model) => {
					const sessionPayload = await sessionOnPayload(payload, model);
					const sessionResolvedPayload = sessionPayload ?? payload;
					const requestPayload = await requestOnPayload(sessionResolvedPayload, model);
					return requestPayload ?? sessionResolvedPayload;
				};
			}
		}

		if (sessionOnResponse) {
			if (!options.onResponse) {
				preparedOptions.onResponse = sessionOnResponse;
			} else {
				const requestOnResponse = options.onResponse;
				preparedOptions.onResponse = async (response, model) => {
					await sessionOnResponse(response, model);
					await requestOnResponse(response, model);
				};
			}
		}

		if (sessionOnSseEvent) {
			if (!options.onSseEvent) {
				preparedOptions.onSseEvent = sessionOnSseEvent;
			} else {
				const requestOnSseEvent = options.onSseEvent;
				preparedOptions.onSseEvent = (event, model) => {
					sessionOnSseEvent(event, model);
					requestOnSseEvent(event, model);
				};
			}
		}

		return preparedOptions;
	}

	normalizeImagesForModel(images: ImageContent[] | undefined): Promise<ImageContent[] | undefined> {
		return normalizeModelContextImages(images, { model: this.#host.model() });
	}

	async buildImageDescriptionNotice(
		normalizedImages: ImageContent[],
		signal?: AbortSignal,
	): Promise<CustomMessage | undefined> {
		const model = this.#host.model();
		const shouldDescribe =
			!!model &&
			!model.input.includes("image") &&
			!this.#host.settings.get("images.blockImages") &&
			this.#host.settings.get("images.describeForTextModels");
		if (!shouldDescribe || !model) return undefined;

		let blocks: TextContent[];
		try {
			blocks = await describeAttachedImagesForTextModel(
				normalizedImages,
				{
					activeModel: model,
					modelRegistry: this.#host.modelRegistry,
					settings: this.#host.settings,
					localProtocolOptions: this.#host.localProtocolOptions(),
					activeModelString: formatModelString(model),
					telemetryConfig: this.#host.agent.telemetry,
					sessionId: this.#host.sessionId(),
				},
				signal,
			);
		} catch (error) {
			logger.warn("image attachment vision fallback failed; image left undescribed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
		if (blocks.length === 0) return undefined;
		return {
			role: "custom",
			customType: IMAGE_ATTACHMENT_DESCRIPTION_TYPE,
			content: blocks,
			display: false,
			attribution: "user",
			timestamp: Date.now(),
		};
	}

	async normalizeAgentMessageImages<T extends AgentMessage>(message: T): Promise<T> {
		if (!("content" in message)) return message;
		const content = message.content;
		if (typeof content !== "string" && !Array.isArray(content)) return message;
		const normalized = await this.#normalizeMessageContentImages(content);
		if (normalized === content) return message;
		return Object.assign({}, message, { content: normalized });
	}

	async #normalizeMessageContentImages(
		content: string | NormalizableContentBlock[],
	): Promise<string | NormalizableContentBlock[]> {
		if (typeof content === "string") return content;
		const images = content.filter((part): part is ImageContent => part.type === "image");
		if (images.length === 0) return content;
		const normalizedImages = await this.normalizeImagesForModel(images);
		if (!normalizedImages) return content;
		let imageIndex = 0;
		return content.map(part => (part.type === "image" ? normalizedImages[imageIndex++]! : part));
	}
}
