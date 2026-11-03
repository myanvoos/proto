import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { AccountPolicies, parseAuthAccountPolicies } from "./auth/account-policy";
import {
	isSameOAuthAccount,
	matchesReplacementCredential,
	resolveCredentialIdentityKey,
} from "./auth/sqlite-credential-store";
import { AuthBrokerClient } from "./auth-broker/client";
import { AuthBrokerRefresher } from "./auth-broker/refresher";
import { startAuthBroker } from "./auth-broker/server";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "./auth-storage";
import { OAuthRefreshUnavailableError, ProviderHttpError } from "./error";
import type { UsageProvider, UsageReport } from "./usage";

function credential(access = "token", expires = Date.now() + 3_600_000): OAuthCredential {
	return { type: "oauth", access, refresh: `refresh-${access}`, expires, email: `${access}@example.test` };
}

test("request resolution reports an OAuth outage without losing login or blocking availability fallbacks", async () => {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const storage = new AuthStorage(store, {
		refreshOAuthCredential: async () => {
			throw new ProviderHttpError("service unavailable", 503);
		},
	});
	try {
		await storage.set("anthropic", credential("expired", 0));
		expect(await storage.getApiKey("anthropic")).toBeUndefined();
		await expect(
			storage.getApiKey("anthropic", "request", { throwOnTransientOAuthRefreshFailure: true }),
		).rejects.toBeInstanceOf(OAuthRefreshUnavailableError);
		expect(storage.listStoredCredentials("anthropic")).toHaveLength(1);
		storage.setConfigApiKey("anthropic", "fallback", { fallback: true });
		expect(await storage.getApiKey("anthropic", "request", { throwOnTransientOAuthRefreshFailure: true })).toBe(
			"fallback",
		);
	} finally {
		storage.close();
	}
});

test("usage probes preserve credentials on definitive refresh errors while auth recovery disables them", async () => {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const storage = new AuthStorage(store, {
		refreshOAuthCredential: async () => {
			throw new Error("invalid_grant");
		},
	});
	try {
		await storage.set("anthropic", credential("expired", 0));
		const id = storage.listStoredCredentials("anthropic")[0]!.id;
		await expect(storage.refreshCredentialById(id, undefined, { reason: "usage-probe" })).rejects.toThrow();
		expect(storage.listStoredCredentials("anthropic")).toHaveLength(1);
		await expect(storage.refreshCredentialById(id, undefined, { reason: "auth-recovery" })).rejects.toThrow();
		expect(storage.listStoredCredentials("anthropic")).toHaveLength(0);
	} finally {
		storage.close();
	}
});

test("reclaim returns an automatic pin to the higher-priority recovered account but preserves explicit pins", async () => {
	const remaining = new Map([
		["primary", 0.05],
		["fallback", 0.9],
	]);
	const provider: UsageProvider = {
		id: "anthropic",
		supports: () => true,
		fetchUsage: async params => ({
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "quota",
					label: "quota",
					scope: { provider: "anthropic" },
					amount: { unit: "percent", remainingFraction: remaining.get(params.credential.accessToken ?? "") },
					status: "ok",
				},
			],
		}),
	};
	const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
		usageProviderResolver: id => (id === "anthropic" ? provider : undefined),
		rankingStrategyResolver: () => undefined,
		accountPolicies: [
			{ provider: "anthropic", account: { email: "primary@example.test" }, priority: 10, reclaimAbovePct: 80 },
		],
	});
	try {
		await storage.set("anthropic", [credential("primary"), credential("fallback")]);
		expect(await storage.getApiKey("anthropic", "automatic")).toBe("fallback");
		remaining.set("primary", 0.95);
		await storage.invalidateUsageCache("anthropic");
		expect(await storage.getApiKey("anthropic", "automatic")).toBe("primary");
		const fallbackId = storage
			.listStoredCredentials("anthropic")
			.find(row => row.credential.type === "oauth" && row.credential.access === "fallback")!.id;
		storage.pinSessionOAuthAccount("anthropic", "explicit", fallbackId);
		expect(await storage.getApiKey("anthropic", "explicit")).toBe("fallback");
	} finally {
		storage.close();
	}
});

test("reclaim validates the effective reserve and refuses policy thresholds without a usage source", () => {
	expect(
		() =>
			new AccountPolicies(
				parseAuthAccountPolicies([{ provider: "anthropic", account: { email: "a" }, reclaimAbovePct: 20 }]),
				20,
			),
	).toThrow();
	const policies = new AccountPolicies([{ provider: "anthropic", account: { email: "a" }, reclaimAbovePct: 80 }]);
	expect(() => policies.validateUsageCapability("anthropic", false)).toThrow();
});

test("a waiter whose refresh budget elapsed never starts an exchange after acquiring ownership", async () => {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const storage = new AuthStorage(store);
	let exchanges = 0;
	try {
		await storage.set("anthropic", credential("expired", 0));
		const id = storage.listStoredCredentials("anthropic")[0]!.id;
		store.tryAcquireCredentialRefreshLease(id, "peer", Date.now() + 10_000);
		await expect(
			storage.refreshStoredOAuthCredential("anthropic", {
				credentialId: id,
				credentialFromRow: row => row,
				refreshTimeoutMs: 5,
				refresh: async current => {
					exchanges++;
					return current;
				},
			}),
		).rejects.toThrow(/timed out/);
		expect(exchanges).toBe(0);
	} finally {
		storage.close();
	}
});

test("broker refresher retries the next sweep after a storage reload outage", async () => {
	const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	const reload = spyOn(storage, "reload").mockRejectedValueOnce(new Error("busy"));
	try {
		const refresher = new AuthBrokerRefresher({ storage, now: () => 100, refreshIntervalMs: 500 });
		await refresher.tick();
		await refresher.tick();
		expect(reload).toHaveBeenCalledTimes(2);
		expect(refresher.getSchedule().nextSweepAt).toBe(600);
	} finally {
		reload.mockRestore();
		storage.close();
	}
});

test("provider-scoped broker usage never waits for unrelated cold providers", async () => {
	const called: string[] = [];
	const provider: UsageProvider = {
		id: "zai",
		supports: () => true,
		fetchUsage: async params => {
			called.push(params.provider);
			return { provider: params.provider, fetchedAt: Date.now(), limits: [] };
		},
	};
	const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
		usageProviderResolver: () => provider,
	});
	await storage.set("zai", { type: "api_key", key: "zai-key" });
	await storage.set("kimi-code", { type: "api_key", key: "kimi-key" });
	const handle = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: ["secret"], disableRefresher: true });
	try {
		const client = new AuthBrokerClient({ url: handle.url, token: "secret", maxRetries: 0 });
		const { reports } = await client.fetchUsage({ provider: "zai" });
		expect(reports.every((report: UsageReport) => report.provider === "zai")).toBe(true);
		expect(called).toEqual(["zai"]);
	} finally {
		await handle.close();
		storage.close();
	}
});

test("a shorter sibling replacement retires a successfully mirrored cooldown", async () => {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const storage = new AuthStorage(store, {
		usageProviderResolver: () => undefined,
		rankingStrategyResolver: () => undefined,
	});
	try {
		await storage.set("anthropic", credential("blocked"));
		const id = storage.listStoredCredentials("anthropic")[0]!.id;
		const first = await storage.markUsageLimitReached("anthropic", "session", {
			credentialId: id,
			retryAfterMs: 60_000,
			providerTimed: true,
		});
		store.deleteCredentialBlock(id, "anthropic:oauth", "");
		const replacement = Date.now() + 5_000;
		store.upsertCredentialBlock({
			credentialId: id,
			providerKey: "anthropic:oauth",
			blockScope: "",
			blockedUntilMs: replacement,
		});
		const next = await storage.markUsageLimitReached("anthropic", "session", {
			credentialId: id,
			retryAfterMs: 1000,
			providerTimed: true,
		});
		expect(first.blockedUntilMs).toBeGreaterThan(replacement);
		expect(next.priorBlockedUntilMs).toBe(replacement);
	} finally {
		storage.close();
	}
});

test("refresh completion never resurrects a sibling deleted during the exchange", async () => {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const storage = new AuthStorage(store);
	try {
		await storage.set("anthropic", [credential("one", 0), credential("two")]);
		const rows = storage.listStoredCredentials("anthropic");
		const result = await storage.refreshStoredOAuthCredential("anthropic", {
			credentialId: rows[0]!.id,
			credentialFromRow: row => row,
			refresh: async current => {
				store.deleteAuthCredential(rows[1]!.id, "removed by sibling");
				return { ...current, access: "fresh", expires: Date.now() + 3_600_000 };
			},
		});
		expect(result.credential?.access).toBe("fresh");
		expect(storage.listStoredCredentials("anthropic").map(row => row.id)).toEqual([rows[0]!.id]);
	} finally {
		storage.close();
	}
});

test("revived account affinity preserves a transcript pin unless the parent pin is explicit", async () => {
	const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
		usageProviderResolver: () => undefined,
		rankingStrategyResolver: () => undefined,
	});
	try {
		await storage.set("anthropic", [credential("one"), credential("two")]);
		const rows = storage.listStoredCredentials("anthropic");
		await storage.getApiKey("anthropic", "parent");
		storage.pinSessionOAuthAccount("anthropic", "child", rows[1]!.id);
		const include = (provider: string, explicit: boolean) =>
			explicit || storage.getOAuthAccountIdentity(provider, "child") === undefined;
		storage.inheritSessionCredentials("parent", "child", include);
		expect(await storage.getApiKey("anthropic", "child")).toBe("two");
		storage.pinSessionOAuthAccount("anthropic", "parent", rows[0]!.id);
		storage.inheritSessionCredentials("parent", "child", include);
		expect(await storage.getApiKey("anthropic", "child")).toBe("one");
	} finally {
		storage.close();
	}
});

test("broker SSE fans credential updates and removals to every subscriber without stale snapshot rows", async () => {
	const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await storage.set("anthropic", [credential("one"), credential("two")]);
	const rows = storage.listStoredCredentials("anthropic");
	const handle = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: ["secret"], disableRefresher: true });
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]);
	const client = new AuthBrokerClient({ url: handle.url, token: "secret", maxRetries: 0 });
	const streams = [client.openSnapshotStream({ signal }), client.openSnapshotStream({ signal })];
	try {
		const initial = await Promise.all(streams.map(stream => stream.next()));
		for (const result of initial) {
			expect(result.value).toMatchObject({
				kind: "snapshot",
				credentials: [{ id: rows[0]!.id }, { id: rows[1]!.id }],
			});
		}
		const updates = streams.map(stream => stream.next());
		await storage.set("anthropic", { ...credential("one"), access: "renewed" });
		for (const result of await Promise.all(updates)) {
			expect(result.value).toMatchObject({
				kind: "entry",
				entry: { id: rows[0]!.id, credential: { access: "renewed" } },
			});
		}
		for (const result of await Promise.all(streams.map(stream => stream.next()))) {
			expect(result.value).toMatchObject({ kind: "removed", id: rows[1]!.id });
		}
		const latest = await client.fetchSnapshot();
		expect(latest.status === 200 && latest.snapshot.credentials.map(row => row.id)).toEqual([rows[0]!.id]);
	} finally {
		controller.abort();
		await Promise.all(streams.map(stream => stream.return(undefined)));
		await handle.close();
		storage.close();
	}
});

test("sampling credentials leaves no session affinity in memory or durable storage", async () => {
	const db = new Database(":memory:");
	const storage = new AuthStorage(new SqliteAuthCredentialStore(db), {
		usageProviderResolver: () => undefined,
		rankingStrategyResolver: () => undefined,
	});
	try {
		await storage.set("anthropic", [credential("one"), credential("two")]);
		await storage.getApiKey("anthropic", "sample", { recordAffinity: false });
		expect(storage.inheritSessionCredentials("sample", "child")).toBe(0);
		expect(db.query("SELECT key FROM cache WHERE key LIKE 'session:sticky:%'").all()).toEqual([]);
		await storage.getApiKey("anthropic", "live");
		expect(storage.inheritSessionCredentials("live", "child")).toBe(1);
	} finally {
		storage.close();
	}
});

test("forced by-id access remints a fresh bearer and retains the selected row after a sibling removal", async () => {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	let siblingId = -1;
	let exchanges = 0;
	const storage = new AuthStorage(store, {
		refreshOAuthCredential: async (_provider, _id, current) => {
			exchanges++;
			store.deleteAuthCredential(siblingId, "removed by peer");
			return { ...current, access: "renewed", refresh: "rotated" };
		},
	});
	try {
		await storage.set("anthropic", [credential("sibling"), credential("selected")]);
		const rows = storage.listStoredCredentials("anthropic");
		siblingId = rows[0]!.id;
		const selectedId = rows[1]!.id;
		const result = await storage.getOAuthAccessByCredentialId("anthropic", selectedId, { forceRefresh: true });
		expect(result).toMatchObject({ ok: true, credentialId: selectedId, accessToken: "renewed" });
		expect(exchanges).toBe(1);
		expect(storage.listStoredCredentials("anthropic").map(row => row.id)).toEqual([selectedId]);
	} finally {
		storage.close();
	}
});

test("usage cache drops raw payloads and expires last-good data from its original observation rather than failed retries", async () => {
	const db = new Database(":memory:");
	const started = Date.now();
	let now = started;
	let available = true;
	const provider: UsageProvider = {
		id: "anthropic",
		supports: () => true,
		fetchUsage: async () =>
			available
				? {
						provider: "anthropic",
						fetchedAt: started,
						limits: [],
						raw: { credentialLikePayload: "private" },
					}
				: null,
	};
	const storage = new AuthStorage(new SqliteAuthCredentialStore(db), { usageProviderResolver: () => provider });
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	try {
		await storage.set("anthropic", credential("one", started + 48 * 3_600_000));
		expect(await storage.fetchUsageReports()).toHaveLength(1);
		const rows = db.query<{ value: string }, []>("SELECT value FROM cache WHERE key LIKE 'usage_cache:%'").all();
		expect(rows).toHaveLength(1);
		expect(JSON.parse(rows[0]!.value).value.raw).toBeUndefined();
		available = false;
		now = started + 20 * 60_000;
		expect(await storage.fetchUsageReports()).toMatchObject([{ fetchedAt: started }]);
		now = started + 25 * 3_600_000;
		expect(await storage.fetchUsageReports()).toEqual([]);
	} finally {
		clock.mockRestore();
		storage.close();
	}
});

test("configured account priority wins over a sibling whose usage fetch happened to succeed", async () => {
	const provider: UsageProvider = {
		id: "anthropic",
		supports: () => true,
		fetchUsage: async params =>
			params.credential.accessToken === "preferred"
				? null
				: { provider: "anthropic", fetchedAt: Date.now(), limits: [] },
	};
	const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
		usageProviderResolver: () => provider,
		rankingStrategyResolver: () => undefined,
		accountPolicies: [{ provider: "anthropic", account: { email: "preferred@example.test" }, priority: 10 }],
	});
	try {
		await storage.set("anthropic", [credential("other"), credential("preferred")]);
		expect(await storage.getApiKey("anthropic", "session")).toBe("preferred");
	} finally {
		storage.close();
	}
});

test("broker migration identity matching distinguishes users sharing a project or workspace and recognizes canonical aliases", () => {
	const google = { ...credential("first"), projectId: "aicode-consumers" };
	const googlePeer = { ...credential("other"), projectId: "aicode-consumers" };
	expect(
		matchesReplacementCredential(
			"google-antigravity",
			google,
			resolveCredentialIdentityKey("google-antigravity", google),
			googlePeer,
		),
	).toBe(false);
	expect(isSameOAuthAccount(google, googlePeer)).toBe(false);
	const first = { ...credential("first"), accountId: "workspace", orgId: "workspace" };
	const other = { ...credential("other"), accountId: "workspace", orgId: "workspace" };
	expect(
		matchesReplacementCredential("openai-codex", first, resolveCredentialIdentityKey("openai-codex", first), other),
	).toBe(false);
	expect(isSameOAuthAccount(first, other)).toBe(false);
	const alias = { ...first, access: "fresh", accountId: "new-account-key" };
	expect(isSameOAuthAccount(first, alias)).toBe(true);
	expect(isSameOAuthAccount(first, { ...alias, orgId: "different-workspace" })).toBe(false);
});
