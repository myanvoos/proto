import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ModelRegistry } from "../config/model-registry";
import { resolveXAIHttpCredentials } from "./xai-http";

// `XAI_BASE_URL` redirects xAI tool traffic (image generation) to a user proxy. An official xAI OAuth access token
// must never follow it: the proxy would receive the user's account credential.
const PROXY = "https://proxy.example/v1";
const OAUTH_JWT = `header.${Buffer.from(JSON.stringify({ sub: "user" })).toString("base64url")}.signature`;

let previousBaseUrl: string | undefined;

beforeEach(() => {
	previousBaseUrl = Bun.env.XAI_BASE_URL;
	Bun.env.XAI_BASE_URL = PROXY;
});

afterEach(() => {
	if (previousBaseUrl === undefined) delete Bun.env.XAI_BASE_URL;
	else Bun.env.XAI_BASE_URL = previousBaseUrl;
});

/** Only the registry members credential resolution consults are stubbed; the cast is confined here. */
function registry(keys: Partial<Record<"xai" | "xai-oauth", string>>): ModelRegistry {
	const stub = {
		getAll: () => [],
		getProviderBaseUrl: () => undefined,
		getApiKeyForProvider: async (provider: "xai" | "xai-oauth") => keys[provider],
		authStorage: {
			hasNonEnvCredential: (provider: "xai" | "xai-oauth") => keys[provider] !== undefined,
			peekApiKey: async (provider: "xai" | "xai-oauth") => keys[provider],
		},
	};
	return stub as unknown as ModelRegistry;
}

test("keeps an xAI OAuth access token on the bundled endpoint despite XAI_BASE_URL", async () => {
	const creds = await resolveXAIHttpCredentials(registry({ "xai-oauth": OAUTH_JWT }));
	expect(creds).toEqual({ provider: "xai-oauth", apiKey: OAUTH_JWT, baseURL: "https://api.x.ai/v1" });
});

test("routes API keys through XAI_BASE_URL", async () => {
	const creds = await resolveXAIHttpCredentials(registry({ xai: "xai-api-key" }));
	expect(creds?.baseURL).toBe(PROXY);
	const oauthProviderKey = await resolveXAIHttpCredentials(registry({ "xai-oauth": "plain-api-key" }));
	expect(oauthProviderKey?.baseURL).toBe(PROXY);
});
