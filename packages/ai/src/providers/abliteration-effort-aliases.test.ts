import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { ABLITERATION_STATIC_MODELS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Model } from "../types";
import { streamOpenAIResponses } from "./openai-responses";

function staticModel(id: string): Model<"openai-responses"> {
	const spec = ABLITERATION_STATIC_MODELS.find(model => model.id === id);
	if (!spec) throw new Error(`missing abliteration seed ${id}`);
	return buildModel(spec) as Model<"openai-responses">;
}

async function wireEffort(model: Model<"openai-responses">, reasoning: Effort): Promise<unknown> {
	let body: { reasoning?: { effort?: unknown } } | undefined;
	const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		body = JSON.parse(String(init?.body));
		const message = { type: "message", id: "msg", role: "assistant", content: [{ type: "output_text", text: "ok" }] };
		const events = [
			{ type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
			{ type: "response.output_text.delta", delta: "ok" },
			{ type: "response.output_item.done", output_index: 0, item: message },
			{
				type: "response.completed",
				response: {
					id: "resp",
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			},
		];
		return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "content-type": "text/event-stream" },
		});
	};
	await streamOpenAIResponses(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
		{ apiKey: "ak_test", fetch, reasoning },
	).result();
	return body?.reasoning?.effort;
}

describe("Abliteration effort aliases", () => {
	// The large deployments round unsupported modes up; clamping down would silently weaken the request.
	test("Large V2 sends medium as high and xhigh as max", async () => {
		const model = staticModel("abliterated-model-large-v2");
		expect(await wireEffort(model, Effort.Medium)).toBe("high");
		expect(await wireEffort(model, Effort.XHigh)).toBe("max");
		expect(await wireEffort(model, Effort.Low)).toBe("low");
	});

	test("Large sends xhigh as max", async () => {
		expect(await wireEffort(staticModel("abliterated-model-large"), Effort.XHigh)).toBe("max");
	});
});
