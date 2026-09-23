import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { validateApiKeyAgainstModelsEndpoint } from "../api-key-validation";
import { OAuthCallbackFlow } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const AUTHORIZE_URL = "https://openrouter.ai/auth";
const KEY_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
// `/api/v1/models` answers 200 for any bearer; `/api/v1/auth/key` actually authenticates the key.
const KEY_INFO_URL = "https://openrouter.ai/api/v1/auth/key";
const API_KEY_PREFIX = "sk-or-";
const CALLBACK_PORT = 54549;
const CALLBACK_PATH = "/callback";

const NEVER_EXPIRES = 8.64e15;

export async function exchangeOpenRouterCode(
	code: string,
	codeVerifier: string,
	fetchImpl: FetchImpl = fetch,
	signal?: AbortSignal,
): Promise<string> {
	const response = await fetchImpl(KEY_EXCHANGE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code, code_verifier: codeVerifier, code_challenge_method: "S256" }),
		signal,
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new AIError.OAuthError(`OpenRouter key exchange failed: ${response.status} ${detail}`.trim(), {
			kind: "token-exchange",
			provider: "openrouter",
			status: response.status,
		});
	}
	const data = (await response.json()) as { key?: unknown };
	if (typeof data.key !== "string" || data.key.length === 0) {
		throw new AIError.OAuthError("OpenRouter key exchange returned an empty key", {
			kind: "validation",
			provider: "openrouter",
		});
	}
	return data.key;
}

// No client registration: the S256 PKCE verifier is the only proof of identity,
// and the minted `sk-or-…` key is durable.
export class OpenRouterOAuthFlow extends OAuthCallbackFlow {
	#verifier?: string;

	constructor(ctrl: OAuthController) {
		super(ctrl, CALLBACK_PORT, CALLBACK_PATH);
	}

	// OpenRouter never echoes `state`; an empty state disables callback-state validation.
	override generateState(): string {
		return "";
	}

	async generateAuthUrl(_state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const { verifier, challenge } = await generatePKCE();
		this.#verifier = verifier;
		const params = new URLSearchParams({
			callback_url: redirectUri,
			code_challenge: challenge,
			code_challenge_method: "S256",
		});
		return {
			url: `${AUTHORIZE_URL}?${params.toString()}`,
			instructions:
				"Authorize proto in your browser, or paste an existing OpenRouter API key (sk-or-…) when prompted. If the browser cannot reach this machine, paste the final redirect URL or authorization code instead.",
		};
	}

	async exchangeToken(code: string): Promise<OAuthCredentials> {
		// The manual-input race feeds pasted text through the code path, so a pasted
		// existing key skips the PKCE exchange once it validates.
		if (code.startsWith(API_KEY_PREFIX)) {
			await validateApiKeyAgainstModelsEndpoint({
				provider: "OpenRouter",
				apiKey: code,
				modelsUrl: KEY_INFO_URL,
				signal: this.ctrl.signal,
				fetch: this.ctrl.fetch,
			});
			return { access: code, refresh: "", expires: NEVER_EXPIRES };
		}
		if (!this.#verifier) {
			throw new AIError.OAuthError("OpenRouter PKCE verifier was not initialized", {
				kind: "configuration",
				provider: "openrouter",
			});
		}
		const key = await exchangeOpenRouterCode(code, this.#verifier, this.ctrl.fetch, this.ctrl.signal);
		return { access: key, refresh: "", expires: NEVER_EXPIRES };
	}
}

export async function loginOpenRouterOAuth(ctrl: OAuthController): Promise<OAuthCredentials> {
	const flow = new OpenRouterOAuthFlow(ctrl);
	return flow.login();
}
