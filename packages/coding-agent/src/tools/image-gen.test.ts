import { afterAll, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { CustomToolContext } from "../extensibility/custom-tools";
import type { ReadonlySessionManager } from "../session/session-manager";
import { imageGenTool } from "./image-gen";

const generatedImagePaths: string[] = [];

afterAll(async () => {
	await Promise.all(generatedImagePaths.map(imagePath => removeWithRetries(imagePath)));
});

const claudeModel = { api: "anthropic-messages", provider: "anthropic", id: "claude-opus-4", name: "Claude" } as Model;

function codexImageSse(): string {
	return [
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "image_generation_call",
				result: Buffer.from("fake-codex-webp").toString("base64"),
				status: "completed",
			},
		})}`,
		"",
		`data: ${JSON.stringify({ type: "response.completed", response: { output: [], status: "completed" } })}`,
		"",
	].join("\n");
}

function antigravityImageSse(): string {
	const inlineData = { data: Buffer.from("fallback-image").toString("base64"), mimeType: "image/png" };
	return `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ inlineData }] } }] } })}\n\n`;
}

function codexContext(
	codexModel: Model,
	fetchMock: typeof fetch,
	apiKeyForProvider: (provider: string) => string | undefined,
): CustomToolContext {
	return {
		fetch: fetchMock,
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionId: () => "test-session",
		} as unknown as ReadonlySessionManager,
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === "openai-codex" && id === codexModel.id ? codexModel : undefined,
			getAll: () => [codexModel],
			getApiKey: async () => apiKeyForProvider("openai-codex"),
			getApiKeyForProvider: async (provider: string) => apiKeyForProvider(provider),
			getProviderBaseUrl: () => undefined,
			authStorage: {
				hasNonEnvCredential: () => false,
				rotateSessionCredential: async () => false,
			},
			resolver: (target: string | Model) => async () =>
				apiKeyForProvider(typeof target === "string" ? target : target.provider),
		} as unknown as ModelRegistry,
		model: claudeModel,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
}

test("uses opaque Codex proxy credentials for image generation when the active model is not OpenAI", async () => {
	let requestUrl: string | undefined;
	let requestHeaders: Headers | undefined;
	const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
		requestUrl = input.toString();
		requestHeaders = new Headers(init?.headers);
		return new Response(codexImageSse(), { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as unknown as typeof fetch;
	const proxyModel = {
		api: "openai-codex-responses",
		provider: "openai-codex",
		id: "gpt-5.5",
		name: "GPT-5.5",
		baseUrl: "https://example-proxy.invalid/backend-api",
	} as Model;

	const result = await imageGenTool.execute(
		"call-codex-opaque",
		{ subject: "a cat" },
		undefined,
		codexContext(proxyModel, fetchMock, provider => (provider === "openai-codex" ? "opaque-proxy-key" : undefined)),
	);
	generatedImagePaths.push(...(result.details?.imagePaths ?? []));

	expect(requestUrl).toBe("https://example-proxy.invalid/backend-api/codex/responses");
	expect(requestHeaders?.get("authorization")).toBe("Bearer opaque-proxy-key");
	expect(requestHeaders?.has("chatgpt-account-id")).toBe(false);
	expect(result.details?.provider).toBe("openai-codex");
});

test("materializes config-backed model headers for the hosted image request", async () => {
	let requestHeaders: Headers | undefined;
	const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
		requestHeaders = new Headers(init?.headers);
		return new Response(codexImageSse(), { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as unknown as typeof fetch;
	let resolutions = 0;
	const proxyModel = {
		api: "openai-codex-responses",
		provider: "openai-codex",
		id: "gpt-5.5",
		name: "GPT-5.5",
		baseUrl: "https://example-proxy.invalid/backend-api",
		resolveHeaders: async () => {
			resolutions++;
			return { "X-Proxy-Tenant": "tenant-from-command" };
		},
	} as unknown as Model;

	const result = await imageGenTool.execute(
		"call-codex-live-headers",
		{ subject: "a cat" },
		undefined,
		codexContext(proxyModel, fetchMock, provider => (provider === "openai-codex" ? "opaque-proxy-key" : undefined)),
	);
	generatedImagePaths.push(...(result.details?.imagePaths ?? []));

	expect(resolutions).toBe(1);
	expect(requestHeaders?.get("x-proxy-tenant")).toBe("tenant-from-command");
	expect(requestHeaders?.get("authorization")).toBe("Bearer opaque-proxy-key");
});

test("skips opaque Codex keys for the official ChatGPT backend regardless of URL spelling", async () => {
	const antigravityCredentials = JSON.stringify({ token: "test-antigravity-token", projectId: "test-project" });
	const requestUrls: string[] = [];
	const fetchMock = (async (input: string | URL | Request) => {
		requestUrls.push(input.toString());
		return new Response(antigravityImageSse(), { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as unknown as typeof fetch;
	const officialModel = {
		api: "openai-codex-responses",
		provider: "openai-codex",
		id: "gpt-5.5",
		name: "GPT-5.5",
		baseUrl: "HTTPS://CHATGPT.COM/ignored/../backend-api/",
	} as Model;

	const result = await imageGenTool.execute(
		"call-codex-key-fallback",
		{ subject: "a cat" },
		undefined,
		codexContext(officialModel, fetchMock, provider => {
			if (provider === "openai-codex") return "plain-openai-key";
			if (provider === "google-antigravity") return antigravityCredentials;
			return undefined;
		}),
	);
	generatedImagePaths.push(...(result.details?.imagePaths ?? []));

	expect(requestUrls.some(url => url.includes("chatgpt.com"))).toBe(false);
	expect(result.details?.provider).toBe("antigravity");
});
