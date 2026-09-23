import { once } from "@oh-my-pi/pi-utils";
import { type CodexModelDiscoveryResult, fetchCodexModels } from "../discovery/codex";
import type { DevinModelDiscoveryOptions } from "../discovery/devin";
import { buildGitLabDuoWorkflowFallbackModel, fetchGitLabDuoWorkflowModels } from "../discovery/gitlab-duo-workflow";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl, ModelSpec } from "../types";
import { DEVIN_DEFAULT_BASE_URL } from "../wire/devin";
import { resolveModelCacheProviderId } from "./cache-provider-id";

export interface OpenAICodexAccount {
	accessToken: string;

	accountId?: string;
}

export interface OpenAICodexModelManagerConfig {
	resolveAccounts?: () => Promise<readonly OpenAICodexAccount[] | null>;
	catalogUrl?: string;
	fetch?: FetchImpl;
}

export function openaiCodexModelManagerOptions(
	config: OpenAICodexModelManagerConfig = {},
): ModelManagerOptions<"openai-codex-responses"> {
	const { resolveAccounts, catalogUrl, fetch } = config;
	return {
		providerId: "openai-codex",
		cacheProviderId: resolveModelCacheProviderId("openai-codex"),
		dynamicModelsAuthoritative: true,
		...(resolveAccounts
			? {
					fetchDynamicModels: async () => {
						const accounts = await resolveAccounts();
						if (!accounts || accounts.length === 0) return null;
						const result: CodexModelDiscoveryResult | null = await fetchCodexModels({
							catalogUrl,
							fetchFn: fetch,
						});
						return result?.models ?? null;
					},
				}
			: undefined),
	};
}

export interface CursorModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	clientVersion?: string;
}

export function cursorModelManagerOptions(config: CursorModelManagerConfig = {}): ModelManagerOptions<"cursor-agent"> {
	const { apiKey, baseUrl, clientVersion } = config;
	return {
		providerId: "cursor",
		cacheProviderId: resolveModelCacheProviderId("cursor"),
		...(apiKey
			? {
					fetchDynamicModels: async () => {
						const { fetchCursorUsableModels } = await cursorDiscovery();
						return fetchCursorUsableModels({ apiKey, baseUrl, clientVersion });
					},
				}
			: undefined),
	};
}

const cursorDiscovery = once(() => import("../discovery/cursor"));

export interface GitLabDuoWorkflowModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	namespaceId?: string;
	projectId?: string;
	cwd?: string;
}

export function gitLabDuoWorkflowModelManagerOptions(
	config: GitLabDuoWorkflowModelManagerConfig = {},
): ModelManagerOptions<"gitlab-duo-agent"> {
	const apiKey = config.apiKey;
	return {
		providerId: "gitlab-duo-agent",

		...(apiKey ? { cacheProviderId: gitLabDuoWorkflowModelCacheProviderId(apiKey, config) } : undefined),
		dynamicModelsAuthoritative: true,
		staticModels: [
			buildGitLabDuoWorkflowFallbackModel("claude_sonnet_4_6_vertex", "Claude Sonnet 4.6 - Vertex", config.baseUrl),
		],
		...(apiKey
			? {
					fetchDynamicModels: async () =>
						fetchGitLabDuoWorkflowModels({
							apiKey,
							baseUrl: config.baseUrl,
							fetch: config.fetch,
							namespaceId: config.namespaceId,
							projectId: config.projectId,
							cwd: config.cwd,
						}),
				}
			: undefined),
	};
}

function gitLabDuoWorkflowModelCacheProviderId(apiKey: string, config: GitLabDuoWorkflowModelManagerConfig): string {
	const namespaceId = config.namespaceId ?? Bun.env.GITLAB_DUO_NAMESPACE_ID ?? "";
	const projectId = config.projectId ?? Bun.env.GITLAB_DUO_PROJECT_ID ?? Bun.env.GITLAB_DUO_PROJECT_PATH ?? "";
	const cwd = config.cwd ?? process.cwd();
	const scope = [config.baseUrl ?? "", namespaceId, projectId, cwd].join("\u0000");
	return `gitlab-duo-agent:${Bun.hash(`${apiKey}\u0000${scope}`).toString(36)}`;
}

export interface DevinModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: DevinModelDiscoveryOptions["fetch"];
}

// The Cascade roster is credential-scoped, so generation never fetches it and this seed is the whole
// bundled surface; the descriptor default (`swe-1-6`) must resolve before runtime discovery runs.
// SWE-1.6 lanes are text-only despite `supports_images` (see DEVIN_IMAGE_BLIND_UIDS).
export const DEVIN_STATIC_MODELS: readonly ModelSpec<"devin-agent">[] = [
	{
		id: "swe-1-6-fast",
		name: "SWE-1.6 Fast",
		api: "devin-agent",
		provider: "devin",
		baseUrl: DEVIN_DEFAULT_BASE_URL,
		reasoning: true,
		input: ["text"],
		supportsTools: true,
		cost: { input: 0.3, output: 1.5, cacheRead: 0.03, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 128_000,
		compat: { supportsParallelToolCalls: true },
	},
	{
		id: "swe-1-6",
		name: "SWE-1.6",
		api: "devin-agent",
		provider: "devin",
		baseUrl: DEVIN_DEFAULT_BASE_URL,
		reasoning: true,
		input: ["text"],
		supportsTools: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 128_000,
		compat: { supportsParallelToolCalls: true },
	},
];

export function devinModelManagerOptions(config: DevinModelManagerConfig = {}): ModelManagerOptions<"devin-agent"> {
	const { apiKey, baseUrl, fetch } = config;
	return {
		providerId: "devin",
		staticModels:
			baseUrl === undefined || baseUrl === DEVIN_DEFAULT_BASE_URL
				? DEVIN_STATIC_MODELS
				: DEVIN_STATIC_MODELS.map(model => ({ ...model, baseUrl })),
		...(apiKey ? { dynamicModelsAuthoritative: true } : undefined),
		...(apiKey
			? {
					fetchDynamicModels: async () => {
						const { fetchDevinModels } = await devinDiscovery();
						return fetchDevinModels({ apiKey, baseUrl, fetch });
					},
				}
			: undefined),
	};
}

const devinDiscovery = once(() => import("../discovery/devin"));

export interface ZaiModelManagerConfig {}

/** Z.AI mixes the Anthropic coding endpoint with native completions for GLM-5.3-Flash. */
export function zaiModelManagerOptions(
	_config: ZaiModelManagerConfig = {},
): ModelManagerOptions<"anthropic-messages" | "openai-completions"> {
	return { providerId: "zai" };
}
