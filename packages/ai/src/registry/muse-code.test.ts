import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { META_MUSE_STATIC_MODELS, MUSE_CODE_STATIC_MODELS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { AuthStorage, SqliteAuthCredentialStore } from "../auth-storage";
import { mapOpenAIResponsesToolChoiceForTools } from "../providers/openai-responses";
import type { Model, Tool, ToolChoice } from "../types";
import { getProviderDefinition } from "./registry";

const encodedMuseCredential = JSON.stringify({
	oauthAccessToken: "meta-account-access",
	apiKey: "LLM|subscription-key",
});

function museModel(): Model<"openai-responses"> {
	return buildModel(MUSE_CODE_STATIC_MODELS[0]!) as Model<"openai-responses">;
}

describe("Muse Code provider", () => {
	test("unwraps only the subscription Model API key for inference and discovery", () => {
		const provider = getProviderDefinition("muse-code");
		if (!provider?.prepareRequest || !provider.prepareModelDiscovery) {
			throw new Error("Muse Code transport is not registered");
		}
		const request = provider.prepareRequest(museModel(), { apiKey: encodedMuseCredential });
		expect(request.options.apiKey).toBe("LLM|subscription-key");
		expect(request.options.headers).toMatchObject({ "x-api-version": "1.0.0" });
		expect(provider.prepareModelDiscovery({ apiKey: encodedMuseCredential })).toMatchObject({
			apiKey: "LLM|subscription-key",
			authenticated: true,
		});
	});

	test("serves a stored credential whose expiry older logins wrote in the past", async () => {
		// Meta's device token has no refresh grant; a stale timestamp must not strand the minted key.
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: () => undefined,
		});
		try {
			await storage.set("muse-code", [
				{
					type: "oauth",
					access: encodedMuseCredential,
					refresh: "",
					expires: Date.now() - 60_000,
					accountId: "meta-account-1",
				},
			]);
			expect(await storage.getApiKey("muse-code", "stale-expiry-session")).toBe(encodedMuseCredential);
		} finally {
			storage.close();
		}
	});

	test("omits tool_choice on api.meta.ai, which accepts only auto", () => {
		// "none", "required" and named function choices all 400 with `only "auto" is supported for tool_choice`.
		const tool: Tool = { name: "yield", description: "Finish.", parameters: type({}) };
		const choices: ToolChoice[] = ["none", "required", { type: "tool", name: "yield" }];
		for (const spec of [META_MUSE_STATIC_MODELS[0]!, MUSE_CODE_STATIC_MODELS[0]!]) {
			const model = buildModel(spec) as Model<"openai-responses">;
			for (const choice of choices) {
				expect(mapOpenAIResponsesToolChoiceForTools(choice, [tool], model)).toBeUndefined();
			}
		}
	});
});
