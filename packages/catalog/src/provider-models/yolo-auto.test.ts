import { describe, expect, test } from "bun:test";
import { buildModel } from "../build";
import { getBundledModel } from "../models";
import type { FetchImpl } from "../types";
import { yoloAutoModelManagerOptions } from "./openai-compat";

function modelsFetch(ids: string[]): { authorizations: (string | null)[]; fetch: FetchImpl } {
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		expect(String(input)).toBe("https://yolo-auto.com/v1/models");
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return Response.json({ data: ids.map(id => ({ id, object: "model", owned_by: "yolo-auto" })) });
	};
	return { authorizations, fetch };
}

describe("Yolo-Auto provider discovery", () => {
	test("serves qwen3.8-flash and the yolo alias at the documented 256K deployment cap", async () => {
		// `/v1/models` carries bare ids without limits; the global reference index would otherwise
		// resolve `qwen3.8-flash` to the largest bundled window (1M).
		const { authorizations, fetch } = modelsFetch(["qwen3.8-flash", "yolo"]);
		const models = await yoloAutoModelManagerOptions({ apiKey: "yolo_test", fetch }).fetchDynamicModels?.();

		expect(authorizations).toEqual(["Bearer yolo_test"]);
		for (const id of ["qwen3.8-flash", "yolo"]) {
			const spec = models?.find(model => model.id === id);
			if (!spec) throw new Error(`yolo-auto/${id} missing from discovery`);
			const model = buildModel(spec);
			expect(model).toMatchObject({
				provider: "yolo-auto",
				baseUrl: "https://yolo-auto.com/v1",
				contextWindow: 262144,
				maxTokens: 131072,
				tokenizer: "qwen3",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: {
					supportsReasoningEffort: true,
					thinkingFormat: "qwen-chat-template",
					qwenTemplateReasoningEffort: true,
					supportsStore: false,
					supportsDeveloperRole: false,
				},
			});
		}
	});

	test("keeps flat-rate billing and the no-store surface on ids known only from other providers", async () => {
		const globalId = "gpt-4o";
		const foreign = getBundledModel("openai", globalId);
		expect(foreign.cost.input).toBeGreaterThan(0);

		const { fetch } = modelsFetch([globalId]);
		const models = await yoloAutoModelManagerOptions({ apiKey: "yolo_test", fetch }).fetchDynamicModels?.();
		const spec = models?.find(candidate => candidate.id === globalId);
		if (!spec) throw new Error("gpt-4o missing from discovery");
		const model = buildModel(spec);

		expect(model).toMatchObject({
			id: globalId,
			provider: "yolo-auto",
			contextWindow: foreign.contextWindow,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsStore: false, supportsDeveloperRole: false },
		});
	});

	test("does not discover without a key", () => {
		expect(yoloAutoModelManagerOptions().fetchDynamicModels).toBeUndefined();
	});
});
