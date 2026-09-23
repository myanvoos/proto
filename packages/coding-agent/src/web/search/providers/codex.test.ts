import { expect, test, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { searchCodex } from "./codex";

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
