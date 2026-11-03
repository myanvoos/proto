import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as utils from "@oh-my-pi/pi-utils";
import { streamSimple } from "./stream";
import type { FetchImpl } from "./types";

afterEach(() => vi.restoreAllMocks());

it("a provider cap holds its permit until the finished SSE request drains", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-provider-drain-"));
	vi.spyOn(utils, "getProviderInFlightRoot").mockReturnValue(root);
	const model = buildModel({
		id: "drain-test",
		name: "Drain",
		api: "openai-completions",
		provider: "drain-test",
		baseUrl: "https://drain.example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	});
	const drainStarted = Promise.withResolvers<void>();
	const releaseDrain = Promise.withResolvers<void>();
	const order: string[] = [];
	const frame = new TextEncoder().encode(
		`data: ${JSON.stringify({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 1 } } })}\n\n`,
	);
	let requests = 0;
	const fetch: FetchImpl = async () => {
		const index = ++requests;
		order.push(index === 1 ? "first-fetch" : "second-fetch");
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(frame);
				},
				async pull(controller) {
					if (index === 1) {
						drainStarted.resolve();
						await releaseDrain.promise;
						order.push("first-drained");
					}
					controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
					controller.close();
				},
			}),
		);
	};
	const options = { apiKey: "test", fetch, maxInFlightRequests: { "drain-test": 1 } };
	try {
		const first = streamSimple(
			model,
			{ messages: [{ role: "user", content: "first", timestamp: 0 }] },
			options,
		).result();
		await drainStarted.promise;
		const second = streamSimple(
			model,
			{ messages: [{ role: "user", content: "second", timestamp: 1 }] },
			options,
		).result();
		// Let the capped caller attempt its filesystem lease before ending the drain.
		await Bun.sleep(25);
		expect(requests).toBe(1);
		releaseDrain.resolve();
		expect((await first).stopReason).toBe("stop");
		expect((await second).stopReason).toBe("stop");
		expect(order).toEqual(["first-fetch", "first-drained", "second-fetch"]);
	} finally {
		releaseDrain.resolve();
		await fs.rm(root, { recursive: true, force: true });
	}
});
