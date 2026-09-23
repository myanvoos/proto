import { describe, expect, test } from "bun:test";
import { buildModel } from "../build";
import type { FetchImpl } from "../types";
import { stepfunModelManagerOptions } from "./openai-compat";

const fetch: FetchImpl = async () =>
	Response.json({
		object: "list",
		data: [
			{ id: "step-3.7-flash", object: "model" },
			{ id: "step-6-mini", object: "model", reasoning_effort_support_list: ["high", "low", "turbo"] },
			{ id: "step-6-chat", object: "model" },
			{ id: "stepaudio-2.5-tts", object: "model" },
			{ id: "step-image-edit-2", object: "model" },
			{ id: "step-2x-large", object: "model" },
		],
	});

async function discover() {
	const specs = (await stepfunModelManagerOptions({ apiKey: "sf-test", fetch }).fetchDynamicModels?.()) ?? [];
	return new Map(specs.map(spec => [spec.id, buildModel(spec)] as const));
}

describe("StepFun provider discovery", () => {
	test("keeps only chat SKUs from the interleaved roster", async () => {
		expect([...(await discover()).keys()].sort()).toEqual(["step-3.7-flash", "step-6-chat", "step-6-mini"]);
	});

	test("maps the seeded card and the documented max_tokens spelling onto a served id", async () => {
		expect((await discover()).get("step-3.7-flash")).toMatchObject({
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 256_000,
			cost: { input: 0.2, output: 1.15, cacheRead: 0.04, cacheWrite: 0 },
			thinking: { efforts: ["low", "medium", "high"] },
			compat: { maxTokensField: "max_tokens" },
		});
	});

	test("derives a new id's effort dial only from the tiers the endpoint advertises", async () => {
		const models = await discover();
		expect(models.get("step-6-mini")).toMatchObject({ reasoning: true, thinking: { efforts: ["low", "high"] } });
		expect(models.get("step-6-chat")?.reasoning).toBe(false);
		expect(models.get("step-6-chat")?.thinking).toBeUndefined();
		expect(models.get("step-6-chat")?.compat).toMatchObject({ maxTokensField: "max_tokens" });
	});
});
