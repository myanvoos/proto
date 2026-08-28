import { getKimiCommonHeaders } from "../registry/oauth/kimi";
import type { Api, Context, Model } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type OpenAIAnthropicApiFormat,
	type OpenAIAnthropicShimOptions,
	streamOpenAIAnthropicShim,
} from "./openai-anthropic-shim";

export type KimiApiFormat = OpenAIAnthropicApiFormat;

export interface KimiOptions extends OpenAIAnthropicShimOptions {
	format?: KimiApiFormat;
}

export function streamKimi(
	model: Model<"openai-completions">,
	context: Context,
	options?: KimiOptions,
): AssistantMessageEventStream {
	return streamOpenAIAnthropicShim(model, context, options, {
		anthropicBaseUrl: model.baseUrl.replace(/\/v1\/?$/, ""),
		defaultFormat: model.compat.kimiApiFormat ?? "anthropic",
		anthropicThinkingMode: model.compat.thinkingFormat === "kimi" ? "anthropic-adaptive" : undefined,
		forwardCacheOptions: true,
		extraHeaders: getKimiCommonHeaders,
	});
}

export function isKimiModel(model: Model<Api>): boolean {
	return model.provider === "kimi-code";
}
