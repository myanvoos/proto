import { scheduler } from "node:timers/promises";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
	COPILOT_API_HEADERS,
	COPILOT_CHAT_INTEGRATION_ID,
	discoverGitHubCopilotApiEndpoint,
	getGitHubCopilotBaseUrl,
	isPublicGitHubHost,
	normalizeCopilotIntegrationId,
	normalizeDomain,
	normalizeGitHubCopilotEnterpriseDomain,
} from "@oh-my-pi/pi-catalog/wire/github-copilot";
import * as AIError from "../../error";
import {
	resolveCopilotIntegrationIdOverride,
	wrapFetchForCopilotFallback,
} from "../../providers/github-copilot-headers";
import type { FetchImpl } from "../../types";
import type { OAuthCredentials, OAuthPrompt } from "./types";

const OPENCODE_CLIENT_ID = "Ov23li8tweQw6odWQebz";
const COPILOT_CLI_CLIENT_ID = "Ov23ctDVkRmgkPke0Mmm";

// github.com uses the minimal-grant OpenCode app: GitHub's consent page shows each app's
// existing per-user grant, and orgs restricting OAuth apps block the Copilot CLI app's broad
// historic grant regardless of the requested scope. Private GitHub Enterprise instances run
// their own OAuth registry, which only knows the GitHub-owned Copilot CLI client. Tokens from
// either app work against the Copilot API.
function resolveOAuthClientId(domain: string): string {
	return isPublicGitHubHost(domain) ? OPENCODE_CLIENT_ID : COPILOT_CLI_CLIENT_ID;
}
const OAUTH_SCOPE = "read:user";
const OAUTH_HEADERS = {
	Accept: "application/json",
	"Content-Type": "application/x-www-form-urlencoded",
	"User-Agent": "copilot-developer-action/0.0.1",
} as const;

const INITIAL_POLL_INTERVAL_MULTIPLIER = 1.2;
const SLOW_DOWN_POLL_INTERVAL_MULTIPLIER = 1.4;

type GitHubCopilotLoginOptions = {
	onAuth: (url: string, instructions?: string) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	copilotIntegrationId?: unknown;
	signal?: AbortSignal;
	pollIntervalFloorMs?: number;
	pollIntervalScaleMs?: number;
	fetch?: FetchImpl;
};
type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
	expires_in: number;
};

type DeviceTokenSuccessResponse = {
	access_token: string;
	token_type?: string;
	scope?: string;
};

type DeviceTokenErrorResponse = {
	error: string;
	error_description?: string;
	interval?: number;
};

function getUrls(domain: string): {
	deviceCodeUrl: string;
	accessTokenUrl: string;
} {
	return {
		deviceCodeUrl: `https://${domain}/login/device/code`,
		accessTokenUrl: `https://${domain}/login/oauth/access_token`,
	};
}

async function fetchJson(url: string, init: RequestInit, fetchImpl: FetchImpl): Promise<unknown> {
	const response = await fetchImpl(url, init);
	if (!response.ok) {
		const text = await response.text();
		throw new AIError.ProviderHttpError(`${response.status} ${response.statusText}: ${text}`, response.status);
	}
	return response.json();
}

async function startDeviceFlow(domain: string, fetchImpl: FetchImpl): Promise<DeviceCodeResponse> {
	const urls = getUrls(domain);
	const data = await fetchJson(
		urls.deviceCodeUrl,
		{
			method: "POST",
			headers: OAUTH_HEADERS,
			body: new URLSearchParams({
				client_id: resolveOAuthClientId(domain),
				scope: OAUTH_SCOPE,
			}),
		},
		fetchImpl,
	);

	if (!data || typeof data !== "object") {
		throw new AIError.OAuthError("Invalid device code response", { kind: "validation", provider: "github-copilot" });
	}

	const deviceCode = (data as Record<string, unknown>).device_code;
	const userCode = (data as Record<string, unknown>).user_code;
	const verificationUri = (data as Record<string, unknown>).verification_uri;
	const interval = (data as Record<string, unknown>).interval;
	const expiresIn = (data as Record<string, unknown>).expires_in;

	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		typeof interval !== "number" ||
		typeof expiresIn !== "number"
	) {
		throw new AIError.OAuthError("Invalid device code response fields", {
			kind: "validation",
			provider: "github-copilot",
		});
	}

	return {
		device_code: deviceCode,
		user_code: userCode,
		verification_uri: verificationUri,
		interval,
		expires_in: expiresIn,
	};
}

async function pollForGitHubAccessToken(
	domain: string,
	deviceCode: string,
	intervalSeconds: number,
	expiresIn: number,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
	pollIntervalFloorMs = 1000,
	pollIntervalScaleMs = 1000,
) {
	const urls = getUrls(domain);
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(pollIntervalFloorMs, Math.floor(intervalSeconds * pollIntervalScaleMs));
	let intervalMultiplier = INITIAL_POLL_INTERVAL_MULTIPLIER;
	let slowDownResponses = 0;

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new AIError.LoginCancelledError();
		}

		const remainingMs = deadline - Date.now();
		const waitMs = Math.min(Math.ceil(intervalMs * intervalMultiplier), remainingMs);
		try {
			await scheduler.wait(waitMs, { signal });
		} catch {
			throw new AIError.LoginCancelledError();
		}

		const raw = await fetchJson(
			urls.accessTokenUrl,
			{
				method: "POST",
				headers: OAUTH_HEADERS,
				body: new URLSearchParams({
					client_id: resolveOAuthClientId(domain),
					device_code: deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
			},
			fetchImpl,
		);

		if (raw && typeof raw === "object" && typeof (raw as DeviceTokenSuccessResponse).access_token === "string") {
			return (raw as DeviceTokenSuccessResponse).access_token;
		}

		if (raw && typeof raw === "object" && typeof (raw as DeviceTokenErrorResponse).error === "string") {
			const { error, error_description: description, interval } = raw as DeviceTokenErrorResponse;
			if (error === "authorization_pending") {
				continue;
			}

			if (error === "slow_down") {
				slowDownResponses += 1;
				intervalMs =
					typeof interval === "number" && interval > 0
						? Math.max(pollIntervalFloorMs, interval * pollIntervalScaleMs)
						: Math.max(pollIntervalFloorMs, intervalMs + 5 * pollIntervalScaleMs);
				intervalMultiplier = SLOW_DOWN_POLL_INTERVAL_MULTIPLIER;
				continue;
			}

			const descriptionSuffix = description ? `: ${description}` : "";
			throw new AIError.OAuthError(`Device flow failed: ${error}${descriptionSuffix}`, {
				kind: "polling",
				provider: "github-copilot",
			});
		}
	}

	if (slowDownResponses > 0) {
		throw new AIError.OAuthError(
			"Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.",
			{ kind: "timeout", provider: "github-copilot" },
		);
	}

	throw new AIError.OAuthError("Device flow timed out", { kind: "timeout", provider: "github-copilot" });
}

const FAR_FUTURE_MS = Date.now() + 10 * 365.25 * 24 * 60 * 60 * 1000;

export function refreshGitHubCopilotToken(
	refreshToken: string,
	enterpriseDomain?: string,
	apiEndpoint?: string,
): OAuthCredentials {
	return {
		refresh: refreshToken,
		access: refreshToken,
		expires: FAR_FUTURE_MS,
		enterpriseUrl: enterpriseDomain,
		apiEndpoint,
	};
}

async function enableGitHubCopilotModel(
	token: string,
	modelId: string,
	fetchImpl: FetchImpl,
	enterpriseDomain: string | undefined,
	apiEndpoint: string | undefined,
	integrationId: string | undefined,
): Promise<boolean> {
	const baseUrl = apiEndpoint ?? getGitHubCopilotBaseUrl(enterpriseDomain);
	const url = `${baseUrl}/models/${modelId}/policy`;

	try {
		const response = await fetchImpl(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				...COPILOT_API_HEADERS,
				"Copilot-Integration-Id": integrationId ?? COPILOT_CHAT_INTEGRATION_ID,
				"Openai-Intent": "chat-policy",
				"X-Initiator": "user",
				"X-Interaction-Type": "chat-policy",
			},
			body: JSON.stringify({ state: "enabled" }),
		});
		return response.ok;
	} catch {
		return false;
	}
}

async function enableAllGitHubCopilotModels(
	token: string,
	enterpriseDomain: string | undefined,
	apiEndpoint: string | undefined,
	fetchImpl: FetchImpl,
	onProgress?: (model: string, success: boolean) => void,
	integrationId?: unknown,
): Promise<void> {
	const wireModelIds = [...new Set(getBundledModels("github-copilot").map(model => model.requestModelId ?? model.id))];
	const resolvedId = normalizeCopilotIntegrationId(integrationId) ?? resolveCopilotIntegrationIdOverride();
	const copilotFetch = wrapFetchForCopilotFallback(fetchImpl, true, resolvedId);
	const BATCH_SIZE = 5;
	for (let i = 0; i < wireModelIds.length; i += BATCH_SIZE) {
		const batch = wireModelIds.slice(i, i + BATCH_SIZE);
		await Promise.all(
			batch.map(async modelId => {
				const success = await enableGitHubCopilotModel(
					token,
					modelId,
					copilotFetch,
					enterpriseDomain,
					apiEndpoint,
					resolvedId,
				);
				onProgress?.(modelId, success);
			}),
		);
	}
}

export async function loginGitHubCopilot(options: GitHubCopilotLoginOptions): Promise<OAuthCredentials> {
	const fetchImpl = options.fetch ?? fetch;
	const input = await options.onPrompt({
		message: "GitHub Enterprise URL/domain (blank for github.com)",
		placeholder: "company.ghe.com",
		allowEmpty: true,
	});

	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	const trimmed = input.trim();
	const normalizedDomain = normalizeDomain(input);
	if (trimmed && !normalizedDomain) {
		throw new AIError.OAuthError("Invalid GitHub Enterprise URL/domain", {
			kind: "validation",
			provider: "github-copilot",
		});
	}
	const enterpriseDomain = normalizeGitHubCopilotEnterpriseDomain(normalizedDomain ?? undefined);
	const domain =
		normalizedDomain && isPublicGitHubHost(normalizedDomain) ? "github.com" : (normalizedDomain ?? "github.com");

	const device = await startDeviceFlow(domain, fetchImpl);
	options.onAuth(device.verification_uri, `Enter code: ${device.user_code}`);

	const githubAccessToken = await pollForGitHubAccessToken(
		domain,
		device.device_code,
		device.interval,
		device.expires_in,
		options.signal,
		fetchImpl,
		options.pollIntervalFloorMs,
		options.pollIntervalScaleMs,
	);

	const apiEndpoint = await discoverGitHubCopilotApiEndpoint(githubAccessToken, fetchImpl);

	const credentials: OAuthCredentials = {
		refresh: githubAccessToken,
		access: githubAccessToken,
		expires: FAR_FUTURE_MS,
		enterpriseUrl: enterpriseDomain ?? undefined,
		apiEndpoint,
	};

	options.onProgress?.("Enabling models...");
	await enableAllGitHubCopilotModels(
		githubAccessToken,
		enterpriseDomain ?? undefined,
		apiEndpoint,
		fetchImpl,
		undefined,
		options.copilotIntegrationId,
	);
	return credentials;
}
