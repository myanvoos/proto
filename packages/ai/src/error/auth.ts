import { attach, create, Flag } from "./flags";

export class MissingApiKeyError extends Error {
	readonly provider: string | undefined;

	constructor(provider?: string, message?: string) {
		super(message ?? (provider ? `No API key for provider: ${provider}` : "No API key available"));
		this.name = "MissingApiKeyError";
		this.provider = provider;
		attach(this, create(Flag.AuthFailed));
	}
}

export class OAuthRefreshUnavailableError extends Error {
	readonly provider: string;

	constructor(provider: string, cause: unknown) {
		super(
			`OAuth token refresh failed for provider ${provider}: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.name = "OAuthRefreshUnavailableError";
		this.provider = provider;
		attach(this, create(Flag.Transient));
	}
}

export class OnPromptRequiredError extends Error {
	constructor(providerLabel: string) {
		super(`${providerLabel} login requires onPrompt callback`);
		this.name = "OnPromptRequiredError";
	}
}

export class ApiKeyRequiredError extends Error {
	constructor(message = "API key is required") {
		super(message);
		this.name = "ApiKeyRequiredError";
	}
}

export class LoginCancelledError extends Error {
	constructor(message = "Login cancelled") {
		super(message);
		this.name = "LoginCancelledError";
		attach(this, create(Flag.Abort));
	}
}
