import { afterEach, describe, expect, test, vi } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	fetchResourceMetadataScopes,
	OAuthIssuerMismatchError,
} from "./oauth-discovery";
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

describe("OAuth discovery for path-scoped resources", () => {
	test("follows the resource's RFC 9728 metadata to its own issuer before origin-root metadata", async () => {
		const documents: Record<string, unknown> = {
			"https://gw.example.test/.well-known/oauth-protected-resource/tenant/mcp": {
				resource: "https://gw.example.test/tenant/mcp",
				authorization_servers: ["https://login.example.test/realms/tenant"],
			},
			"https://gw.example.test/.well-known/oauth-authorization-server": {
				issuer: "https://gw.example.test",
				authorization_endpoint: "https://gw.example.test/shared/authorize",
				token_endpoint: "https://gw.example.test/shared/token",
			},
			"https://login.example.test/realms/tenant/.well-known/openid-configuration": {
				issuer: "https://login.example.test/realms/tenant",
				authorization_endpoint: "https://login.example.test/realms/tenant/protocol/openid-connect/auth",
				token_endpoint: "https://login.example.test/realms/tenant/protocol/openid-connect/token",
			},
		};
		const endpoints = await discoverOAuthEndpoints("https://gw.example.test/tenant/mcp", undefined, undefined, {
			fetch: async input => {
				const document = documents[inputUrl(input)];
				return document ? Response.json(document) : new Response("not found", { status: 404 });
			},
		});

		expect(endpoints).toMatchObject({
			authorizationUrl: "https://login.example.test/realms/tenant/protocol/openid-connect/auth",
			issuerUrl: "https://login.example.test/realms/tenant",
			resource: "https://gw.example.test/tenant/mcp",
		});
	});

	test("a challenge without resource_metadata still points at the RFC 9728 document", () => {
		const challenge = analyzeAuthError(
			new Error("HTTP 401 Unauthorized: WWW-Authenticate: Bearer"),
			"https://mcp.example.test/tenant/mcp/",
		);

		expect(challenge.resourceMetadataUrl).toBe(
			"https://mcp.example.test/.well-known/oauth-protected-resource/tenant/mcp",
		);
	});
});

describe("OAuth resource authority", () => {
	test("ignores an unlisted auth-server hint and its supported-scope catalogue", async () => {
		const calls: string[] = [];
		const result = await discoverOAuthEndpoints(
			"https://mcp.example.test/rpc",
			"https://unlisted.example.test",
			"https://mcp.example.test/meta",
			{
				fetch: async input => {
					const url = inputUrl(input);
					calls.push(url);
					if (url.endsWith("/meta"))
						return Response.json({
							authorization_servers: ["https://auth.example.test"],
							scopes_supported: ["resource:read"],
						});
					if (url === "https://auth.example.test/.well-known/oauth-authorization-server")
						return Response.json({
							issuer: "https://auth.example.test",
							authorization_endpoint: "https://auth.example.test/authorize",
							token_endpoint: "https://auth.example.test/token",
							scopes_supported: ["admin", "all"],
						});
					return new Response(null, { status: 404 });
				},
			},
		);
		expect(result?.scopes).toBe("resource:read");
		expect(calls.some(url => url.includes("unlisted"))).toBe(false);
	});

	test("does not request authorization-server catalogue scopes without resource requirements", async () => {
		const result = await discoverOAuthEndpoints(
			"https://mcp.example.test/rpc",
			"https://auth.example.test",
			undefined,
			{
				fetch: async () =>
					Response.json({
						issuer: "https://auth.example.test",
						authorization_endpoint: "https://auth.example.test/authorize",
						token_endpoint: "https://auth.example.test/token",
						scopes_supported: ["admin"],
					}),
			},
		);
		expect(result?.authorizationUrl).toBe("https://auth.example.test/authorize");
		expect(result?.scopes).toBeUndefined();
	});

	test("reports advertised issuer mismatch without falling back to an unrelated origin issuer", async () => {
		const calls: string[] = [];
		const result = discoverOAuthEndpoints(
			"https://mcp.example.test/rpc",
			undefined,
			"https://mcp.example.test/meta",
			{
				fetch: async input => {
					const url = inputUrl(input);
					calls.push(url);
					if (url.endsWith("/meta"))
						return Response.json({ authorization_servers: ["https://auth.example.test/tenant"] });
					if (url.includes("oauth-authorization-server") || url.includes("openid-configuration"))
						return Response.json({
							issuer: "https://auth.example.test/other",
							authorization_endpoint: "https://auth.example.test/authorize",
							token_endpoint: "https://auth.example.test/token",
						});
					return new Response(null, { status: 404 });
				},
			},
		);
		await expect(result).rejects.toBeInstanceOf(OAuthIssuerMismatchError);
		expect(calls.filter(url => url.startsWith("https://mcp.example.test"))).toEqual([
			"https://mcp.example.test/meta",
		]);
	});

	test("prefers the RFC 9728 resource over the auth server's own resource field", async () => {
		const fetchImpl: FetchImpl = async input => {
			const url = inputUrl(input);
			if (url === "https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth") {
				return Response.json({
					resource: "https://mcp.firecrawl.dev/v2/mcp-oauth",
					authorization_servers: ["https://www.firecrawl.dev"],
				});
			}
			if (url === "https://www.firecrawl.dev/.well-known/oauth-authorization-server") {
				return Response.json({
					issuer: "https://www.firecrawl.dev",
					// The issuer's default audience (its REST API), not this MCP server.
					resource: "https://api.firecrawl.dev/",
					authorization_endpoint: "https://www.firecrawl.dev/api/oauth/authorize",
					token_endpoint: "https://www.firecrawl.dev/api/oauth/token",
				});
			}
			return new Response("not found", { status: 404 });
		};

		for (const resourceMetadataUrl of [
			"https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth",
			undefined,
		]) {
			const oauth = await discoverOAuthEndpoints(
				"https://mcp.firecrawl.dev/v2/mcp-oauth",
				undefined,
				resourceMetadataUrl,
				{ fetch: fetchImpl },
			);
			expect(oauth?.resource).toBe("https://mcp.firecrawl.dev/v2/mcp-oauth");
		}
	});

	test("revisits a self-advertised resource as an authorization server", async () => {
		const result = await discoverOAuthEndpoints("https://mcp.example.test/rpc", undefined, undefined, {
			fetch: async input => {
				const url = inputUrl(input);
				if (url.includes("oauth-protected-resource"))
					return Response.json({ authorization_servers: ["https://mcp.example.test/rpc"] });
				if (url.includes("oauth-authorization-server"))
					return Response.json({
						issuer: "https://mcp.example.test/rpc",
						authorization_endpoint: "https://mcp.example.test/authorize",
						token_endpoint: "https://mcp.example.test/token",
					});
				return new Response(null, { status: 404 });
			},
		});
		expect(result?.tokenUrl).toBe("https://mcp.example.test/token");
	});
});
