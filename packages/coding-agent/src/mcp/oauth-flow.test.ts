import { afterEach, describe, expect, test, vi } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { MCPOAuthFlow, MCPOAuthNetworkTimeoutError, refreshMCPOAuthToken } from "./oauth-flow";

function jsonFetch(payload: unknown): FetchImpl {
	return async () => Response.json(payload);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("MCP OAuth network timeout", () => {
	test("a token endpoint that never responds fails with a typed timeout", async () => {
		vi.useFakeTimers();
		const pending = Promise.withResolvers<Response>();
		const fetchImpl: FetchImpl = async () => await pending.promise;
		const refresh = refreshMCPOAuthToken("https://auth.example.test/token", "refresh-token", undefined, undefined, {
			fetch: fetchImpl,
			timeoutMs: 5,
		});

		vi.advanceTimersByTime(5);

		await expect(refresh).rejects.toBeInstanceOf(MCPOAuthNetworkTimeoutError);
	});

	test("token exchange applies the same typed timeout", async () => {
		vi.useFakeTimers();
		const pending = Promise.withResolvers<Response>();
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://auth.example.test/authorize",
				tokenUrl: "https://auth.example.test/token",
				clientId: "client-id",
				fetch: async () => await pending.promise,
				timeoutMs: 5,
			},
			{},
		);
		const exchange = flow.exchangeToken("code", "state", "http://127.0.0.1:3000/callback");

		vi.advanceTimersByTime(5);

		await expect(exchange).rejects.toMatchObject({
			name: "MCPOAuthNetworkTimeoutError",
			operation: "token exchange",
		});
	});

	test("dynamic client registration applies the same typed timeout", async () => {
		vi.useFakeTimers();
		const pending = Promise.withResolvers<Response>();
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://auth.example.test/authorize",
				tokenUrl: "https://auth.example.test/token",
				registrationUrl: "https://auth.example.test/register",
				fetch: async () => await pending.promise,
				timeoutMs: 5,
			},
			{},
		);
		const registration = flow.generateAuthUrl("state", "http://127.0.0.1:3000/callback");

		vi.advanceTimersByTime(5);

		await expect(registration).rejects.toMatchObject({
			name: "MCPOAuthNetworkTimeoutError",
			operation: "client registration",
		});
	});
});

describe("MCP OAuth refresh token response validation", () => {
	test("rejects a successful empty response without an access token", async () => {
		const refresh = refreshMCPOAuthToken("https://auth.example.test/token", "working-refresh", undefined, undefined, {
			fetch: jsonFetch({}),
		});

		await expect(refresh).rejects.toThrow("invalid token response");
	});

	test.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("rejects invalid expires_in value %s", async expiresIn => {
		const refresh = refreshMCPOAuthToken("https://auth.example.test/token", "working-refresh", undefined, undefined, {
			fetch: jsonFetch({ access_token: "valid-access", expires_in: expiresIn }),
		});

		await expect(refresh).rejects.toThrow("invalid token response");
	});

	test("does not expose provider response content in a refresh error", async () => {
		const secret = "configured-client-secret";
		const refresh = refreshMCPOAuthToken("https://auth.example.test/token", "working-refresh", "client-id", secret, {
			fetch: async () => new Response(`provider echoed ${secret}`, { status: 400 }),
		});

		const error = await refresh.catch(cause => cause);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toContain(secret);
	});

	test("sanitizes malformed token response parse errors", async () => {
		const secret = "provider-secret-payload";
		const refresh = refreshMCPOAuthToken("https://auth.example.test/token", "working-refresh", undefined, undefined, {
			fetch: async () => new Response(`{${secret}`, { status: 200 }),
		});

		const error = await refresh.catch(cause => cause);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("MCP OAuth refresh returned an invalid token response");
		expect((error as Error).message).not.toContain(secret);
	});

	test("accepts a valid HTTPS refresh response", async () => {
		let requestedUrl: string | undefined;
		const before = Date.now();
		const credentials = await refreshMCPOAuthToken(
			"https://auth.example.test/token",
			"working-refresh",
			"client-id",
			undefined,
			{
				fetch: async input => {
					requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
					return Response.json({
						access_token: "new-access",
						refresh_token: "new-refresh",
						expires_in: 60,
					});
				},
			},
		);

		expect(requestedUrl).toBe("https://auth.example.test/token");
		expect(credentials).toMatchObject({ access: "new-access", refresh: "new-refresh" });
		expect(credentials.expires).toBeGreaterThanOrEqual(before + 60_000);
	});
});

describe("MCP OAuth client id normalization", () => {
	test("removes a whitespace-only embedded client id before authorization", async () => {
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize?client_id=%20%09",
				tokenUrl: "https://provider.example/token",
				fetch: async () => new Response("not found", { status: 404 }),
			},
			{},
		);

		const { url } = await flow.generateAuthUrl("test-state", "http://127.0.0.1:53174/callback");

		expect(new URL(url).searchParams.get("client_id")).toBeNull();
	});

	test("omits a whitespace-only client id from token refresh", async () => {
		let body = "";
		await refreshMCPOAuthToken("https://provider.example/token", "refresh-token", " \t ", undefined, {
			fetch: async (_input, init) => {
				body = String(init?.body ?? "");
				return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
			},
		});

		expect(new URLSearchParams(body).has("client_id")).toBe(false);
	});
});

describe("MCP OAuth issuer and resource handling", () => {
	test("dynamic registration probes the issuer's metadata, not the authorization endpoint's path", async () => {
		const requested: string[] = [];
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://login.example.test/realms/tenant/protocol/openid-connect/auth",
				tokenUrl: "https://login.example.test/realms/tenant/protocol/openid-connect/token",
				issuerUrl: "https://login.example.test/realms/tenant",
				fetch: async (input, init) => {
					const url = String(input);
					requested.push(url);
					if (url === "https://login.example.test/realms/tenant/.well-known/oauth-authorization-server") {
						return Response.json({ registration_endpoint: "https://login.example.test/realms/tenant/register" });
					}
					if (url === "https://login.example.test/realms/tenant/register" && init?.method === "POST") {
						return Response.json({ client_id: "registered-client" });
					}
					return new Response("not found", { status: 404 });
				},
			},
			{},
		);

		const { url } = await flow.generateAuthUrl("state", "http://127.0.0.1:53174/callback");

		expect(new URL(url).searchParams.get("client_id")).toBe("registered-client");
		expect(requested[0]).toBe("https://login.example.test/.well-known/oauth-authorization-server/realms/tenant");
	});

	test("an advertised resource wins over a resource embedded in the authorization URL", async () => {
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl:
					"https://auth.example.test/authorize?client_id=client&resource=https%3A%2F%2Fother.example.test%2Fmcp",
				tokenUrl: "https://auth.example.test/token",
				resource: "https://mcp.example.test/mcp",
				fetch: async () => new Response("not found", { status: 404 }),
			},
			{},
		);

		const { url } = await flow.generateAuthUrl("state", "http://127.0.0.1:53174/callback");

		expect(new URL(url).searchParams.get("resource")).toBe("https://mcp.example.test/mcp");
		expect(flow.resource).toBe("https://mcp.example.test/mcp");
	});
});

describe("MCP OAuth offline access", () => {
	async function authParams(authorizationUrl: string): Promise<URLSearchParams> {
		const flow = new MCPOAuthFlow(
			{ authorizationUrl, tokenUrl: "https://oauth2.example.test/token", clientId: "client" },
			{},
		);
		const { url } = await flow.generateAuthUrl("state", "http://127.0.0.1:53174/callback");
		return new URL(url).searchParams;
	}

	test("Google issuers are asked for offline access so a refresh token is minted", async () => {
		expect((await authParams("https://accounts.google.com/o/oauth2/v2/auth")).get("access_type")).toBe("offline");
	});

	test("an explicit access_type and non-Google issuers are left alone", async () => {
		expect(
			(await authParams("https://accounts.google.com/o/oauth2/v2/auth?access_type=online")).get("access_type"),
		).toBe("online");
		expect((await authParams("https://auth.example.test/authorize")).has("access_type")).toBe(false);
	});
});
