import * as AIError from "../error";
import {
	validateAnthropicCompatibleApiKey,
	validateApiKeyAgainstModelsEndpoint,
	validateOpenAICompatibleApiKey,
} from "./api-key-validation";
import type { OAuthController } from "./oauth/types";

type ChatCompletionsValidation = {
	kind: "chat-completions";
	provider: string;
	baseUrl: string;
	model: string;
};

type AnthropicMessagesValidation = {
	kind: "anthropic-messages";
	provider: string;
	baseUrl: string;
	model: string;
};

type ModelsEndpointValidation = {
	kind: "models-endpoint";
	provider: string;
	modelsUrl: string | (() => string);
	headers?: Record<string, string> | (() => Record<string, string> | undefined);
};

export type ApiKeyLoginConfig = {
	providerLabel: string;

	authUrl?: string;

	instructions?: string;

	promptMessage: string;

	placeholder: string;

	validation: ChatCompletionsValidation | AnthropicMessagesValidation | ModelsEndpointValidation | null;

	emptyKeyFallback?: string;
};

export function createApiKeyLogin(config: ApiKeyLoginConfig): (options: OAuthController) => Promise<string> {
	return async function login(options: OAuthController): Promise<string> {
		if (!options.onPrompt) {
			throw new AIError.OnPromptRequiredError(config.providerLabel);
		}

		if (config.authUrl && config.instructions) {
			options.onAuth?.({
				url: config.authUrl,
				instructions: config.instructions,
			});
		}

		const apiKey =
			config.emptyKeyFallback === undefined
				? await options.onPrompt({
						message: config.promptMessage,
						placeholder: config.placeholder,
					})
				: await options.onPrompt({
						message: config.promptMessage,
						placeholder: config.placeholder,
						allowEmpty: true,
					});

		if (options.signal?.aborted) {
			throw new AIError.LoginCancelledError();
		}

		const trimmed = apiKey.trim();
		if (!trimmed) {
			if (config.emptyKeyFallback !== undefined) {
				return config.emptyKeyFallback;
			}
			throw new AIError.ApiKeyRequiredError();
		}

		if (config.validation) {
			options.onProgress?.("Validating API key...");
			if (config.validation.kind === "chat-completions") {
				await validateOpenAICompatibleApiKey({
					provider: config.validation.provider,
					apiKey: trimmed,
					baseUrl: config.validation.baseUrl,
					model: config.validation.model,
					signal: options.signal,
					fetch: options.fetch,
				});
			} else if (config.validation.kind === "anthropic-messages") {
				await validateAnthropicCompatibleApiKey({
					provider: config.validation.provider,
					apiKey: trimmed,
					baseUrl: config.validation.baseUrl,
					model: config.validation.model,
					signal: options.signal,
					fetch: options.fetch,
				});
			} else {
				await validateApiKeyAgainstModelsEndpoint({
					provider: config.validation.provider,
					apiKey: trimmed,
					modelsUrl:
						typeof config.validation.modelsUrl === "function"
							? config.validation.modelsUrl()
							: config.validation.modelsUrl,
					headers: config.validation.headers,
					signal: options.signal,
					fetch: options.fetch,
				});
			}
		}

		return trimmed;
	};
}
