import { describe, expect, test } from "bun:test";
import { buildModel } from "../build";
import type { FetchImpl } from "../types";
import { clinePassModelManagerOptions } from "./openai-compat";

const ROSTER_URL = "https://api.cline.bot/api/v1/ai/cline/recommended-models";

function rosterFetch(payload: unknown): { rosterHeaders: Headers[]; fetch: FetchImpl } {
	const rosterHeaders: Headers[] = [];
	const fetch: FetchImpl = async (input, init) => {
		if (String(input) !== ROSTER_URL) return new Response("offline", { status: 503 });
		rosterHeaders.push(new Headers(init?.headers));
		return Response.json(payload);
	};
	return { rosterHeaders, fetch };
}

async function discover(payload: unknown) {
	const { rosterHeaders, fetch } = rosterFetch(payload);
	const specs = (await clinePassModelManagerOptions({ fetch }).fetchDynamicModels?.()) ?? [];
	return { rosterHeaders, models: specs.map(spec => buildModel(spec)) };
}

describe("ClinePass roster discovery", () => {
	test("strips the pass namespace and keeps the Cline-published limits and plan pricing", async () => {
		const { rosterHeaders, models } = await discover({
			clinePass: [{ id: "cline-pass/kimi-k3" }, { id: "not-a-pass-id" }],
		});
		expect(rosterHeaders[0]?.get("x-client-type")).toBe("cline-sdk");
		expect(models.map(model => model.id)).toEqual(["kimi-k3"]);
		expect(models[0]).toMatchObject({
			provider: "cline-pass",
			baseUrl: "https://api.cline.bot/api/v1",
			contextWindow: 1_048_576,
			cost: { input: 3, output: 15 },
			thinking: { efforts: ["low", "high", "max"] },
			compat: { wireModelIdMode: "cline-pass" },
		});
	});

	test("adds free-tier ids after the pass roster, marked free and sent raw", async () => {
		const { models } = await discover({
			clinePass: [{ id: "cline-pass/deepseek-v4-flash" }],
			free: [{ id: "deepseek-v4-flash" }, { id: "cline-pass/glm-5.2" }, { id: "poolside/laguna-s-2.1:free" }],
		});
		// Pass ids win collisions and pass-shaped free entries belong to the pass bucket.
		expect(models.map(model => model.id)).toEqual(["deepseek-v4-flash", "poolside/laguna-s-2.1:free"]);
		const free = models[1];
		expect(free?.name).toEndWith("(free)");
		expect(free?.cost).toMatchObject({ input: 0, output: 0 });
		expect(free?.compat).toMatchObject({ wireModelIdMode: "raw" });
	});

	test("fails discovery when the roster omits the pass bucket", async () => {
		const { fetch } = rosterFetch({ free: [{ id: "poolside/laguna-s-2.1:free" }] });
		await expect(clinePassModelManagerOptions({ fetch }).fetchDynamicModels?.()).rejects.toThrow(/missing clinePass/);
	});
});
