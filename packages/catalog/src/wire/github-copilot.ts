import type { FetchImpl } from "../types";
import { isRecord } from "../utils";

const COPILOT_CLI_VERSION = "1.0.82";
const COPILOT_CLI_USER_AGENT = `copilot/${COPILOT_CLI_VERSION}`;

export const COPILOT_GITHUB_HEADERS = {
	"User-Agent": COPILOT_CLI_USER_AGENT,
} as const;

export const COPILOT_CAPI_IDENTITY_HEADERS = {
	...COPILOT_GITHUB_HEADERS,
	"Editor-Version": COPILOT_CLI_USER_AGENT,
	"Copilot-Integration-Id": "copilot-developer-cli",
	"Copilot-Harness-Id": "copilot-sdk",
	"Openai-Intent": "conversation-agent",
} as const;

// Chat and model-policy requests default to the chat surface: some Business orgs
// gate premium models per client surface and block the CLI identity. Discovery
// keeps the CLI identity above, which unlocks enterprise/experimental models.
export const COPILOT_CHAT_INTEGRATION_ID = "copilot-chat" as const;

export const COPILOT_API_VERSION = "2026-08-01" as const;

export const COPILOT_API_HEADERS = {
	...COPILOT_CAPI_IDENTITY_HEADERS,
	"X-GitHub-Api-Version": COPILOT_API_VERSION,
} as const;

export const COPILOT_DISCOVERY_HEADERS = {
	...COPILOT_API_HEADERS,
	"X-Initiator": "user",
} as const;

const MANAGED_COPILOT_HEADER_NAMES: Record<string, true> = {
	"user-agent": true,
	"editor-version": true,
	"copilot-integration-id": true,
	"copilot-harness-id": true,
	"openai-intent": true,
	"x-github-api-version": true,
	"x-initiator": true,
	"x-interaction-type": true,
};

/** Preserve model-specific headers while enforcing the current Copilot API identity. */
export function mergeCopilotApiHeaders(headers?: Readonly<Record<string, string>>): Record<string, string> {
	const merged: Record<string, string> = {};
	if (headers) {
		for (const name in headers) {
			const value = headers[name];
			if (value !== undefined && !MANAGED_COPILOT_HEADER_NAMES[name.toLowerCase()]) {
				merged[name] = value;
			}
		}
	}
	return { ...merged, ...COPILOT_API_HEADERS };
}

/** Validate an explicit `Copilot-Integration-Id`; blank or CR/LF-bearing values fall back to the default identity. */
export function normalizeCopilotIntegrationId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || /[\r\n]/.test(trimmed)) return undefined;
	return trimmed;
}

type GitHubCopilotApiKeyPayload = {
	token?: unknown;
	enterpriseUrl?: unknown;
	apiEndpoint?: unknown;
};

export type ParsedGitHubCopilotApiKey = {
	accessToken: string;
	enterpriseUrl?: string;
	apiEndpoint?: string;
};

const PUBLIC_GITHUB_HOSTS = new Set(["api.github.com", "github.com", "www.github.com"]);

export function isPublicGitHubHost(host: string): boolean {
	return PUBLIC_GITHUB_HOSTS.has(host.trim().toLowerCase());
}

export const PERSONAL_GITHUB_COPILOT_BASE_URL = "https://api.githubcopilot.com" as const;

export function isPersonalGitHubCopilotBaseUrl(baseUrl: string | undefined): boolean {
	return baseUrl === PERSONAL_GITHUB_COPILOT_BASE_URL;
}

export function normalizeGitHubCopilotEnterpriseDomain(input: string | undefined): string | undefined {
	const trimmed = input?.trim();
	if (!trimmed) return undefined;
	const normalized = normalizeDomain(trimmed) ?? trimmed.toLowerCase();
	if (!normalized || isPublicGitHubHost(normalized)) return undefined;
	return normalized;
}

export function normalizeGitHubCopilotApiEndpoint(input: string | undefined): string | undefined {
	const trimmed = input?.trim();
	if (!trimmed?.startsWith("https://")) return undefined;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "https:" || !url.hostname) return undefined;
		return trimmed.replace(/\/+$/, "");
	} catch {
		return undefined;
	}
}

export async function discoverGitHubCopilotApiEndpoint(
	token: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const response = await fetchImpl("https://api.github.com/copilot_internal/user", {
			headers: {
				Accept: "application/json",
				Authorization: `token ${token}`,
				...COPILOT_GITHUB_HEADERS,
			},
			signal,
		});
		if (!response.ok) return undefined;
		const data: unknown = await response.json();
		if (!isRecord(data) || !isRecord(data.endpoints)) return undefined;
		const endpoint = data.endpoints.api;
		return typeof endpoint === "string" ? normalizeGitHubCopilotApiEndpoint(endpoint) : undefined;
	} catch {
		return undefined;
	}
}

export function parseGitHubCopilotApiKey(apiKeyRaw: string): ParsedGitHubCopilotApiKey {
	try {
		const parsed = JSON.parse(apiKeyRaw) as GitHubCopilotApiKeyPayload;
		if (typeof parsed.token === "string") {
			return {
				accessToken: parsed.token,
				enterpriseUrl:
					typeof parsed.enterpriseUrl === "string"
						? normalizeGitHubCopilotEnterpriseDomain(parsed.enterpriseUrl)
						: undefined,
				apiEndpoint:
					typeof parsed.apiEndpoint === "string"
						? normalizeGitHubCopilotApiEndpoint(parsed.apiEndpoint)
						: undefined,
			};
		}
	} catch {}

	return { accessToken: apiKeyRaw };
}

export function normalizeDomain(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch {
		return null;
	}
}

export function getGitHubCopilotBaseUrl(enterpriseDomain?: string): string {
	const normalizedEnterpriseDomain = normalizeGitHubCopilotEnterpriseDomain(enterpriseDomain);
	if (!normalizedEnterpriseDomain) return "https://api.githubcopilot.com";
	const host = normalizedEnterpriseDomain.startsWith("copilot-api.")
		? normalizedEnterpriseDomain
		: `copilot-api.${normalizedEnterpriseDomain}`;
	return `https://${host}`;
}
