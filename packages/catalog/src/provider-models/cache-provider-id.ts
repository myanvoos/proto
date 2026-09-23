import { CHARM_HYPER_API_BASE_URL, normalizeCharmHyperBaseUrl } from "../wire/charm-hyper";
import { CODEX_CLIENT_VERSION } from "../wire/codex";
import { PERSONAL_GITHUB_COPILOT_BASE_URL } from "../wire/github-copilot";
import {
	normalizeSingularityApiBaseUrl,
	SINGULARITYAPI_DEV_API_BASE_URL,
	SINGULARITYAPI_TECH_API_BASE_URL,
} from "../wire/singularityapi";

export interface ModelCacheProviderIdOptions {
	apiKey?: string;
	baseUrl?: string;
}

const CREDENTIAL_SCOPED_MODEL_CACHE_PROVIDERS: Readonly<Record<string, true>> = {
	"opencode-go": true,
	"opencode-zen": true,
	"github-copilot": true,
	"muse-code": true,
	"singularityapi-dev": true,
	"singularityapi-tech": true,
};

export function isCredentialScopedModelCacheProvider(providerId: string): boolean {
	return CREDENTIAL_SCOPED_MODEL_CACHE_PROVIDERS[providerId] === true;
}

export function getDefaultModelDiscoveryBaseUrl(providerId: string): string | undefined {
	switch (providerId) {
		case "charm-hyper":
			return CHARM_HYPER_API_BASE_URL;
		case "meta":
		case "muse-code":
			return "https://api.meta.ai/v1";
		case "ollama":
			return "http://127.0.0.1:11434";
		case "litellm":
			return Bun.env.LITELLM_BASE_URL ?? "http://localhost:4000/v1";
		case "opencode-go":
			return "https://opencode.ai/zen/go/v1";
		case "opencode-zen":
			return "https://opencode.ai/zen/v1";
		case "vllm":
			return "http://127.0.0.1:8000/v1";
		default:
			return undefined;
	}
}

export function resolveOllamaModelCacheProviderId(providerId: string, baseUrl?: string): string {
	const defaultBaseUrl = getDefaultModelDiscoveryBaseUrl("ollama")!;
	let endpoint = defaultBaseUrl;
	try {
		const parsed = new URL(baseUrl ?? defaultBaseUrl);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		const nativePath = trimmedPath.endsWith("/v1") ? trimmedPath.slice(0, -3) : trimmedPath;
		endpoint = `${parsed.protocol}//${parsed.host}${nativePath}`;
	} catch {}
	return `${providerId}:ollama-models-v1:${Bun.hash(endpoint).toString(36)}`;
}

export function resolveModelCacheProviderId(providerId: string, options: ModelCacheProviderIdOptions = {}): string {
	switch (providerId) {
		case "openai-codex":
			return `${providerId}:${CODEX_CLIENT_VERSION}`;
		case "ollama":
			return resolveOllamaModelCacheProviderId(providerId, options.baseUrl);
		case "cursor":
			return "cursor:default-effort-v4";
		case "charm-hyper":
			// Endpoint-only: `/v1/models` is public (roster does not vary by key) and the registry resolves this
			// namespace without a credential. Normalized because the registry passes the raw configured value.
			return `charm-hyper:models-v1:${Bun.hash(normalizeCharmHyperBaseUrl(options.baseUrl)).toString(36)}`;
		case "gmi-cloud":
		case "siliconflow":
		case "siliconflow-cn":
			// models-v1 retires rows enriched before cross-provider reference isolation.
			return `${providerId}:models-v1`;
		case "litellm": {
			const baseUrl = options.baseUrl ?? getDefaultModelDiscoveryBaseUrl(providerId)!;
			return `litellm:rich-v11:${Bun.hash(baseUrl).toString(36)}`;
		}
		case "opencode-go":
		case "opencode-zen": {
			const configuredBaseUrl = options.baseUrl ?? getDefaultModelDiscoveryBaseUrl(providerId)!;
			const trimmedBaseUrl = configuredBaseUrl.endsWith("/") ? configuredBaseUrl.slice(0, -1) : configuredBaseUrl;
			const discoveryBaseUrl = trimmedBaseUrl.endsWith("/v1") ? trimmedBaseUrl : `${trimmedBaseUrl}/v1`;
			const scope = `${options.apiKey ?? ""}\u0000${discoveryBaseUrl}`;
			return `${providerId}:models-v3:${Bun.hash(scope).toString(36)}`;
		}
		case "github-copilot": {
			// v2: rows cached before the cross-provider routing strip can inherit another
			// provider's wire ids (e.g. enterprise-only `gpt-5.6-sol-fast` pinned to Cursor's
			// `-none-fast`); any enterprise-only sibling can, so version the namespace.
			const baseUrl = options.baseUrl ?? PERSONAL_GITHUB_COPILOT_BASE_URL;
			const scope = `${options.apiKey ?? ""}\u0000${baseUrl}`;
			return `github-copilot:models-v2:${Bun.hash(scope).toString(36)}`;
		}
		case "muse-code": {
			// The roster is scoped to the subscription-minted key.
			const baseUrl = options.baseUrl ?? getDefaultModelDiscoveryBaseUrl(providerId)!;
			const scope = `${options.apiKey ?? ""}\u0000${baseUrl}`;
			return `muse-code:models-v1:${Bun.hash(scope).toString(36)}`;
		}
		case "singularityapi-dev":
		case "singularityapi-tech": {
			// Rosters are issued per key; the provider-id prefix keeps both products apart behind one proxy.
			const canonical =
				providerId === "singularityapi-tech" ? SINGULARITYAPI_TECH_API_BASE_URL : SINGULARITYAPI_DEV_API_BASE_URL;
			const baseUrl = normalizeSingularityApiBaseUrl(options.baseUrl, canonical);
			const scope = `${options.apiKey ?? ""}\u0000${baseUrl}`;
			return `${providerId}:models-v1:${Bun.hash(scope).toString(36)}`;
		}
		case "openrouter":
			return "openrouter:pseudo-api";
		case "vllm": {
			const baseUrl = options.baseUrl ?? getDefaultModelDiscoveryBaseUrl(providerId)!;
			return `vllm:models-v2:${Bun.hash(baseUrl).toString(36)}`;
		}
		default:
			return providerId;
	}
}
