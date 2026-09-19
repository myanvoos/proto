import { expect, test, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { searchXAI } from "./xai";

const authStorage = {
	resolver: vi.fn(() => async () => "test-key"),
	getCredentialOrigin: vi.fn(() => undefined),
	hasAuth: vi.fn(() => true),
} as unknown as AuthStorage;

function makeParams(fetch: FetchImpl) {
	return {
		query: "Bun latest release",
		systemPrompt: "xAI integration test prompt",
		authStorage,
		fetch,
	};
}

test("xAI answer extraction excludes commentary when final_answer items are present", async () => {
	const fetch: FetchImpl = async () =>
		new Response(
			JSON.stringify({
				output_text: "Searching the release notes.\nThe answer is Bun 1.3.12.",
				output: [
					{
						type: "message",
						phase: "commentary",
						content: [
							{
								type: "output_text",
								text: "Searching the release notes.",
								annotations: [{ type: "url_citation", url: "https://bun.sh" }],
							},
						],
					},
					{
						type: "message",
						phase: "final_answer",
						content: [{ type: "output_text", text: "The answer is Bun 1.3.12." }],
					},
				],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);

	const response = await searchXAI(makeParams(fetch));

	expect(response.answer).toBe("The answer is Bun 1.3.12.");
});
