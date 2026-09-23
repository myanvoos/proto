import { expect, it } from "bun:test";
import { buildHttp400DumpPayload } from "./http-inspector";

it("keeps credentials out of persisted 400 dumps across provider header spellings and query strings", () => {
	const payload = buildHttp400DumpPayload(
		{
			provider: "google",
			api: "google-generative-ai",
			model: "gemini-3-pro",
			url: "https://gateway.example/v1/models?key=live-secret&alt=sse",
			headers: {
				"x-goog-api-key": "live-google-key",
				"X-Amz-Security-Token": "live-aws-token",
				"content-type": "application/json",
			},
			body: { contents: [] },
		},
		new Error("400 Bad Request"),
		"400 Bad Request",
	);

	expect(JSON.stringify(payload)).not.toMatch(/live-/);
	expect(payload.url).toBe("https://gateway.example/v1/models[redacted-query]");
	expect(payload.headers?.["content-type"]).toBe("application/json");
});
