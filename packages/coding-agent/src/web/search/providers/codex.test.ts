import { afterEach, expect, spyOn, test, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import * as catalogModels from "@oh-my-pi/pi-catalog/models";
import { searchCodex } from "./codex";

afterEach(() => vi.restoreAllMocks());

function sse(events: Record<string, unknown>[]): string {
	return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
}

test("Codex search uses email-only OAuth credentials without an account header", async () => {
	const authStorage = {
		getOAuthAccess: vi.fn(async () => ({ accessToken: "email-only-access-token", email: "user@example.com" })),
		hasOAuth: vi.fn(() => true),
	} as unknown as AuthStorage;
	let capturedHeaders: Headers | undefined;
	const fetch: FetchImpl = async (_url, init) => {
		capturedHeaders = new Headers(init?.headers);
		return new Response(
			sse([
				{ type: "response.web_search_call.completed", item_id: "ws_test" },
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						content: [
							{
								type: "output_text",
								text: "Codex answer",
								annotations: [{ type: "url_citation", url: "https://example.com/article", title: "Example" }],
							},
						],
					},
				},
				{ type: "response.completed", response: { id: "resp_email_only", model: "gpt-5.4" } },
			]),
			{ status: 200, headers: { "Content-Type": "text/event-stream" } },
		);
	};

	const result = await searchCodex({
		query: "email-only Codex search",
		systemPrompt: "Codex test system prompt",
		authStorage,
		fetch,
	});

	expect(capturedHeaders?.get("authorization")).toBe("Bearer email-only-access-token");
	expect(capturedHeaders?.has("chatgpt-account-id")).toBe(false);
	expect(result.answer).toBe("Codex answer");
});

test("Codex env-origin bearer works without stored OAuth and carries its decoded account id", async () => {
	const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "env-account" } })).toString("base64url")}.signature`;
	const authStorage = {
		getOAuthAccess: async () => undefined,
		getCredentialOrigin: () => ({ kind: "env" }),
		resolver: () => async () => token,
	} as unknown as AuthStorage;
	let capturedHeaders: Headers | undefined;
	const result = await searchCodex({
		query: "env bearer",
		systemPrompt: "",
		authStorage,
		fetch: async (_url, init) => {
			capturedHeaders = new Headers(init?.headers);
			return new Response(
				sse([
					{ type: "response.web_search_call.completed", item_id: "ws_env" },
					{
						type: "response.output_item.done",
						item: { type: "message", content: [{ type: "output_text", text: "Env answer" }] },
					},
					{ type: "response.completed", response: { id: "resp_env", model: "gpt-5.4" } },
				]),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	expect(capturedHeaders?.get("authorization")).toBe(`Bearer ${token}`);
	expect(capturedHeaders?.get("chatgpt-account-id")).toBe("env-account");
	expect(result.answer).toBe("Env answer");
});

test("Codex hosted search prefers GPT-6 Luna and retries an unsupported model with a retained catalog candidate", async () => {
	const models = catalogModels
		.getBundledModels("openai-codex")
		.filter(model => ["gpt-6-luna", "gpt-5.6-luna"].includes(model.id));
	spyOn(catalogModels, "getBundledModels").mockReturnValue(models);
	const requestedModels: string[] = [];
	const result = await searchCodex({
		query: "release notes",
		systemPrompt: "",
		authStorage: { getOAuthAccess: async () => ({ accessToken: "test-token" }) } as unknown as AuthStorage,
		fetch: async (_url, init) => {
			const model = JSON.parse(String(init?.body)).model;
			requestedModels.push(model);
			if (model === "gpt-6-luna") return new Response("model is not supported", { status: 400 });
			return new Response(
				sse([
					{ type: "response.web_search_call.completed", item_id: "ws_fallback" },
					{
						type: "response.output_item.done",
						item: { type: "message", content: [{ type: "output_text", text: "Grounded fallback answer" }] },
					},
					{ type: "response.completed", response: { id: "resp_fallback", model } },
				]),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	expect(requestedModels).toEqual(["gpt-6-luna", "gpt-5.6-luna"]);
	expect(result.answer).toBe("Grounded fallback answer");
});

test("Codex hosted search still requests GPT-6 Luna when the bundled catalog is empty", async () => {
	spyOn(catalogModels, "getBundledModels").mockReturnValue([]);
	let requestedModel: string | undefined;
	const result = await searchCodex({
		query: "release notes",
		systemPrompt: "",
		authStorage: { getOAuthAccess: async () => ({ accessToken: "test-token" }) } as unknown as AuthStorage,
		fetch: async (_url, init) => {
			requestedModel = JSON.parse(String(init?.body)).model;
			return new Response(
				sse([
					{ type: "response.web_search_call.completed", item_id: "ws_empty_catalog" },
					{
						type: "response.output_item.done",
						item: { type: "message", content: [{ type: "output_text", text: "Grounded answer" }] },
					},
					{ type: "response.completed", response: { id: "resp_empty_catalog", model: requestedModel } },
				]),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	expect(requestedModel).toBe("gpt-6-luna");
	expect(result.answer).toBe("Grounded answer");
});
