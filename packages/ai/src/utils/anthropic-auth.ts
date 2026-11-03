import { $env } from "@oh-my-pi/pi-utils";
import {
	buildAnthropicHeaders as buildProviderAnthropicHeaders,
	normalizeAnthropicBaseUrl,
	resolveAnthropicCustomHeadersForBaseUrl,
} from "../providers/anthropic";
import { mergeHeaders } from "../providers/inference-headers";
import { isFoundryEnabled } from "./foundry";

export interface AnthropicAuthConfig {
	apiKey: string;
	baseUrl: string;
	isOAuth: boolean;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
	const trimmed = baseUrl?.trim();
	return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

export function resolveAnthropicBaseUrlFromEnv(): string | undefined {
	if (isFoundryEnabled()) {
		const foundryBaseUrl = normalizeBaseUrl($env.FOUNDRY_BASE_URL);
		if (foundryBaseUrl) return foundryBaseUrl;
	}
	const anthropicBaseUrl = normalizeBaseUrl($env.ANTHROPIC_BASE_URL);
	return anthropicBaseUrl || undefined;
}

export function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

export interface AnthropicAuthOptions {
	isOAuth?: boolean;
}

export function buildAnthropicAuthConfig(
	apiKey: string,
	baseUrl?: string,
	options: AnthropicAuthOptions = {},
): AnthropicAuthConfig {
	return {
		apiKey,
		baseUrl: normalizeBaseUrl(baseUrl) ?? resolveAnthropicBaseUrlFromEnv() ?? DEFAULT_BASE_URL,
		isOAuth: options.isOAuth ?? isOAuthToken(apiKey),
	};
}

export interface AnthropicSearchHeaderOptions {
	modelHeaders?: Record<string, string>;
	allowAnthropicHeaderOverrides?: boolean;
}

export function buildAnthropicSearchHeaders(
	auth: AnthropicAuthConfig,
	options: AnthropicSearchHeaderOptions = {},
): Record<string, string> {
	return buildProviderAnthropicHeaders({
		apiKey: auth.apiKey,
		baseUrl: auth.baseUrl,
		isOAuth: auth.isOAuth,
		extraBetas: ["web-search-2025-03-05"],
		stream: false,
		modelHeaders: mergeHeaders(options.modelHeaders, resolveAnthropicCustomHeadersForBaseUrl(auth.baseUrl)),
		allowAnthropicHeaderOverrides: options.allowAnthropicHeaderOverrides,
	});
}

export function buildAnthropicUrl(auth: AnthropicAuthConfig): string {
	const normalizedBaseUrl = normalizeAnthropicBaseUrl(auth.baseUrl);
	const base = `${normalizedBaseUrl}/v1/messages`;
	return `${base}?beta=true`;
}
