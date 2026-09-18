import { afterEach, expect, spyOn, test, vi } from "bun:test";
import { SmitheryRegistryError, searchSmitheryRegistry } from "./smithery-registry";

type SearchEntryFixture = {
	id: string;
	qualifiedName: string;
	namespace: string;
	slug: string;
};

type DetailResponder = (path: string) => Response | Promise<Response>;

afterEach(() => vi.restoreAllMocks());

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { "Content-Type": "application/json", ...init?.headers },
	});
}

function entry(slug: string, namespace = "owner"): SearchEntryFixture {
	return {
		id: `${namespace}-${slug}`,
		qualifiedName: `@${namespace}/${slug}`,
		namespace,
		slug,
	};
}

function details(qualifiedName: string): Response {
	return jsonResponse({
		qualifiedName,
		displayName: qualifiedName,
		connections: [{ type: "http", deploymentUrl: `https://mcp.example.test/${qualifiedName}` }],
	});
}

function mockGlobalFetch(
	implementation: (input: string | URL | Request, init?: BunFetchRequestInit) => Promise<Response>,
): void {
	spyOn(globalThis, "fetch").mockImplementation(Object.assign(implementation, { preconnect: fetch.preconnect }));
}

function installFetch(entries: SearchEntryFixture[], respondToDetail: DetailResponder): void {
	mockGlobalFetch(async input => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(rawUrl);
		if (url.pathname === "/servers") {
			return jsonResponse({ servers: entries });
		}
		const detailPath = decodeURIComponent(url.pathname.replace(/^\/servers\//, ""));
		return respondToDetail(detailPath);
	});
}

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
	let rejection: unknown;
	try {
		await promise;
	} catch (error) {
		rejection = error;
	}
	expect(rejection).toBeDefined();
	return rejection;
}

test.each([401, 429, 500])("retains a detail HTTP %d failure when no matching detail loads", async status => {
	installFetch([entry("protected-tool")], () => new Response(null, { status }));

	const error = await rejectedValue(searchSmitheryRegistry("tool"));

	expect(error).toBeInstanceOf(SmitheryRegistryError);
	if (!(error instanceof SmitheryRegistryError)) return;
	expect(error.status).toBe(status);
	expect(error.message).toContain("owner/protected-tool");
	expect(error.message).toContain(String(status));
	expect(error.failures).toHaveLength(1);
	const cause = error.failures[0]?.error;
	expect(cause).toBeInstanceOf(SmitheryRegistryError);
	if (cause instanceof SmitheryRegistryError) {
		expect(cause.status).toBe(status);
	}
});

test("retains a per-entry network failure when no matching detail loads", async () => {
	const networkError = new Error("connection reset by peer");
	installFetch([entry("offline-tool")], () => {
		throw networkError;
	});

	const error = await rejectedValue(searchSmitheryRegistry("tool"));

	expect(error).toBeInstanceOf(SmitheryRegistryError);
	if (!(error instanceof SmitheryRegistryError)) return;
	expect(error.status).toBe(0);
	expect(error.message).toContain("owner/offline-tool");
	expect(error.message).toContain("connection reset by peer");
	expect(error.failures).toEqual([{ identity: "owner/offline-tool", error: networkError }]);
});

test("treats a detail 404 as a miss and tries the next documented identity", async () => {
	installFetch([entry("fallback-tool")], path => {
		if (path === "owner/fallback-tool") return new Response(null, { status: 404 });
		if (path === "fallback-tool") return details("@owner/fallback-tool");
		throw new Error(`Unexpected detail path: ${path}`);
	});

	const results = await searchSmitheryRegistry("tool");

	expect(results.map(result => result.name)).toEqual(["owner/fallback-tool"]);
});

test("throws a registry error when matching entries exist but every detail is missing", async () => {
	installFetch([entry("missing-tool")], () => new Response(null, { status: 404 }));

	const error = await rejectedValue(searchSmitheryRegistry("tool"));

	expect(error).toBeInstanceOf(SmitheryRegistryError);
	if (!(error instanceof SmitheryRegistryError)) return;
	expect(error.status).toBe(404);
	expect(error.message).toContain("no details loaded");
	expect(error.message).toContain("1 missing");
	expect(error.failures).toEqual([]);
});

test("returns loaded details when another matching entry fails", async () => {
	installFetch([entry("working-tool"), entry("broken-tool")], path => {
		if (path === "owner/working-tool") return details("@owner/working-tool");
		if (path === "owner/broken-tool") return new Response(null, { status: 500 });
		throw new Error(`Unexpected detail path: ${path}`);
	});

	const results = await searchSmitheryRegistry("tool");

	expect(results.map(result => result.name)).toEqual(["owner/working-tool"]);
});
