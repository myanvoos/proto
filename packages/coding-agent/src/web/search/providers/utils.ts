import type { AgentStorage } from "../../../session/agent-storage";
import { readBoundedText } from "../../../tools/fetch";
import {
	DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	SearchProviderError,
	type SearchProviderId,
	type SearchSource,
} from "../../../web/search/types";
import { dateToAgeSeconds } from "../utils";

export function findCredential(
	storage: AgentStorage | null | undefined,
	envKey: string | null | undefined,
	...storageProviders: string[]
): string | null {
	if (envKey) return envKey;
	if (!storage) return null;

	try {
		for (const provider of storageProviders) {
			const records = storage.listAuthCredentials(provider);
			for (const record of records) {
				const credential = record.credential;
				if (credential.type === "api_key" && credential.key.trim().length > 0) {
					return credential.key;
				}
				if (credential.type === "oauth" && credential.access.trim().length > 0) {
					return credential.access;
				}
			}
		}
	} catch {
		return null;
	}

	return null;
}

export const SEARCH_HARD_TIMEOUT_MS = DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1_000;

const PROVIDER_DIAGNOSTIC_MAX_BYTES = 8 * 1024;
const PROVIDER_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

async function readProviderBody(
	response: Response,
	provider: SearchProviderId,
	maxBytes: number,
	kind: "diagnostic" | "response" | "HTML",
): Promise<string> {
	const text = await readBoundedText(response, maxBytes);
	if (text !== null) return text;
	const status = response.ok ? 502 : response.status;
	throw new SearchProviderError(provider, `${provider}: ${kind} body exceeded ${maxBytes} byte limit`, status);
}

export function readProviderErrorText(response: Response, provider: SearchProviderId): Promise<string> {
	return readProviderBody(response, provider, PROVIDER_DIAGNOSTIC_MAX_BYTES, "diagnostic");
}

export function readProviderResponseText(response: Response, provider: SearchProviderId): Promise<string> {
	return readProviderBody(response, provider, PROVIDER_RESPONSE_MAX_BYTES, "response");
}

export function readProviderHtml(response: Response, provider: SearchProviderId): Promise<string> {
	return readProviderBody(response, provider, PROVIDER_RESPONSE_MAX_BYTES, "HTML");
}

export function withHardTimeout(signal: AbortSignal | undefined, ms: number = SEARCH_HARD_TIMEOUT_MS): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function toSearchSources(
	sources: ReadonlyArray<{
		title: string;
		url: string;
		snippet?: string;
		publishedDate?: string;
	}>,
	numResults: number,
): SearchSource[] {
	return sources.slice(0, numResults).map(source => ({
		title: source.title,
		url: source.url,
		snippet: source.snippet,
		publishedDate: source.publishedDate,
		ageSeconds: dateToAgeSeconds(source.publishedDate),
	}));
}

const CREDIT_BODY_PATTERN = /credits?\s*(?:exhausted|exceeded)|quota|insufficient/i;

export function classifyProviderHttpError(
	provider: SearchProviderId,
	status: number,
	body: string,
): SearchProviderError | null {
	if (CREDIT_BODY_PATTERN.test(body)) {
		return new SearchProviderError(provider, `${provider}: credits exhausted`, status);
	}
	if (status === 402) {
		return new SearchProviderError(provider, `${provider}: 402 credits exhausted`, status);
	}
	if (status === 401) {
		return new SearchProviderError(provider, `${provider}: 401 unauthorized`, status);
	}
	if (status === 403) {
		return new SearchProviderError(provider, `${provider}: 403 forbidden`, status);
	}
	return null;
}
