import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { unregisterCustomApis } from "../api-registry";
import { AuthStorage } from "../auth-storage";
import { createMockModel, type MockModel, type MockResponse, registerMockApi } from "../providers/mock";
import type { Context, ProviderSessionState, SimpleStreamOptions } from "../types";
import type { ClientUsageIdentity } from "../usage";
import { startAuthGateway } from "./server";
import type { AuthGatewayServerHandle } from "./types";

const MOCK_SOURCE = "auth-gateway-server-test";
const TOKEN = "gateway-token";

let storage: AuthStorage;
let model: MockModel;
let handle: AuthGatewayServerHandle;
const calls: { context: Context; options?: SimpleStreamOptions }[] = [];
let nextUsage: MockResponse["usage"];

beforeEach(async () => {
	registerMockApi(MOCK_SOURCE);
	calls.length = 0;
	nextUsage = undefined;
	model = createMockModel({
		handler: (context, options) => {
			calls.push({ context, options });
			return { content: ["ok"], usage: nextUsage };
		},
	});
	storage = await AuthStorage.create(":memory:");
	storage.setRuntimeApiKey(model.provider, "mock-key");
	handle = startAuthGateway({
		storage,
		bind: "127.0.0.1:0",
		bearerTokens: [TOKEN],
		resolveModel: id => (id === model.id || id === `${model.provider}/${model.id}` ? model : undefined),
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await handle.close();
	storage.close();
	unregisterCustomApis(MOCK_SOURCE);
});

function post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
	return fetch(`${handle.url}${path}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

describe("auth-gateway format routes", () => {
	it("forwards Chat Completions reasoning_effort none as forced reasoning-off and accepts null content", async () => {
		const response = await post("/v1/chat/completions", {
			model: `${model.provider}/${model.id}`,
			reasoning_effort: "none",
			messages: [
				{ role: "user", content: "read it" },
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
				},
				{ role: "tool", tool_call_id: "call_1", content: null },
			],
		});

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.options).toMatchObject({ forceReasoningOff: true, disableReasoning: true });
		expect(calls[0]!.options?.reasoning).toBeUndefined();
		expect(calls[0]!.context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "call_1" });
	});

	it("keeps multimodal Responses function outputs in order and rejects unreplayable image file ids", async () => {
		const response = await post("/v1/responses", {
			model: model.id,
			input: [
				{ role: "user", content: "look" },
				{ type: "function_call", call_id: "call_1", name: "screenshot", arguments: "{}" },
				{
					type: "function_call_output",
					call_id: "call_1",
					output: [
						{ type: "input_text", text: "before" },
						{ type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
						{ type: "output_text", text: "legacy " },
						{ type: "refusal", refusal: "no" },
						{ type: "input_image", image_url: "https://example.com/shot.png", file_id: null },
					],
				},
				{ type: "message", role: "user", content: null },
			],
		});

		expect(response.status).toBe(200);
		const toolResult = calls[0]!.context.messages.find(message => message.role === "toolResult");
		expect(toolResult?.content).toEqual([
			{ type: "text", text: "before" },
			{ type: "image", data: "AAAA", mimeType: "image/png", detail: "high" },
			{ type: "text", text: "legacy [refusal: no]" },
			{ type: "image", data: "", mimeType: "application/octet-stream", url: "https://example.com/shot.png" },
		]);

		const rejected = await post("/v1/responses", {
			model: model.id,
			input: [
				{ type: "function_call", call_id: "call_2", name: "screenshot", arguments: "{}" },
				{ type: "function_call_output", call_id: "call_2", output: [{ type: "input_image", file_id: "file-abc" }] },
			],
		});
		expect(rejected.status).toBe(400);
		expect(await rejected.text()).toContain("OpenAI image file IDs in tool outputs");
		expect(calls).toHaveLength(1);
	});

	it("hands every turn of a conversation the same provider session state", async () => {
		const opening = [{ role: "user", content: "hi" }];
		expect((await post("/v1/chat/completions", { model: model.id, messages: opening })).status).toBe(200);
		const first = calls[0]!.options?.providerSessionState;
		expect(first).toBeInstanceOf(Map);
		const lesson: ProviderSessionState = { close: () => {} };
		first!.set("learned", lesson);

		const next = [...opening, { role: "assistant", content: "hello" }, { role: "user", content: "more" }];
		expect((await post("/v1/chat/completions", { model: model.id, messages: next })).status).toBe(200);
		expect(calls[1]!.options?.providerSessionState?.get("learned")).toBe(lesson);

		const otherChat = [{ role: "user", content: "something else" }];
		expect((await post("/v1/chat/completions", { model: model.id, messages: otherChat })).status).toBe(200);
		expect(calls[2]!.options?.providerSessionState?.has("learned")).toBe(false);
	});
});

describe("auth-gateway usage attribution", () => {
	it("records burn under the caller's x-proto identity, falling back to the gateway host", async () => {
		const recorded: { provider: string; model: string; costUsd?: number; client?: ClientUsageIdentity }[] = [];
		vi.spyOn(storage, "recordObservedUsage").mockImplementation(entry => {
			recorded.push(entry);
		});
		const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

		nextUsage = { input: 100, output: 20, cacheRead: 5, cacheWrite: 2, cost: { total: 0.75 } };
		const attributed = await post(
			"/v1/pi/stream",
			{ modelId: model.id, context, stream: false },
			{ "x-proto-install-id": "bot-install", "x-proto-hostname": "bot-box", "x-proto-app": "bot" },
		);
		expect(attributed.status).toBe(200);
		await attributed.json();
		expect(recorded).toEqual([
			expect.objectContaining({
				provider: model.provider,
				model: model.id,
				costUsd: 0.75,
				client: { installId: "bot-install", hostname: "bot-box", app: "bot" },
			}),
		]);

		// Streamed foreign-SDK traffic without identity headers still lands on the gateway host.
		const streamed = await post("/v1/chat/completions", {
			model: model.id,
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		});
		expect(streamed.status).toBe(200);
		await streamed.text();
		expect(recorded).toHaveLength(2);
		expect(recorded[1]!.client?.app).toBe("gateway");
		expect(recorded[1]!.client?.installId).not.toBe("bot-install");

		// Zero-usage turns (pre-flight failures) never record.
		nextUsage = undefined;
		const empty = await post("/v1/pi/stream", { modelId: model.id, context, stream: false });
		expect(empty.status).toBe(200);
		await empty.json();
		expect(recorded).toHaveLength(2);
	});
});
