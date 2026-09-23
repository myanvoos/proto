import { afterEach, describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Context, FetchImpl } from "../types";
import { clearCopilotIntegrationCache } from "./github-copilot-headers";
import { streamOpenAICompletions } from "./openai-completions";

const CHAT = "copilot-chat";
const CLI = "copilot-developer-cli";

const model = buildModel({
	id: "gpt-4.1",
	name: "GPT-4.1",
	api: "openai-completions",
	provider: "github-copilot",
	baseUrl: "https://api.githubcopilot.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
});

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

type Reply = (integrationId: string | null) => Response;

function sse(text: string): Response {
	const frames = [{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }];
	const body = `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function jsonError(status: number, code: string): Response {
	return Response.json({ error: { code, message: `${code} rejected` } }, { status });
}

/** Records the `Copilot-Integration-Id` of every request and answers per identity. */
function copilotFetch(reply: Reply): { fetch: FetchImpl; identities: (string | null)[] } {
	const identities: (string | null)[] = [];
	const impl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const identity = new Headers(init?.headers).get("Copilot-Integration-Id");
		identities.push(identity);
		return reply(identity);
	};
	return { fetch: Object.assign(impl, { preconnect: fetch.preconnect }), identities };
}

async function run(apiKey: string, transport: { fetch: FetchImpl }, headers?: Record<string, string>) {
	return streamOpenAICompletions(model, context, { apiKey, fetch: transport.fetch, headers }).result();
}

afterEach(() => clearCopilotIntegrationCache());

describe("Copilot client-identity fallback", () => {
	it("retries a denied chat identity once as the CLI and starts later streams at the learned identity", async () => {
		const transport = copilotFetch(id => (id === CLI ? sse("ok") : jsonError(403, "forbidden")));

		const first = await run("gho_business_cli_only", transport);
		expect(first.stopReason).toBe("stop");
		expect(transport.identities).toEqual([CHAT, CLI]);

		const second = await run("gho_business_cli_only", transport);
		expect(second.stopReason).toBe("stop");
		expect(transport.identities).toEqual([CHAT, CLI, CLI]);
	});

	it("treats Business 400 model_not_supported as an identity denial but passes other 400s through untouched", async () => {
		const denied = copilotFetch(id => (id === CLI ? sse("ok") : jsonError(400, "model_not_supported")));
		expect((await run("gho_business_400", denied)).stopReason).toBe("stop");
		expect(denied.identities).toEqual([CHAT, CLI]);

		const invalid = copilotFetch(() => jsonError(400, "invalid_request_body"));
		const result = await run("gho_invalid_request", invalid);
		expect(invalid.identities).toEqual([CHAT]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("invalid_request_body");
	});

	it("never second-guesses an explicitly pinned identity", async () => {
		const transport = copilotFetch(() => jsonError(403, "forbidden"));
		const result = await run("gho_pinned", transport, { "copilot-integration-id": CHAT });

		expect(transport.identities).toEqual([CHAT]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("GitHub Copilot access denied (HTTP 403)");
	});

	it("keeps the CLI identity for Enterprise credentials", async () => {
		const transport = copilotFetch(() => sse("ok"));
		const apiKey = JSON.stringify({ token: "ghu_enterprise", enterpriseUrl: "company.ghe.com" });

		expect((await run(apiKey, transport)).stopReason).toBe("stop");
		expect(transport.identities).toEqual([CLI]);
	});

	it("relearns chat when a learned CLI identity is later denied", async () => {
		let cliAllowed = true;
		const transport = copilotFetch(id => {
			if (id === CLI) return cliAllowed ? sse("ok") : jsonError(403, "forbidden");
			return cliAllowed ? jsonError(403, "forbidden") : sse("ok");
		});

		await run("gho_policy_flip", transport);
		cliAllowed = false;
		expect((await run("gho_policy_flip", transport)).stopReason).toBe("stop");
		expect((await run("gho_policy_flip", transport)).stopReason).toBe("stop");

		expect(transport.identities).toEqual([CHAT, CLI, CLI, CHAT, CHAT]);
	});

	it("does not learn an identity from a failed retry", async () => {
		const transport = copilotFetch(() => jsonError(403, "forbidden"));
		expect((await run("gho_both_denied", transport)).stopReason).toBe("error");
		expect((await run("gho_both_denied", transport)).stopReason).toBe("error");

		expect(transport.identities).toEqual([CHAT, CLI, CHAT, CLI]);
	});
});
