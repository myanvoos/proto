import { afterEach, describe, expect, test, vi } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { analyzeAuthError, discoverOAuthEndpoints, fetchResourceMetadataScopes } from "./oauth-discovery";
import { MCPOAuthNetworkTimeoutError } from "./oauth-flow";

afterEach(() => vi.useRealTimers());

function inputUrl(input: string | URL | Request): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

describe("OAuth discovery network policy", () => {
	test.each(["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:8080/private"])(
		"refuses private resource_metadata challenge URL %s",
		async resourceMetadataUrl => {
			const challenge = analyzeAuthError(
				new Error(`HTTP 401 Unauthorized: WWW-Authenticate: Bearer resource_metadata="${resourceMetadataUrl}"`),
				"https://mcp.example.test/rpc",
			);
			expect(challenge.resourceMetadataUrl).toBe(resourceMetadataUrl);

			const calls: string[] = [];
			const fetchImpl: FetchImpl = async input => {
				calls.push(inputUrl(input));
				return Response.json({ scopes_supported: ["stolen"] });
			};
			const scopes = await fetchResourceMetadataScopes(challenge.resourceMetadataUrl!, { fetch: fetchImpl });

			expect(scopes).toBeUndefined();
			expect(calls).toEqual([]);
		},
	);

	test.each([
		"file:///etc/passwd",
		"https://user:password@auth.example.test/resource",
		"https://auth.example.test/resource#fragment",
	])("refuses non-HTTP or ambiguous resource metadata URL %s", async resourceMetadataUrl => {
		const calls: string[] = [];
		const scopes = await fetchResourceMetadataScopes(resourceMetadataUrl, {
			fetch: async input => {
				calls.push(inputUrl(input));
				return Response.json({ scopes_supported: ["stolen"] });
			},
		});

		expect(scopes).toBeUndefined();
		expect(calls).toEqual([]);
	});

	test("revalidates a public resource metadata redirect before fetching a private target", async () => {
		const publicUrl = "https://auth.example.test/resource";
		const privateUrl = "http://169.254.169.254/latest/meta-data/iam";
		const calls: string[] = [];
		const fetchImpl: FetchImpl = async (input, init) => {
			const url = inputUrl(input);
			calls.push(url);
			if (url === publicUrl && init?.redirect === "manual") {
				return new Response(null, { status: 302, headers: { Location: privateUrl } });
			}
			if (url === publicUrl) {
				// Emulate fetch's automatic redirect to the private address.
				calls.push(privateUrl);
			}
			return Response.json({ scopes_supported: ["stolen"] });
		};

		const scopes = await fetchResourceMetadataScopes(publicUrl, { fetch: fetchImpl });

		expect(scopes).toBeUndefined();
		expect(calls).toEqual([publicUrl]);
	});
	test("surfaces a typed timeout when discovery never responds", async () => {
		vi.useFakeTimers();
		const pending = Promise.withResolvers<Response>();
		const discovery = fetchResourceMetadataScopes("https://auth.example.test/resource", {
			fetch: async () => await pending.promise,
			timeoutMs: 5,
		});

		vi.advanceTimersByTime(5);

		await expect(discovery).rejects.toBeInstanceOf(MCPOAuthNetworkTimeoutError);
	});

	test("discovers endpoints from a well-behaved HTTPS authorization server", async () => {
		const authServer = "https://auth.example.test";
		const calls: Array<{ url: string; redirect?: RequestInit["redirect"] }> = [];
		const endpoints = await discoverOAuthEndpoints("https://mcp.example.test/rpc", authServer, undefined, {
			fetch: async (input, init) => {
				const url = inputUrl(input);
				calls.push({ url, redirect: init?.redirect });
				if (url === `${authServer}/.well-known/oauth-authorization-server`) {
					return Response.json({
						issuer: authServer,
						authorization_endpoint: `${authServer}/authorize`,
						token_endpoint: `${authServer}/token`,
					});
				}
				return new Response(null, { status: 404 });
			},
		});

		expect(endpoints).toMatchObject({
			authorizationUrl: `${authServer}/authorize`,
			tokenUrl: `${authServer}/token`,
		});
		expect(calls[0]).toEqual({
			url: `${authServer}/.well-known/oauth-authorization-server`,
			redirect: "manual",
		});
	});
});

describe("OAuth discovery recursion bounds", () => {
	test("terminates mutually-referencing protected-resource metadata with a bounded fetch count", async () => {
		const serverUrl = "https://mcp.example.test/rpc";
		const authA = "https://auth-a.example.test";
		const authB = "https://auth-b.example.test";
		let fetchCount = 0;
		const fetchImpl: FetchImpl = async input => {
			fetchCount++;
			if (fetchCount > 80) return new Response(null, { status: 404 });
			const url = new URL(inputUrl(input));
			if (url.pathname === "/.well-known/oauth-protected-resource") {
				const peer = url.origin === authA ? authB : authA;
				return Response.json({ resource: serverUrl, authorization_servers: [peer] });
			}
			return new Response(null, { status: 404 });
		};

		const discovered = await discoverOAuthEndpoints(serverUrl, authA, undefined, { fetch: fetchImpl });

		expect(discovered).toBeNull();
		expect(fetchCount).toBeLessThanOrEqual(64);
	});
});
