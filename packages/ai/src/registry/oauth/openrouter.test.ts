import { describe, expect, it } from "bun:test";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { OpenRouterOAuthFlow } from "./openrouter";

const REDIRECT_URI = "http://localhost:54549/callback";

interface RecordedRequest {
	url: string;
	method: string;
	authorization: string | null;
	body: unknown;
}

function recordingFetch(response: () => Response): { fetchImpl: FetchImpl; requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	const fetchImpl: FetchImpl = async (input, init) => {
		requests.push({
			url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
			method: init?.method ?? "GET",
			authorization: new Headers(init?.headers).get("authorization"),
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		return response();
	};
	return { fetchImpl, requests };
}

describe("OpenRouter OAuth flow", () => {
	it("mints a key by exchanging the callback code with the verifier behind the advertised S256 challenge", async () => {
		const { fetchImpl, requests } = recordingFetch(() => Response.json({ key: "sk-or-v1-minted" }));
		const flow = new OpenRouterOAuthFlow({ fetch: fetchImpl });

		const { url } = await flow.generateAuthUrl(flow.generateState(), REDIRECT_URI);
		const authorize = new URL(url);
		expect(authorize.searchParams.get("callback_url")).toBe(REDIRECT_URI);
		// OpenRouter never echoes state; sending one would make every callback fail validation.
		expect(authorize.searchParams.has("state")).toBe(false);

		const credentials = await flow.exchangeToken("auth-code-123");
		expect(credentials.access).toBe("sk-or-v1-minted");
		expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
			"POST https://openrouter.ai/api/v1/auth/keys",
		]);
		const body = requests[0]?.body as { code: string; code_verifier: string };
		expect(body.code).toBe("auth-code-123");
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier));
		expect(authorize.searchParams.get("code_challenge")).toBe(Buffer.from(digest).toString("base64url"));
	});

	it("accepts a pasted sk-or- key after /auth/key validation without a PKCE exchange", async () => {
		const { fetchImpl, requests } = recordingFetch(() => Response.json({ data: {} }));
		const flow = new OpenRouterOAuthFlow({ fetch: fetchImpl });

		const credentials = await flow.exchangeToken("sk-or-v1-pasted");
		expect(credentials.access).toBe("sk-or-v1-pasted");
		expect(requests).toEqual([
			{
				url: "https://openrouter.ai/api/v1/auth/key",
				method: "GET",
				authorization: "Bearer sk-or-v1-pasted",
				body: undefined,
			},
		]);
	});

	it("surfaces a rejected code as a token-exchange error carrying the HTTP status", async () => {
		const { fetchImpl } = recordingFetch(() => new Response("bad code", { status: 403 }));
		const flow = new OpenRouterOAuthFlow({ fetch: fetchImpl });
		await flow.generateAuthUrl(flow.generateState(), REDIRECT_URI);

		const error = await flow.exchangeToken("bad-code").catch((err: unknown) => err);
		expect(error).toBeInstanceOf(AIError.OAuthError);
		expect(error).toMatchObject({ kind: "token-exchange", status: 403 });
		expect((error as Error).message).toBe("OpenRouter key exchange failed: 403 bad code");
	});
});
