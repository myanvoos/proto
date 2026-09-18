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
