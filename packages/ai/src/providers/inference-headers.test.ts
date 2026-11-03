import { describe, expect, it } from "bun:test";
import { applyInferenceHeaders, applySessionHeader } from "./inference-headers";
import { resolveOpenAIRequestSetup } from "./openai-shared";

describe("Inference conversation headers", () => {
	it("labels LiteLLM requests without overwriting an explicitly configured grouping id", () => {
		const generated: Record<string, string> = {};
		applyInferenceHeaders(generated, { provider: "litellm", protocol: "openai", sessionId: "conversation" });
		expect(new Headers(generated).get("x-litellm-session-id")).toBe("conversation");
		const configured = { "X-LiteLLM-Session-ID": "run" };
		applyInferenceHeaders(configured, { provider: "litellm", protocol: "openai", sessionId: "conversation" });
		expect(new Headers(configured).get("x-litellm-session-id")).toBe("run");
	});

	it("uses the same configured conversation label on hosted fetch requests", () => {
		const headers = new Headers();
		applySessionHeader(headers, { sessionHeader: "x-litellm-session-id" }, "conversation");
		expect(headers.get("x-litellm-session-id")).toBe("conversation");
		headers.set("x-litellm-session-id", "run");
		applySessionHeader(headers, { sessionHeader: "x-litellm-session-id" }, "other");
		expect(headers.get("x-litellm-session-id")).toBe("run");
	});

	it("lets differently-cased per-request headers override model and OpenRouter defaults exactly once", () => {
		const { headers } = resolveOpenAIRequestSetup(
			{
				provider: "openrouter",
				api: "openai-responses",
				id: "model",
				baseUrl: "https://openrouter.ai/api/v1",
				headers: { "User-Agent": "configured-agent", "X-Title": "configured-title" },
			},
			{
				apiKey: "test-key",
				messages: [],
				extraHeaders: {
					"user-agent": "request-agent",
					"x-title": "request-title",
					authorization: "Bearer explicit",
				},
			},
		);
		const wire = new Headers(headers);
		expect(wire.get("user-agent")).toBe("request-agent");
		expect(wire.get("x-title")).toBe("request-title");
		expect(wire.get("authorization")).toBe("Bearer explicit");
	});
});
