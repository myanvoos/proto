import { describe, expect, test } from "bun:test";
import { buildModel } from "../build";
import type { FetchImpl } from "../types";
import { abliterationModelManagerOptions } from "./openai-compat";

function modelsFetch(ids: string[]): { urls: string[]; fetch: FetchImpl } {
	const urls: string[] = [];
	const fetch: FetchImpl = async input => {
		urls.push(String(input));
		return Response.json({ object: "list", data: ids.map(id => ({ id, object: "model" })) });
	};
	return { urls, fetch };
}

describe("Abliteration provider discovery", () => {
	test("appends /v1 to a bare base URL override", async () => {
		const { urls, fetch } = modelsFetch(["abliterated-model"]);
		await abliterationModelManagerOptions({
			apiKey: "ak_test",
			baseUrl: "https://proxy.example/",
			fetch,
		}).fetchDynamicModels?.();
		expect(urls).toEqual(["https://proxy.example/v1/models"]);
	});

	test("keeps the documented limits and alias ladder for seeded ids", async () => {
		const { fetch } = modelsFetch(["abliterated-model-large-v2"]);
		const [spec] = (await abliterationModelManagerOptions({ apiKey: "ak_test", fetch }).fetchDynamicModels?.()) ?? [];
		if (!spec) throw new Error("abliterated-model-large-v2 missing from discovery");
		const model = buildModel(spec);
		expect(model).toMatchObject({
			contextWindow: 1_000_000,
			maxTokens: 999_990,
			tokenizer: "glm5",
			thinking: { efforts: ["low", "medium", "high", "xhigh", "max"], defaultLevel: "max", requiresEffort: true },
			compat: { includeEncryptedReasoning: false, streamIdleTimeoutMs: 0 },
		});
	});

	test("treats unseeded ids as reasoning models on the gateway's wire surface", async () => {
		// `/v1/models` carries no capability metadata; a new id must keep its effort dial and must not
		// request encrypted reasoning the gateway never returns.
		const { fetch } = modelsFetch(["abliterated-model-next"]);
		const [spec] = (await abliterationModelManagerOptions({ apiKey: "ak_test", fetch }).fetchDynamicModels?.()) ?? [];
		if (!spec) throw new Error("abliterated-model-next missing from discovery");
		const model = buildModel(spec);
		expect(model.reasoning).toBe(true);
		expect(model.compat).toMatchObject({ includeEncryptedReasoning: false, streamIdleTimeoutMs: 0 });
	});
});
