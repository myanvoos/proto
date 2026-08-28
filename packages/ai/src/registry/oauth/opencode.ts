import * as AIError from "../../error";
import type { OAuthController } from "./types";

const AUTH_URL = "https://opencode.ai/auth";

const DEFAULT_PROVIDER_NAME = "OpenCode Zen";

export async function loginOpenCode(
	options: OAuthController,
	providerName: string = DEFAULT_PROVIDER_NAME,
): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError(providerName);
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: `Log in to the OpenCode Zen console and copy your ${providerName} API key`,
	});

	const apiKey = await options.onPrompt({
		message: `Paste your ${providerName} API key`,
		placeholder: "sk-...",
	});

	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new AIError.ApiKeyRequiredError();
	}

	return trimmed;
}
