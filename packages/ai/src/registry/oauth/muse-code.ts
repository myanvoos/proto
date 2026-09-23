import { type } from "@oh-my-pi/omptype";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { isRecord } from "../../utils";
import { type OAuthDeviceCodePollResult, pollOAuthDeviceCodeFlow } from "./device-code";
import type { OAuthController, OAuthCredentials } from "./types";

const PROVIDER = "muse-code";
const CLIENT_ID = "1031625952748946";
const DEVICE_AUTHORIZATION_URL = "https://auth.meta.com/oidc/device/authorization/";
const DEVICE_TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
const MUSE_KEY_URL = "https://api.meta.ai/muse-code/key";
const API_VERSION = "1.0.0";
const REQUEST_TIMEOUT_MS = 20_000;
// Model requests use the minted subscription key, not the account token; Meta's device token omits expiry and
// rejects refresh_token grants, so the credential is durable.
const NEVER_EXPIRES = 8.64e15;

const subscriptionWindowSchema = type({
	"used_percent?": "number",
	"resets_at?": "string | number",
	"window_duration_mins?": "number",
});

const subscriptionUsageSchema = type({
	"window?": subscriptionWindowSchema.or("null"),
	"weekly?": subscriptionWindowSchema.or("null"),
});

const museCodeKeyResponseSchema = type({
	"api_key?": "string",
	"require_payment_action_url?": "string",
	"require_payment?": "boolean",
	"action_url?": "string | null",
	"user_email?": "string",
	"user_id?": "string",
	"is_subs_active?": "boolean",
	"subs_tier_id?": "string | null",
	"subs_tier_name?": "string | null",
	"subs_usage?": subscriptionUsageSchema.or("null"),
});
export type MuseCodeKeyResponse = typeof museCodeKeyResponseSchema.infer;

const museCodeCredentialSchema = type({
	oauthAccessToken: "string",
	apiKey: "string",
});
/** Meta account token plus the Model API key its Muse subscription minted, stored together as one OAuth access. */
export type MuseCodeCredential = typeof museCodeCredentialSchema.infer;

export interface MuseCodeRequestOptions {
	fetch?: FetchImpl;
	signal?: AbortSignal;
}

export interface MuseCodeKeyRequestOptions extends MuseCodeRequestOptions {
	/** Ask Meta to onboard the account during an interactive login exchange. */
	onboard?: boolean;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function parseMuseCodeCredential(value: string): MuseCodeCredential {
	let payload: unknown;
	try {
		payload = JSON.parse(value);
	} catch (cause) {
		throw new AIError.ConfigurationError("Muse Code credential is invalid; sign in again", { cause });
	}
	const parsed = museCodeCredentialSchema(payload);
	if (parsed instanceof type.errors || !parsed.oauthAccessToken.trim() || !parsed.apiKey.trim()) {
		throw new AIError.ConfigurationError("Muse Code credential is invalid; sign in again");
	}
	return parsed;
}

function encodeMuseCodeCredential(oauthAccessToken: string, apiKey: string): string {
	return JSON.stringify({ oauthAccessToken, apiKey } satisfies MuseCodeCredential);
}

export async function requestMuseCodeKey(
	accessToken: string,
	options: MuseCodeKeyRequestOptions = {},
): Promise<MuseCodeKeyResponse> {
	const response = await (options.fetch ?? fetch)(MUSE_KEY_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"x-api-version": API_VERSION,
		},
		body: JSON.stringify(options.onboard ? { onboard: true } : {}),
		redirect: "error",
		signal: requestSignal(options.signal),
	});
	const text = await response.text();
	if (!response.ok) {
		const excerpt = text.trim() ? ` ${text.slice(0, 500).trim()}` : "";
		throw new AIError.OAuthError(`Muse Code key exchange failed: ${response.status}${excerpt}`, {
			kind: "token-exchange",
			provider: PROVIDER,
			status: response.status,
		});
	}
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch (cause) {
		throw new AIError.OAuthError("Muse Code key exchange returned invalid JSON", {
			kind: "validation",
			provider: PROVIDER,
			status: response.status,
			cause,
		});
	}
	const parsed = museCodeKeyResponseSchema(payload);
	if (parsed instanceof type.errors) {
		throw new AIError.OAuthError(`Invalid Muse Code key response: ${parsed.summary}`, {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return parsed;
}

/** Exchange Meta account access for the Model API key authorized by a Muse subscription. */
export async function attachMuseCodeApiKey(
	credentials: OAuthCredentials,
	options: MuseCodeRequestOptions = {},
): Promise<OAuthCredentials> {
	const payload = await requestMuseCodeKey(credentials.access, { ...options, onboard: true });
	if (payload.is_subs_active === false) {
		throw new AIError.OAuthError("invalid_grant: Muse Code subscription is inactive", {
			kind: "token-exchange",
			provider: PROVIDER,
			status: 403,
		});
	}
	const apiKey = payload.api_key?.trim() || "";
	if (!apiKey) {
		const actionUrl = payload.action_url?.trim() || payload.require_payment_action_url?.trim();
		if (payload.require_payment === true || actionUrl) {
			throw new AIError.OAuthError(
				actionUrl ? `Muse Code subscription is required: ${actionUrl}` : "Muse Code subscription is required",
				{ kind: "entitlement", provider: PROVIDER },
			);
		}
		throw new AIError.OAuthError("Muse Code key response is missing api_key", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	const email = payload.user_email?.trim().toLowerCase();
	const accountId = payload.user_id?.trim() || email;
	if (!accountId) {
		throw new AIError.OAuthError("Muse Code key response is missing a stable account identity", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return {
		...credentials,
		access: encodeMuseCodeCredential(credentials.access, apiKey),
		accountId,
		email,
	};
}

async function postDeviceForm(
	url: string,
	params: Record<string, string>,
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
): Promise<{ response: Response; body: unknown }> {
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
				"x-api-version": API_VERSION,
			},
			body: new URLSearchParams(params).toString(),
			redirect: "error",
			signal: requestSignal(signal),
		});
	} catch (cause) {
		if (signal?.aborted) throw new AIError.LoginCancelledError();
		throw new AIError.OAuthError(
			`${PROVIDER} request to ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ kind: "device-auth", provider: PROVIDER, cause },
		);
	}
	const text = await response.text();
	let body: unknown;
	try {
		body = text ? JSON.parse(text) : undefined;
	} catch {
		body = text;
	}
	return { response, body };
}

function stringField(body: unknown, key: string): string | undefined {
	if (!isRecord(body)) return undefined;
	const value = body[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(body: unknown, key: string): number | undefined {
	if (!isRecord(body)) return undefined;
	const value = body[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function pollMuseCodeDeviceToken(
	deviceCode: string,
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
): Promise<OAuthDeviceCodePollResult<unknown>> {
	const { response, body } = await postDeviceForm(
		DEVICE_TOKEN_URL,
		{
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			client_id: CLIENT_ID,
			device_code: deviceCode,
		},
		fetchImpl,
		signal,
	);
	const error = stringField(body, "error");
	if (response.ok && error === undefined) return { status: "complete", value: body };
	switch (error) {
		case "authorization_pending":
			return { status: "pending" };
		case "slow_down":
			return { status: "slow_down" };
		case "expired_token":
			return { status: "failed", message: `${PROVIDER} device code expired; restart the login` };
		case "access_denied":
			return { status: "failed", message: `${PROVIDER} device authorization was denied` };
		default: {
			const detail = stringField(body, "error_description") ?? error ?? "";
			return {
				status: "failed",
				message: `${PROVIDER} device token request failed: ${response.status} ${detail}`.trim(),
			};
		}
	}
}

/** RFC 8628 device login against Meta's OIDC endpoints, then mint the subscription's Model API key. */
export async function loginMuseCode(ctrl: OAuthController): Promise<OAuthCredentials> {
	const fetchImpl = ctrl.fetch ?? fetch;
	const signal = ctrl.signal;
	ctrl.onProgress?.("Requesting device authorization...");
	const device = await postDeviceForm(DEVICE_AUTHORIZATION_URL, { client_id: CLIENT_ID }, fetchImpl, signal);
	if (!device.response.ok) {
		const detail = typeof device.body === "string" ? device.body : JSON.stringify(device.body);
		throw new AIError.OAuthError(`${PROVIDER} device authorization failed: ${device.response.status} ${detail}`, {
			kind: "device-auth",
			provider: PROVIDER,
			status: device.response.status,
		});
	}
	const userCode = stringField(device.body, "user_code");
	const deviceCode = stringField(device.body, "device_code");
	const verificationUri = stringField(device.body, "verification_uri");
	if (!userCode || !deviceCode || !verificationUri) {
		throw new AIError.OAuthError(`${PROVIDER} device authorization response missing required fields`, {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	ctrl.onAuth?.({
		url: stringField(device.body, "verification_uri_complete") ?? verificationUri,
		instructions: `Enter code: ${userCode}`,
	});
	ctrl.onProgress?.("Waiting for device authorization...");

	const token = await pollOAuthDeviceCodeFlow({
		poll: () => pollMuseCodeDeviceToken(deviceCode, fetchImpl, signal),
		intervalSeconds: numberField(device.body, "interval"),
		expiresInSeconds: numberField(device.body, "expires_in"),
		signal,
	});
	const access = stringField(token, "access_token");
	if (!access) {
		throw new AIError.OAuthError(`${PROVIDER} token response missing access token`, {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return attachMuseCodeApiKey(
		{ access, refresh: stringField(token, "refresh_token") ?? "", expires: NEVER_EXPIRES },
		{ fetch: fetchImpl, signal },
	);
}
