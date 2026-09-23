import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	parseCloudflareAiGatewayCredential,
	serializeCloudflareAiGatewayCredential,
} from "@oh-my-pi/pi-catalog/wire/cloudflare-ai-gateway";
import { AuthStorage, SqliteAuthCredentialStore } from "../auth-storage";
import { stream } from "../stream";
import type { FetchImpl, Model } from "../types";
import { cloudflareAiGatewayProvider } from "./cloudflare-ai-gateway";

const ANTHROPIC_MODEL = buildModel({
	id: "anthropic/claude-sonnet-4.5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "cloudflare-ai-gateway",
	baseUrl: CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 64_000,
});
// Catalog rows for every namespace ride the Anthropic route until prepareModel re-routes them.
const OPENAI_MODEL = buildModel({ ...ANTHROPIC_MODEL, id: "openai/gpt-5.4", name: "GPT-5.4" });
const WORKERS_MODEL = buildModel({
	...ANTHROPIC_MODEL,
	id: "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct",
	name: "Llama 4 Scout",
});
const CREDENTIAL = serializeCloudflareAiGatewayCredential("gateway-token", "account-id", "my-gateway");

function prepare(model: Model, apiKey?: string) {
	const prepared = cloudflareAiGatewayProvider.prepareModel(model);
	return cloudflareAiGatewayProvider.prepareRequest(prepared, { apiKey });
}

function promptAnswers(answers: string[]) {
	return { onAuth: () => {}, onPrompt: async () => answers.shift() ?? "" };
}

describe("Cloudflare AI Gateway", () => {
	it("routes each namespace to its gateway endpoint with the stored account and gateway IDs", () => {
		const anthropic = prepare(ANTHROPIC_MODEL, CREDENTIAL);
		expect(anthropic.model.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/account-id/my-gateway/anthropic");
		expect(anthropic.model.requestModelId).toBe("claude-sonnet-4-5");
		expect(anthropic.options.apiKey).toBe("gateway-token");

		const workers = prepare(WORKERS_MODEL, CREDENTIAL);
		expect(workers.model.api).toBe("openai-completions");
		expect(workers.model.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/account-id/my-gateway/compat");
		expect(workers.model.requestModelId ?? workers.model.id).toBe(WORKERS_MODEL.id);
	});

	it("keeps a legacy plain token working against an explicit gateway base URL", () => {
		const baseUrl = "https://gateway.ai.cloudflare.com/v1/legacy-account/legacy-gateway/anthropic";
		const prepared = prepare({ ...ANTHROPIC_MODEL, baseUrl }, "legacy-token");
		expect(prepared.model.baseUrl).toBe(baseUrl);
		expect(prepared.model.requestModelId).toBe("claude-sonnet-4-5");
		expect(prepared.options.apiKey).toBe("legacy-token");
	});

	it("sends OpenAI-format models through the gateway without leaking an upstream bearer", async () => {
		const captured: { url?: string; headers?: Headers; body?: string } = {};
		const fetchImpl: FetchImpl = async (input, init) => {
			captured.url = String(input instanceof Request ? input.url : input);
			captured.headers = new Headers(input instanceof Request ? input.headers : init?.headers);
			captured.body = typeof init?.body === "string" ? init.body : undefined;
			return Response.json({ error: { message: "captured" } }, { status: 400 });
		};
		await stream(
			{ ...OPENAI_MODEL, headers: { Authorization: "Bearer upstream-token" } },
			{ messages: [{ role: "user", content: "Say hello", timestamp: 0 }] },
			{ apiKey: CREDENTIAL, fetch: fetchImpl, maxTokens: 16 },
		).result();

		expect(captured.url).toBe("https://gateway.ai.cloudflare.com/v1/account-id/my-gateway/openai/chat/completions");
		expect(captured.headers?.get("cf-aig-authorization")).toBe("Bearer gateway-token");
		expect(captured.headers?.get("authorization")).toBeNull();
		expect(JSON.parse(captured.body ?? "{}").model).toBe("gpt-5.4");
	});

	it("stores routing IDs with the token and replaces them when the same token logs in again", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const authStorage = new AuthStorage(store);
		try {
			await authStorage.login("cloudflare-ai-gateway", promptAnswers(["token", "old-account", "old-gateway"]));
			await authStorage.login("cloudflare-ai-gateway", promptAnswers(["token", "new-account", "new-gateway"]));

			const stored = store.listAuthCredentials("cloudflare-ai-gateway");
			expect(stored).toHaveLength(1);
			const credential = stored[0]?.credential;
			expect(parseCloudflareAiGatewayCredential(credential?.type === "api_key" ? credential.key : "")).toEqual({
				token: "token",
				accountId: "new-account",
				gatewayId: "new-gateway",
			});
		} finally {
			store.close();
		}
	});
});
