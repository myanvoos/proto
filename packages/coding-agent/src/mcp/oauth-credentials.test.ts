import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { refreshStoredManagedMcpOAuthCredential } from "./oauth-credentials";
import type { MCPStoredOAuthCredential } from "./oauth-flow";

// The credential id embeds a different origin than the token endpoint, so a recovered fallback resource survives
// same-origin filtering and is observable in the grant.
const PROVIDER = "mcp_oauth:profile:default:https://remote.example.test/mcp";

async function refreshOnce(recoverServerUrlFromCredentialId: boolean) {
	const grants: URLSearchParams[] = [];
	using tokenServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			grants.push(new URLSearchParams(await request.text()));
			return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
		},
	});
	const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	try {
		await storage.reload();
		const credential: MCPStoredOAuthCredential = {
			type: "oauth",
			access: "access-0",
			refresh: "refresh-0",
			expires: Date.now() - 60_000,
			tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
		};
		await storage.set(PROVIDER, credential);
		const result = await refreshStoredManagedMcpOAuthCredential(storage, PROVIDER, {
			forceRefresh: true,
			recoverServerUrlFromCredentialId,
		});
		return { grants, result, persisted: storage.get(PROVIDER) };
	} finally {
		storage.close();
	}
}

test("refreshing a managed MCP credential persists the rotated grant", async () => {
	const { grants, result, persisted } = await refreshOnce(false);
	expect(grants.map(grant => grant.get("refresh_token"))).toEqual(["refresh-0"]);
	expect(result.credential?.access).toBe("access-1");
	expect(persisted).toMatchObject({ type: "oauth", access: "access-1", refresh: "refresh-1" });
});

test("standalone refresh recovers the fallback resource from the credential id", async () => {
	const { grants } = await refreshOnce(true);
	expect(grants.map(grant => grant.get("resource"))).toEqual(["https://remote.example.test/mcp"]);
});

test("refresh without server-url recovery advertises no resource", async () => {
	const { grants } = await refreshOnce(false);
	expect(grants.map(grant => grant.get("resource"))).toEqual([null]);
});
