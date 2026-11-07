/**
 * Shared-store OAuth refresh races: several processes (or sessions) share one
 * credential row. A provider that rotates single-use refresh tokens revokes the
 * access token every peer holds on each exchange, so a refresh must adopt a
 * peer's newer row, persist a token it already exchanged even after its caller
 * gave up, and refuse to spend a token once the store is closing.
 */
import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AuthStorage, SqliteAuthCredentialStore } from "./auth-storage";
import * as oauthUtils from "./registry/oauth";

const PROVIDER = "unit-oauth-shared-store";

async function seed(storage: AuthStorage, access: string, refresh: string, expires = 0): Promise<number> {
	await storage.set(PROVIDER, [{ type: "oauth", access, refresh, expires }]);
	const row = storage.listStoredCredentials(PROVIDER)[0];
	if (row === undefined) throw new Error("expected a stored credential row");
	return row.id;
}

function storedAccess(storage: AuthStorage): string | undefined {
	const credential = storage.listStoredCredentials(PROVIDER)[0]?.credential;
	return credential?.type === "oauth" ? credential.access : undefined;
}

describe("shared-store OAuth refresh", () => {
	test("a forced refresh adopts a peer's newer row instead of exchanging the spent token", async () => {
		const temp = TempDir.createSync("pi-oauth-shared-adopt-");
		try {
			const store = await SqliteAuthCredentialStore.open(temp.join("agent.db"));
			const storage = new AuthStorage(store, {});
			const id = await seed(storage, "access-0", "refresh-0");
			// A peer rotated the row while this process still held the previous copy.
			store.updateAuthCredential(id, {
				type: "oauth",
				access: "access-1",
				refresh: "refresh-1",
				expires: Date.now() + 3_600_000,
			});
			let exchanges = 0;

			const result = await storage.refreshStoredOAuthCredential(PROVIDER, {
				credentialId: id,
				observedCredential: { type: "oauth", access: "access-0", refresh: "refresh-0", expires: 0 },
				credentialFromRow: row => row,
				forceRefresh: true,
				refresh: async () => {
					exchanges += 1;
					throw new Error("a peer row must be adopted, not exchanged");
				},
			});

			expect(exchanges).toBe(0);
			expect(result.refreshed).toBe(false);
			expect(result.credential).toMatchObject({ access: "access-1", refresh: "refresh-1" });
			storage.close();
		} finally {
			temp[Symbol.dispose]();
		}
	});

	test("a 401 recovery adopts another token but not the rejected one", async () => {
		const temp = TempDir.createSync("pi-oauth-shared-rejected-");
		try {
			const store = await SqliteAuthCredentialStore.open(temp.join("agent.db"));
			const storage = new AuthStorage(store, {});
			const id = await seed(storage, "access-1", "refresh-1", Date.now() + 3_600_000);

			const adopted = await storage.refreshStoredOAuthCredential(PROVIDER, {
				credentialId: id,
				credentialFromRow: row => row,
				forceRefresh: true,
				rejectedAccess: "access-0",
				refresh: async () => {
					throw new Error("a row holding another access token must be adopted");
				},
			});
			expect(adopted.credential).toMatchObject({ access: "access-1" });

			let exchanges = 0;
			const exchanged = await storage.refreshStoredOAuthCredential(PROVIDER, {
				credentialId: id,
				credentialFromRow: row => row,
				forceRefresh: true,
				rejectedAccess: "access-1",
				refresh: async () => {
					exchanges += 1;
					return { access: "access-2", refresh: "refresh-2", expires: Date.now() + 3_600_000 };
				},
			});
			expect(exchanges).toBe(1);
			expect(exchanged.credential).toMatchObject({ access: "access-2", refresh: "refresh-2" });
			storage.close();
		} finally {
			temp[Symbol.dispose]();
		}
	});

	test("a rotated token is saved after the caller's budget runs out", async () => {
		const temp = TempDir.createSync("pi-oauth-shared-budget-");
		try {
			const store = await SqliteAuthCredentialStore.open(temp.join("agent.db"));
			const storage = new AuthStorage(store, {});
			const id = await seed(storage, "access-0", "refresh-0");
			const released = Promise.withResolvers<void>();

			const pending = storage.refreshStoredOAuthCredential(PROVIDER, {
				credentialId: id,
				credentialFromRow: row => row,
				forceRefresh: true,
				refreshTimeoutMs: 20,
				refresh: async () => {
					// The provider consumed the old token at once; its answer is slow.
					await released.promise;
					return { access: "access-1", refresh: "refresh-1", expires: Date.now() + 3_600_000 };
				},
			});

			await expect(pending).rejects.toMatchObject({
				message: `OAuth token refresh timed out for provider: ${PROVIDER}`,
			});
			// The exchange keeps the lease and finishes in the background.
			released.resolve();
			await Bun.sleep(50);
			expect(storedAccess(storage)).toBe("access-1");
			storage.close();
		} finally {
			temp[Symbol.dispose]();
		}
	});

	test("close refuses new refreshes and still saves an in-flight exchange", async () => {
		const temp = TempDir.createSync("pi-oauth-shared-close-");
		const dbPath = temp.join("agent.db");
		try {
			const store = await SqliteAuthCredentialStore.open(dbPath);
			const storage = new AuthStorage(store, {});
			await seed(storage, "access-0", "refresh-0");
			const started = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();

			const pending = storage.refreshStoredOAuthCredential(PROVIDER, {
				credentialFromRow: row => row,
				forceRefresh: true,
				refreshTimeoutMs: 1_000,
				refresh: async () => {
					started.resolve();
					await released.promise;
					return { access: "access-1", refresh: "refresh-1", expires: Date.now() + 3_600_000 };
				},
			});
			await started.promise;
			storage.close();
			await expect(
				storage.refreshStoredOAuthCredential(PROVIDER, {
					credentialFromRow: row => row,
					forceRefresh: true,
					refresh: async () => {
						throw new Error("a closed auth storage must not start an exchange");
					},
				}),
			).rejects.toMatchObject({ message: "OAuth refresh stopped during shutdown" });

			released.resolve();
			await expect(pending).resolves.toMatchObject({ refreshed: true, credential: { refresh: "refresh-1" } });
			await Bun.sleep(0);

			const reopened = await SqliteAuthCredentialStore.open(dbPath);
			try {
				expect(reopened.listAuthCredentials(PROVIDER)[0]?.credential).toMatchObject({
					type: "oauth",
					refresh: "refresh-1",
				});
			} finally {
				reopened.close();
			}
		} finally {
			temp[Symbol.dispose]();
		}
	});

	test("a joined by-id refresh landing on the rejected token refreshes again", async () => {
		const temp = TempDir.createSync("pi-oauth-shared-joined-");
		try {
			const store = await SqliteAuthCredentialStore.open(temp.join("agent.db"));
			let exchanges = 0;
			const firstAnswer = Promise.withResolvers<void>();
			const storage = new AuthStorage(store, {
				refreshOAuthCredential: async (_provider, _credentialId, credential) => {
					exchanges += 1;
					const generation = exchanges;
					if (generation === 1) await firstAnswer.promise;
					return {
						...credential,
						access: `access-${generation}`,
						refresh: `refresh-${generation}`,
						expires: Date.now() + 3_600_000,
					};
				},
			});
			const id = await seed(storage, "access-0", "refresh-0");

			const first = storage.refreshCredentialById(id);
			const recovery = storage.refreshCredentialById(id, undefined, { rejectedAccess: "access-1" });
			firstAnswer.resolve();

			expect((await first).credential).toMatchObject({ access: "access-1" });
			expect((await recovery).credential).toMatchObject({ access: "access-2" });
			expect(exchanges).toBe(2);
			storage.close();
		} finally {
			temp[Symbol.dispose]();
		}
	});
});

describe("OAuth 401 recovery token provenance", () => {
	test("a 401 names the token the failed request sent, not the row a peer only re-expired", async () => {
		const sourceId = "auth-refresh-shared-store-test";
		let exchanges = 0;
		oauthUtils.registerOAuthProvider({
			id: PROVIDER,
			name: PROVIDER,
			sourceId,
			async login() {
				return { access: "unused", refresh: "unused", expires: 0 };
			},
			async refreshToken(current) {
				exchanges += 1;
				return {
					...current,
					access: `access-${exchanges}`,
					refresh: `refresh-${exchanges}`,
					expires: Date.now() + 3_600_000,
				};
			},
			getApiKey(current) {
				return current.access;
			},
		});
		const temp = TempDir.createSync("pi-oauth-shared-provenance-");
		try {
			const store = await SqliteAuthCredentialStore.open(temp.join("agent.db"));
			const storage = new AuthStorage(store, {});
			const id = await seed(storage, "access-0", "refresh-0", Date.now() + 3_600_000);
			const served = await storage.getApiKey(PROVIDER, "session");
			expect(served).toBe("access-0");

			// A peer rewrote the row without replacing its access token: only the expiry moved.
			store.updateAuthCredential(id, {
				type: "oauth",
				access: "access-0",
				refresh: "refresh-0",
				expires: Date.now() + 2 * 3_600_000,
			});

			const recovered = await storage.resolver(PROVIDER, { sessionId: "session" })({
				lastChance: false,
				error: Object.assign(new Error("401 revoked"), { status: 401 }),
				previousKey: served,
			});
			expect(recovered).toBe("access-1");
			expect(exchanges).toBe(1);
			storage.close();
		} finally {
			oauthUtils.unregisterOAuthProviders(sourceId);
			temp[Symbol.dispose]();
		}
	});
});

describe("stalled refresh lease takeover", () => {
	test("a token rejected after taking over a lapsed lease is transient and hands the lease back", async () => {
		const temp = TempDir.createSync("pi-oauth-shared-stalled-");
		try {
			const store = await SqliteAuthCredentialStore.open(temp.join("agent.db"));
			const storage = new AuthStorage(store, {});
			const id = await seed(storage, "access-0", "refresh-0");
			// Another process lapsed holding the lease; it may still be saving its successor.
			expect(store.tryAcquireCredentialRefreshLease(id, "stalled-peer", Date.now() - 1_000)).toBe(true);
			const failures: unknown[] = [];

			const result = await storage.refreshStoredOAuthCredential(PROVIDER, {
				credentialId: id,
				credentialFromRow: row => row,
				forceRefresh: true,
				refresh: async () => {
					throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
				},
				isDefinitiveFailure: error => error instanceof Error && error.message.includes("invalid_grant"),
				disabledCause: () => "oauth refresh failed",
				keepCredentialOnRefreshFailure: true,
				onRefreshFailure: error => failures.push(error),
			});

			expect(result.credential).toMatchObject({ type: "oauth", access: "access-0" });
			expect(String(failures[0])).toContain("stalled refresher");
			expect(storage.listStoredCredentials(PROVIDER)).toHaveLength(1);
			expect(store.getCredentialRefreshLeaseHolder?.(id)?.owner).toBe("stalled-peer");
			storage.close();
		} finally {
			temp[Symbol.dispose]();
		}
	});
});

describe("refresh lease budget", () => {
	test("a caller waiting on a held lease gives up at its budget without exchanging", async () => {
		const temp = TempDir.createSync("pi-oauth-shared-lease-budget-");
		try {
			const store = await SqliteAuthCredentialStore.open(temp.join("agent.db"));
			const storage = new AuthStorage(store, {});
			const id = await seed(storage, "access-0", "refresh-0");
			expect(store.tryAcquireCredentialRefreshLease(id, "peer", Date.now() + 60_000)).toBe(true);
			let exchanged = false;
			const started = Date.now();

			await expect(
				storage.refreshStoredOAuthCredential(PROVIDER, {
					credentialId: id,
					credentialFromRow: row => row,
					forceRefresh: true,
					refreshTimeoutMs: 50,
					refresh: async () => {
						exchanged = true;
						throw new Error("a held lease must not be exchanged");
					},
				}),
			).rejects.toMatchObject({ message: `OAuth token refresh timed out for provider: ${PROVIDER}` });
			expect(Date.now() - started).toBeLessThan(1_000);
			expect(exchanged).toBe(false);
			store.releaseCredentialRefreshLease(id, "peer");
			storage.close();
		} finally {
			temp[Symbol.dispose]();
		}
	});
});
