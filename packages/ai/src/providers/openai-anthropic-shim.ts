import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ANTHROPIC_THINKING, mapAnthropicToolChoice } from "../stream";
import type { Context, Model, ModelSpec, SimpleStreamOptions, ThinkingControlMode } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { createProviderErrorMessage } from "./error-message";
import { streamAnthropic, streamOpenAICompletions } from "./register-builtins";

export type OpenAIAnthropicApiFormat = "openai" | "anthropic";

export interface OpenAIAnthropicShimOptions extends SimpleStreamOptions {
	format?: OpenAIAnthropicApiFormat;
}

export interface OpenAIAnthropicShimConfig {
	anthropicBaseUrl: string;

	openaiBaseUrl?: string;

	defaultFormat: OpenAIAnthropicApiFormat;

	anthropicThinkingMode?: ThinkingControlMode;

	forwardCacheOptions?: boolean;

	extraHeaders?: () => Record<string, string>;
}

export function streamOpenAIAnthropicShim(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAIAnthropicShimOptions | undefined,
	config: OpenAIAnthropicShimConfig,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const format = options?.format ?? config.defaultFormat;

	const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;

	(async () => {
		try {
			const mergedHeaders = {
				...(config.extraHeaders?.() ?? {}),
				...options?.headers,
			};

			if (format === "anthropic") {
				const anthropicModel = buildModel({
					id: model.id,
					name: model.name,
					api: "anthropic-messages",
					provider: model.provider,
					baseUrl: config.anthropicBaseUrl,
					headers: mergedHeaders,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					reasoning: model.reasoning,
					...(config.anthropicThinkingMode && model.thinking
						? { thinking: { ...model.thinking, mode: config.anthropicThinkingMode } }
						: {}),
					input: model.input,
					cost: model.cost,
				} as ModelSpec<"anthropic-messages">);

				const reasoningEffort = options?.reasoning;
				const thinkingEnabled = !!reasoningEffort && model.reasoning && !options?.disableReasoning;
				const thinkingBudget = reasoningEffort
					? (options?.thinkingBudgets?.[reasoningEffort] ?? ANTHROPIC_THINKING[reasoningEffort])
					: undefined;

				const innerStream = streamAnthropic(anthropicModel, context, {
					apiKey,
					temperature: options?.temperature,
					topP: options?.topP,
					topK: options?.topK,
					minP: options?.minP,
					presencePenalty: options?.presencePenalty,
					repetitionPenalty: options?.repetitionPenalty,
					maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
					signal: options?.signal,
					headers: mergedHeaders,
					cacheRetention: config.forwardCacheOptions ? options?.cacheRetention : undefined,
					metadata: config.forwardCacheOptions ? options?.metadata : undefined,
					sessionId: options?.sessionId,
					promptCacheKey: options?.promptCacheKey,
					onPayload: options?.onPayload,
					onResponse: options?.onResponse,
					onSseEvent: options?.onSseEvent,
					fetch: options?.fetch,
					thinkingEnabled,
					thinkingBudgetTokens: thinkingBudget,
					reasoning: config.anthropicThinkingMode ? reasoningEffort : undefined,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					serviceTier: options?.serviceTier,
				});

				for await (const event of innerStream) {
					stream.push(event);
				}
			} else {
				const openaiModel: Model<"openai-completions"> = config.openaiBaseUrl
					? buildModel({
							...model,
							baseUrl: config.openaiBaseUrl,
							headers: mergedHeaders,
							compat: model.compatConfig,
						} as ModelSpec<"openai-completions">)
					: model;

				const reasoningEffort = options?.reasoning;
				const innerStream = streamOpenAICompletions(openaiModel, context, {
					apiKey,
					temperature: options?.temperature,
					topP: options?.topP,
					topK: options?.topK,
					minP: options?.minP,
					presencePenalty: options?.presencePenalty,
					repetitionPenalty: options?.repetitionPenalty,
					maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
					signal: options?.signal,
					headers: mergedHeaders,
					cacheRetention: config.forwardCacheOptions ? options?.cacheRetention : undefined,
					metadata: config.forwardCacheOptions ? options?.metadata : undefined,
					sessionId: options?.sessionId,
					promptCacheKey: options?.promptCacheKey,
					onPayload: options?.onPayload,
					onResponse: options?.onResponse,
					onSseEvent: options?.onSseEvent,
					fetch: options?.fetch,
					reasoning: reasoningEffort,
					toolChoice: options?.toolChoice,
					serviceTier: options?.serviceTier,
					disableReasoning: options?.disableReasoning,
				});

				for await (const event of innerStream) {
					stream.push(event);
				}
			}
		} catch (err) {
			stream.push({
				type: "error",
				reason: "error",
				error: createProviderErrorMessage(model, err),
			});
		}
	})();

	return stream;
}
