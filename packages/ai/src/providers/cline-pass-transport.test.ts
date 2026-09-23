import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { clinePassModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model } from "../types";
import { streamOpenAICompletions } from "./openai-completions";

async function clinePassModel(id: string): Promise<Model<"openai-completions">> {
	const roster: FetchImpl = async input =>
		String(input).endsWith("/recommended-models")
			? Response.json({
					clinePass: [{ id: "cline-pass/kimi-k3" }, { id: "cline-pass/qwen3.7-plus" }],
					free: [{ id: "poolside/laguna-s-2.1:free" }],
				})
			: new Response("offline", { status: 503 });
	const specs = (await clinePassModelManagerOptions({ fetch: roster }).fetchDynamicModels?.()) ?? [];
	const spec = specs.find(candidate => candidate.id === id);
	if (!spec) throw new Error(`ClinePass roster missing ${id}`);
	return buildModel(spec) as Model<"openai-completions">;
}

async function captureRequest(
	model: Model<"openai-completions">,
	options: { reasoning?: Effort; disableReasoning?: boolean } = {},
): Promise<{ body: Record<string, unknown>; headers: Headers }> {
	let captured: { body: Record<string, unknown>; headers: Headers } | undefined;
	const fetch: FetchImpl = async (_input, init) => {
		captured = { body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) };
		const chunk = { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" } }] };
		const done = {
			id: "c",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		};
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, {
			headers: { "content-type": "text/event-stream" },
		});
	};
	await streamOpenAICompletions(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
		{ apiKey: "sk_test", fetch, ...options },
	).result();
	if (!captured) throw new Error("ClinePass request was not captured");
	return captured;
}

describe("ClinePass transport", () => {
	test("namespaces pass ids on the wire and sends the mirrored Cline CLI identity", async () => {
		const { body, headers } = await captureRequest(await clinePassModel("kimi-k3"), { reasoning: Effort.High });
		expect(body.model).toBe("cline-pass/kimi-k3");
		expect(body.reasoning_effort).toBe("high");
		expect(headers.get("x-client-type")).toBe("cline-sdk");
	});

	test("sends free-tier ids unchanged", async () => {
		const { body } = await captureRequest(await clinePassModel("poolside/laguna-s-2.1:free"));
		expect(body.model).toBe("poolside/laguna-s-2.1:free");
	});

	test("disables reasoning with the gateway's enabled:false switch", async () => {
		const { body } = await captureRequest(await clinePassModel("kimi-k3"), { disableReasoning: true });
		expect(body.reasoning).toEqual({ enabled: false });
		expect(body).not.toHaveProperty("reasoning_effort");
	});

	test("maps a budget-mode effort to reasoning.max_tokens", async () => {
		const { body } = await captureRequest(await clinePassModel("qwen3.7-plus"), { reasoning: Effort.Medium });
		expect(body.reasoning).toMatchObject({ max_tokens: 65_536 });
		expect(body).not.toHaveProperty("reasoning_effort");
	});
});
