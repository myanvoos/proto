import {
	fitOutputTokensToContextWindow,
	type StreamFn,
	Tokenizer,
	tokenizerEncodingForModel,
} from "@oh-my-pi/pi-agent-core";
import { type SimpleStreamOptions, streamSimple } from "@oh-my-pi/pi-ai";
import { isAnthropicFableOrMythosModel } from "@oh-my-pi/pi-catalog/identity";
import type { Encoding } from "@oh-my-pi/pi-natives";
import { type Settings, validateProviderMaxInFlightRequests } from "../config/settings";

function timeoutSecondsToMs(value: number): number | undefined {
	if (!Number.isFinite(value) || value < 0) return undefined;
	if (value === 0) return 0;
	return Math.max(1, Math.trunc(value * 1000));
}

/**
 * Caller-supplied `streamOptions` always win; the helper only fills holes. The one exception is the output cap, which
 * is lowered when prompt plus cap would exceed the model's context window, for every request the session drives.
 */
export function createSettingsAwareStreamFn(settings: Settings, base: StreamFn = streamSimple): StreamFn {
	const tokenizers = new Map<Encoding | null, Tokenizer>();
	return (model, context, streamOptions) => {
		const openrouterRoutingPreset = settings.get("providers.openrouterVariant");
		const openrouterVariant =
			openrouterRoutingPreset && openrouterRoutingPreset !== "default" ? openrouterRoutingPreset : undefined;
		const antigravityEndpointMode = settings.get("providers.antigravityEndpoint");
		const textVerbosity =
			model.api === "openai-codex-responses"
				? settings.isConfigured("textVerbosity")
					? settings.get("textVerbosity")
					: undefined
				: model.api === "openai-responses"
					? settings.get("textVerbosity")
					: undefined;

		const cacheRetentionSetting = settings.get("providers.cacheRetention");
		const cacheRetention = cacheRetentionSetting === "auto" ? undefined : cacheRetentionSetting;
		const streamFirstEventTimeoutMs = timeoutSecondsToMs(settings.get("providers.streamFirstEventTimeoutSeconds"));
		const streamIdleTimeoutMs = timeoutSecondsToMs(settings.get("providers.streamIdleTimeoutSeconds"));

		const serverSideFallbackEnabled =
			settings.get("providers.anthropic.serverSideFallback") &&
			model.api === "anthropic-messages" &&
			model.provider === "anthropic" &&
			isAnthropicFableOrMythosModel(model.id);
		// Targets must be in the model's published `allowed_fallback_models`; Fable/Mythos 5 reject `claude-opus-5-5`.
		const fallbacks =
			streamOptions?.fallbacks ?? (serverSideFallbackEnabled ? [{ model: "claude-opus-5" }] : undefined);
		const encoding = tokenizerEncodingForModel(model);
		let tokenizer = tokenizers.get(encoding);
		if (!tokenizer) {
			tokenizer = new Tokenizer(model);
			tokenizers.set(encoding, tokenizer);
		}
		const merged: SimpleStreamOptions = {
			...streamOptions,
			maxTokens: fitOutputTokensToContextWindow(model, context, streamOptions?.maxTokens, tokenizer),
			openrouterVariant: streamOptions?.openrouterVariant ?? openrouterVariant,
			antigravityEndpointMode: streamOptions?.antigravityEndpointMode ?? antigravityEndpointMode,
			textVerbosity: streamOptions?.textVerbosity ?? textVerbosity,
			cacheRetention: streamOptions?.cacheRetention ?? cacheRetention,
			streamFirstEventTimeoutMs: streamOptions?.streamFirstEventTimeoutMs ?? streamFirstEventTimeoutMs,
			streamIdleTimeoutMs: streamOptions?.streamIdleTimeoutMs ?? streamIdleTimeoutMs,
			maxRetryDelayMs: streamOptions?.maxRetryDelayMs ?? settings.get("retry.maxDelayMs"),
			maxInFlightRequests: validateProviderMaxInFlightRequests(
				streamOptions?.maxInFlightRequests ?? settings.get("providers.maxInFlightRequests"),
			),
			loopGuard: {
				enabled: settings.get("model.loopGuard.enabled"),
				checkAssistantContent: settings.get("model.loopGuard.checkAssistantContent"),
				...streamOptions?.loopGuard,
			},
			hideThinkingSummary: streamOptions?.hideThinkingSummary ?? settings.get("omitThinking"),
			...(fallbacks !== undefined ? { fallbacks } : {}),
		};
		return base(model, context, merged);
	};
}
