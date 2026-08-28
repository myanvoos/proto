import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { $env } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";

const DEFAULT_BASE_URL = "https://api.x.ai/v1";

interface XAICredentials {
	provider: "xai-oauth" | "xai";
	apiKey: string;
	baseURL: string;
}

export type XAIHttpProvider = "xai-oauth" | "xai";

export interface XAIHttpTransport {
	baseURL: string;
	headers?: Record<string, string>;
}

function resolveXAIBaseURL(
	modelRegistry: ModelRegistry,
	provider: XAIHttpProvider,
	modelId: string | undefined,
): string {
	if (modelId) {
		const merged = modelRegistry.getAll().find(m => m.id === modelId && m.provider === provider);
		if (merged?.baseUrl) {
			const bundled = getBundledModels(provider as Parameters<typeof getBundledModels>[0]).find(
				m => m.id === modelId,
			);
			const providerDefault = bundled?.baseUrl ?? DEFAULT_BASE_URL;
			if (merged.baseUrl !== providerDefault) {
				return merged.baseUrl.replace(/\/$/, "");
			}
		}
	}
	const providerBaseUrl = modelRegistry.getProviderBaseUrl(provider);
	if (providerBaseUrl) {
		const normalized = providerBaseUrl.replace(/\/$/, "");
		if (normalized !== DEFAULT_BASE_URL) return normalized;
	}
	return ($env.XAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
}

export function resolveXAIHttpTransport(
	modelRegistry: ModelRegistry,
	provider: XAIHttpProvider,
	modelId?: string,
): XAIHttpTransport {
	return {
		baseURL: resolveXAIBaseURL(modelRegistry, provider, modelId),
		headers:
			(modelId ? modelRegistry.find(provider, modelId)?.headers : undefined) ??
			modelRegistry.getProviderHeaders(provider),
	};
}

export async function resolveXAIHttpCredentials(
	modelRegistry: ModelRegistry,
	modelId?: string,
): Promise<XAICredentials | null> {
	const hasDedicatedXaiOAuth =
		modelRegistry.authStorage.hasNonEnvCredential("xai-oauth") || Boolean($env.XAI_OAUTH_TOKEN);
	if (hasDedicatedXaiOAuth) {
		const oauthKey = await modelRegistry.getApiKeyForProvider("xai-oauth");
		if (oauthKey) {
			const baseURL = resolveXAIBaseURL(modelRegistry, "xai-oauth", modelId);
			return { provider: "xai-oauth", apiKey: oauthKey, baseURL };
		}
	}

	const apiKey = await modelRegistry.getApiKeyForProvider("xai");
	if (apiKey) {
		const baseURL = resolveXAIBaseURL(modelRegistry, "xai", modelId);
		return { provider: "xai", apiKey, baseURL };
	}

	return null;
}
