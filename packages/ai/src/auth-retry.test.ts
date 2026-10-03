import { describe, expect, it } from "bun:test";
import { type OAuthAccessSource, withAuth, withOAuthAccess } from "./auth-retry";
import type { OAuthAccess } from "./auth-storage";

function authError(): Error & { status: number } {
	return Object.assign(new Error("401 authentication_error"), { status: 401 });
}

describe("401 sibling rotation", () => {
	it("rotates an API-key resolver through every distinct sibling until one succeeds", async () => {
		const pool = ["k0", "k1", "k2", "k3"];
		const keys: string[] = [];
		let resolveIndex = 0;
		const result = await withAuth(
			ctx => (ctx.error === undefined ? pool[0] : pool[++resolveIndex]),
			async key => {
				keys.push(key);
				if (key === "k3") return "success";
				throw authError();
			},
		);
		expect(result).toBe("success");
		expect(keys).toEqual(pool);
	});

	it("stops once the resolver cycles back to an attempted sibling", async () => {
		const pool = ["k0", "k1", "k2"];
		const keys: string[] = [];
		let resolveIndex = 0;
		const failure = withAuth(
			ctx => (ctx.error === undefined ? pool[0] : pool[++resolveIndex % pool.length]),
			async key => {
				keys.push(key);
				throw authError();
			},
		);
		await expect(failure).rejects.toThrow("401");
		expect(keys).toEqual(pool);
	});

	it("rotates OAuth access through every distinct sibling after one forced refresh", async () => {
		const access = (accessToken: string, credentialId: number): OAuthAccess => ({ accessToken, credentialId });
		const siblings = [access("sibling-1", 2), access("sibling-2", 3)];
		let current = access("stale", 1);
		const storage: OAuthAccessSource = {
			async getOAuthAccess(_provider, _sessionId, options) {
				if (options?.forceRefresh) current = access("fresh", 1);
				return current;
			},
			async rotateSessionCredential() {
				const next = siblings.shift();
				if (!next) return false;
				current = next;
				return true;
			},
		};
		const attempts: string[] = [];
		const result = await withOAuthAccess(storage, "prov", async a => {
			attempts.push(a.accessToken);
			if (a.accessToken === "sibling-2") return "success";
			throw authError();
		});
		expect(result).toBe("success");
		expect(attempts).toEqual(["stale", "fresh", "sibling-1", "sibling-2"]);
	});
});
