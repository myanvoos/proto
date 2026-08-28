import * as AIError from "../../error";
import { extractGoogleValidationUrl, formatGoogleValidationRequiredMessage } from "../../utils/google-validation";
import { OAuthCallbackFlow } from "./callback-server";
import type { OAuthController, OAuthCredentials } from "./types";

export const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

export interface OAuthFetchOptions {
	provider: string;

	signal?: AbortSignal;

	timeoutMs?: number;
}

export function throwIfLoginCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new AIError.LoginCancelledError(`OAuth login cancelled: ${String(signal.reason)}`);
	}
}

export async function oauthFetch(
	url: string,
	init: RequestInit,
	{ provider, signal, timeoutMs = OAUTH_REQUEST_TIMEOUT_MS }: OAuthFetchOptions,
): Promise<Response> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		return await fetch(url, { ...init, signal: requestSignal });
	} catch (err) {
		if (signal?.aborted) {
			throw new AIError.LoginCancelledError(`OAuth login cancelled: ${String(signal.reason)}`);
		}
		if (timeoutSignal.aborted) {
			throw new AIError.OAuthError(`Timed out after ${timeoutMs}ms waiting for ${url}`, {
				kind: "timeout",
				provider,
			});
		}
		throw err;
	}
}

export interface GoogleOAuthFlowConfig {
	provider: string;
	clientId: string;
	clientSecret: string;
	authUrl: string;
	tokenUrl: string;
	scopes: string[];
	callbackPort: number;
	callbackPath: string;
	discoverProject: (
		accessToken: string,
		onProgress?: (message: string) => void,
		signal?: AbortSignal,
	) => Promise<string>;
}

async function getUserEmail(
	accessToken: string,
	provider: string,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	try {
		const response = await oauthFetch(
			"https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
			{ headers: { Authorization: `Bearer ${accessToken}` } },
			{ provider, signal },
		);

		if (response.ok) {
			const data = (await response.json()) as { email?: string };
			return data.email;
		}
	} catch {}
	return undefined;
}

export class GoogleOAuthFlow extends OAuthCallbackFlow {
	private readonly config: GoogleOAuthFlowConfig;

	constructor(ctrl: OAuthController, config: GoogleOAuthFlowConfig) {
		super(ctrl, {
			preferredPort: config.callbackPort,
			callbackPath: config.callbackPath,
			callbackHostname: "127.0.0.1",
		});
		this.config = config;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const authParams = new URLSearchParams({
			client_id: this.config.clientId,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: this.config.scopes.join(" "),
			state,
			access_type: "offline",
			prompt: "consent",
		});

		const url = `${this.config.authUrl}?${authParams.toString()}`;
		return { url, instructions: "Complete the sign-in in your browser." };
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		const { provider } = this.config;
		const signal = this.ctrl.signal;
		throwIfLoginCancelled(signal);
		this.ctrl.onProgress?.("Exchanging authorization code for tokens...");

		const tokenResponse = await oauthFetch(
			this.config.tokenUrl,
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: this.config.clientId,
					client_secret: this.config.clientSecret,
					code,
					grant_type: "authorization_code",
					redirect_uri: redirectUri,
				}),
			},
			{ provider, signal },
		);

		if (!tokenResponse.ok) {
			const error = await tokenResponse.text();
			throw new AIError.OAuthError(`Token exchange failed: ${error}`, { kind: "token-exchange", provider });
		}

		const tokenData = (await tokenResponse.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};

		if (!tokenData.refresh_token) {
			throw new AIError.OAuthError("No refresh token received. Please try again.", {
				kind: "validation",
				provider,
			});
		}

		throwIfLoginCancelled(signal);
		this.ctrl.onProgress?.("Getting user info...");
		const email = await getUserEmail(tokenData.access_token, provider, signal);
		throwIfLoginCancelled(signal);
		let projectId: string;
		try {
			projectId = await this.config.discoverProject(tokenData.access_token, this.ctrl.onProgress, signal);
		} catch (err) {
			const validationUrl = extractGoogleValidationUrl(err instanceof Error ? err.message : String(err));
			if (!validationUrl) throw err;
			throw new AIError.OAuthError(formatGoogleValidationRequiredMessage(validationUrl, "sign in again", email), {
				kind: "validation",
				provider,
			});
		}

		return {
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
			projectId,
			email,
		};
	}
}

export async function runGoogleOAuthLogin(
	ctrl: OAuthController,
	config: GoogleOAuthFlowConfig,
): Promise<OAuthCredentials> {
	const flow = new GoogleOAuthFlow(ctrl, config);
	return flow.login();
}
