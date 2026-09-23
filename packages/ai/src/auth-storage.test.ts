import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type AuthAccountPolicy, AuthStorage, SqliteAuthCredentialStore } from "./auth-storage";
import { ProviderHttpError } from "./error";
import type { UsageProvider, UsageReport } from "./usage";

const HOUR_MS = 60 * 60 * 1000;

describe("AuthStorage quota reset deadlines", () => {
	it("blocks an exhausted credential until every overlapping quota window resets", async () => {
		const usageByKey = new Map<string, UsageReport>();
		const usageProvider: UsageProvider = {
			id: "zai",
			async fetchUsage(params) {
				const apiKey = params.credential.apiKey;
				return apiKey ? (usageByKey.get(apiKey) ?? null) : null;
			},
			supports: params => params.provider === "zai" && params.credential.type === "api_key",
		};
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "zai" ? usageProvider : undefined),
		});

		try {
			await authStorage.set("zai", [
				{ type: "api_key", key: "zai-exhausted", source: "login" },
				{ type: "api_key", key: "zai-healthy", source: "login" },
			]);
			const now = Date.now();
			const earlyReset = now + HOUR_MS;
			const finalReset = now + 24 * HOUR_MS;
			usageByKey.set("zai-exhausted", {
				provider: "zai",
				fetchedAt: now,
				limits: [
					{
						id: "zai:requests:5h",
						label: "ZAI Request Quota",
						scope: { provider: "zai", windowId: "5h", shared: true },
						window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: earlyReset },
						amount: { unit: "requests", used: 100, limit: 100, remaining: 0 },
						status: "exhausted",
					},
					{
						id: "zai:tokens:1w",
						label: "ZAI Weekly Token Quota",
						scope: { provider: "zai", windowId: "1w", shared: true },
						window: { id: "1w", label: "Weekly", durationMs: 7 * 24 * HOUR_MS, resetsAt: finalReset },
						amount: { unit: "tokens", used: 140_000, limit: 140_000, remaining: 0 },
						status: "exhausted",
					},
				],
			});
			usageByKey.set("zai-healthy", { provider: "zai", fetchedAt: now, limits: [] });

			expect(await authStorage.getApiKey("zai", "session-overlap")).toBe("zai-healthy");
			const blockedRow = store
				.listAuthCredentials("zai")
				.find(entry => entry.credential.type === "api_key" && entry.credential.key === "zai-exhausted");
			if (!blockedRow) throw new Error("exhausted credential missing");
			expect(store.getCredentialBlock(blockedRow.id, "zai:api_key", "")).toBe(finalReset);
		} finally {
			authStorage.close();
		}
	});
});

describe("AuthStorage credential pool across processes", () => {
	it("rotates onto an account another process added mid-session", async () => {
		using dir = TempDir.createSync("@proto-auth-external-");
		const dbPath = path.join(dir.path(), "agent.db");
		const session = await AuthStorage.create(dbPath);
		const otherProcess = await AuthStorage.create(dbPath);
		try {
			await session.set("anthropic", { type: "api_key", key: "sk-ant-first", source: "login" });
			expect(await session.getApiKey("anthropic", "session-1")).toBe("sk-ant-first");
			const usageLimit = Object.assign(new Error("429 usage limit reached"), { status: 429 });
			expect(await session.rotateSessionCredential("anthropic", "session-1", { error: usageLimit })).toBe(false);

			otherProcess.upsertCredential("anthropic", { type: "api_key", key: "sk-ant-second", source: "login" });

			expect(await session.rotateSessionCredential("anthropic", "session-1", { error: usageLimit })).toBe(true);
			expect(await session.getApiKey("anthropic", "session-1")).toBe("sk-ant-second");
		} finally {
			session.close();
			otherProcess.close();
		}
	});
});

describe("AuthStorage usage block healing", () => {
	it("a live healthy counter report lifts that counter's stale block and keeps an exhausted sibling's", async () => {
		const db = new Database(":memory:");
		const store = new SqliteAuthCredentialStore(db);
		const now = Date.now();
		const counter = (key: string, usedFraction: number): UsageReport["limits"][number] => ({
			id: `google-antigravity:${key}:default:weekly`,
			label: key,
			scope: { provider: "google-antigravity", windowId: "7d" },
			window: { id: "7d", label: "Weekly", durationMs: 7 * 24 * HOUR_MS, resetsAt: now + 6 * 24 * HOUR_MS },
			amount: { unit: "percent", usedFraction, remainingFraction: 1 - usedFraction },
			status: usedFraction >= 1 ? "exhausted" : "ok",
		});
		const usageProvider: UsageProvider = {
			id: "google-antigravity",
			async fetchUsage() {
				return {
					provider: "google-antigravity",
					fetchedAt: Date.now(),
					limits: [counter("google", 0.1), counter("anthropic", 1)],
				};
			},
			supports: params => params.provider === "google-antigravity",
		};
		const authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "google-antigravity" ? usageProvider : undefined),
		});
		try {
			await authStorage.set("google-antigravity", {
				type: "oauth",
				access: "ya29.recovered",
				refresh: "refresh",
				expires: now + HOUR_MS,
				accountId: "acct-recovered",
				projectId: "proj-recovered",
			});
			const row = store.listAuthCredentials("google-antigravity")[0];
			if (!row) throw new Error("credential row missing");
			// A 429 retry-after pointed at the weekly reset, days before Google restored the Gemini quota.
			const weekAhead = now + 6 * 24 * HOUR_MS;
			for (const blockScope of ["counter:google", "counter:anthropic"]) {
				store.upsertCredentialBlock({
					credentialId: row.id,
					providerKey: "google-antigravity:oauth",
					blockScope,
					blockedUntilMs: weekAhead,
				});
			}
			// Age the rows past the post-429 window in which a lagging /usage may not clear a block.
			db.prepare("UPDATE auth_credential_blocks SET updated_at = ?").run(Math.floor((now - 10 * 60_000) / 1000));
			store.cleanExpiredCredentialBlocks(now + 10 * 60_000);

			await authStorage.fetchUsageReports();

			expect(store.getCredentialBlock(row.id, "google-antigravity:oauth", "counter:google")).toBeUndefined();
			expect(store.getCredentialBlock(row.id, "google-antigravity:oauth", "counter:anthropic")).toBe(weekAhead);
		} finally {
			authStorage.close();
		}
	});
});

describe("AuthStorage stale OAuth bearer attribution", () => {
	it("an organization denial for a since-refreshed bearer still rotates off that account", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const authStorage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		const expires = Date.now() + 24 * HOUR_MS;
		try {
			await authStorage.set("anthropic", [
				{ type: "oauth", access: "quota-access", refresh: "quota-refresh", expires, orgId: "quota-org" },
				{ type: "oauth", access: "denied-access", refresh: "denied-refresh", expires, orgId: "denied-org" },
				{ type: "oauth", access: "healthy-access", refresh: "healthy-refresh", expires, orgId: "healthy-org" },
			]);
			const sessionId = "session-policy-refresh";
			const quotaKey = await authStorage.getApiKey("anthropic", sessionId);
			expect(quotaKey).toBe("quota-access");
			const usageLimit = Object.assign(new Error("429 usage limit reached"), { status: 429 });
			await authStorage.rotateSessionCredential("anthropic", sessionId, { error: usageLimit, apiKey: quotaKey });
			const deniedKey = await authStorage.getApiKey("anthropic", sessionId);
			expect(deniedKey).toBe("denied-access");

			// Another process refreshes the denied account's token before the 403 lands.
			const deniedRow = store
				.listAuthCredentials("anthropic")
				.find(row => row.credential.type === "oauth" && row.credential.access === deniedKey);
			if (deniedRow?.credential.type !== "oauth") throw new Error("expected denied OAuth credential");
			store.updateAuthCredential(deniedRow.id, { ...deniedRow.credential, access: "denied-refreshed" });
			await authStorage.reload();

			const switched = await authStorage.rotateSessionCredential("anthropic", sessionId, {
				error: new ProviderHttpError("OAuth authentication is currently not allowed for this organization.", 403, {
					code: "oauth_not_allowed_for_organization",
				}),
				apiKey: deniedKey,
			});

			expect(switched).toBe(true);
			expect(await authStorage.getApiKey("anthropic", sessionId)).toBe("healthy-access");
		} finally {
			authStorage.close();
		}
	});
});

describe("AuthStorage OAuth refresh write-back", () => {
	it("keeps subtype refresh material across consecutive refreshes that return bare grants", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const seenTokenUrls: unknown[] = [];
		let refreshes = 0;
		const authStorage = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
			refreshOAuthCredential: async (_provider, _credentialId, credential) => {
				seenTokenUrls.push((credential as { tokenUrl?: unknown }).tokenUrl);
				refreshes++;
				return { access: `fresh-${refreshes}`, refresh: `rotated-${refreshes}`, expires: Date.now() + HOUR_MS };
			},
		});
		try {
			const provider = "mcp_oauth:https://mcp.example.test/mcp";
			const tokenUrl = "https://mcp.example.test/token";
			await authStorage.set(provider, {
				type: "oauth",
				access: "stale",
				refresh: "initial",
				expires: Date.now() - 1,
				tokenUrl,
			} as Parameters<AuthStorage["set"]>[1]);
			const row = store.listAuthCredentials(provider)[0];
			if (!row) throw new Error("credential row missing");

			await authStorage.refreshCredentialById(row.id);
			await authStorage.refreshCredentialById(row.id);

			expect(seenTokenUrls).toEqual([tokenUrl, tokenUrl]);
			const stored = store.listAuthCredentials(provider)[0]?.credential;
			expect(stored).toMatchObject({ access: "fresh-2", refresh: "rotated-2", tokenUrl });
		} finally {
			authStorage.close();
		}
	});
});

describe("AuthStorage session credential inheritance", () => {
	it("a child session starts on the account its parent is pinned to", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const authStorage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		const account = (id: string) => ({
			type: "oauth" as const,
			access: `access-${id}`,
			refresh: `refresh-${id}`,
			expires: Date.now() + HOUR_MS,
			accountId: `account-${id}`,
		});
		try {
			await authStorage.set("openai-codex", [account("a"), account("b")]);
			const pinned = store
				.listAuthCredentials("openai-codex")
				.find(row => row.credential.type === "oauth" && row.credential.access === "access-b");
			if (!pinned) throw new Error("credential row missing");
			expect(authStorage.pinSessionOAuthAccount("openai-codex", "parent", pinned.id)).toBe(true);

			expect(authStorage.inheritSessionCredentials("parent", "child")).toBe(1);
			expect(await authStorage.getApiKey("openai-codex", "child")).toBe("access-b");
			expect(authStorage.getOAuthAccountIdentity("openai-codex", "child")?.accountId).toBe("account-b");
		} finally {
			authStorage.close();
		}
	});
});

describe("AuthStorage per-client usage attribution", () => {
	it("aggregates one install's burn per app, reporting legacy unlabeled rows without an app", () => {
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		try {
			const entry = (inputTokens: number) => ({
				at: Date.now(),
				provider: "anthropic",
				model: "claude-x",
				requests: 1,
				inputTokens,
				outputTokens: 1,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: 0.01,
			});
			authStorage.recordClientUsage({ installId: "box", hostname: "box", app: "proto", entries: [entry(10)] });
			authStorage.recordClientUsage({ installId: "box", app: "bot", entries: [entry(20)] });
			authStorage.recordClientUsage({ installId: "box", app: "proto", entries: [entry(5)] });
			authStorage.recordClientUsage({ installId: "box", entries: [entry(1)] });

			const [client] = authStorage.getClientUsageSummary(0).clients;
			expect(client?.hostname).toBe("box");
			const byApp = new Map(client?.providers.map(usage => [usage.app, usage.inputTokens]));
			expect(byApp).toEqual(
				new Map<string | undefined, number>([
					["proto", 15],
					["bot", 20],
					[undefined, 1],
				]),
			);
		} finally {
			authStorage.close();
		}
	});
});

describe("AuthStorage account routing policies", () => {
	const PROVIDER = "acme-oauth";
	const account = (id: string) => ({
		type: "oauth" as const,
		access: `access-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + HOUR_MS,
		email: `${id}@example.com`,
	});
	function createPolicyStorage(options: {
		remaining: Record<string, number>;
		policies: AuthAccountPolicy[];
		defaultReservePct?: number;
	}) {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const usageProvider: UsageProvider = {
			id: PROVIDER,
			async fetchUsage(params) {
				const id = params.credential.accessToken?.replace("access-", "");
				const remaining = id === undefined ? undefined : options.remaining[id];
				if (remaining === undefined) return null;
				return {
					provider: PROVIDER,
					fetchedAt: Date.now(),
					limits: [
						{
							id: `${PROVIDER}:weekly`,
							label: "Weekly",
							scope: { provider: PROVIDER, windowId: "7d" },
							window: { id: "7d", label: "Weekly", durationMs: 7 * 24 * HOUR_MS },
							amount: { unit: "percent", usedFraction: 1 - remaining, remainingFraction: remaining },
							status: "ok",
						},
					],
				};
			},
			supports: params => params.provider === PROVIDER,
		};
		const authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === PROVIDER ? usageProvider : undefined),
			rankingStrategyResolver: () => undefined,
			accountPolicies: options.policies,
			defaultReservePct: options.defaultReservePct,
		});
		return { store, authStorage };
	}

	it("routes to the higher-priority account unless it sits inside its reserve", async () => {
		const remaining: Record<string, number> = { a: 0.6, b: 0.6 };
		const { authStorage } = createPolicyStorage({
			remaining,
			policies: [{ provider: PROVIDER, account: { email: "b@example.com" }, priority: 10 }],
		});
		try {
			await authStorage.set(PROVIDER, [account("a"), account("b")]);
			expect(await authStorage.getApiKey(PROVIDER, "fresh-1")).toBe("access-b");

			remaining.b = 0.05;
			await authStorage.invalidateUsageCache(PROVIDER);
			expect(await authStorage.getApiKey(PROVIDER, "fresh-2")).toBe("access-a");
		} finally {
			authStorage.close();
		}
	});

	it("reserve evicts a warm automatic pin but never an explicit user pin", async () => {
		const remaining: Record<string, number> = { a: 0.6, b: 0.6 };
		const { store, authStorage } = createPolicyStorage({
			remaining,
			policies: [{ provider: PROVIDER, account: { email: "a@example.com" }, priority: 10, reservePct: 20 }],
		});
		try {
			await authStorage.set(PROVIDER, [account("a"), account("b")]);
			expect(await authStorage.getApiKey(PROVIDER, "automatic")).toBe("access-a");
			const rowA = store
				.listAuthCredentials(PROVIDER)
				.find(row => row.credential.type === "oauth" && row.credential.email === "a@example.com");
			if (!rowA) throw new Error("credential row missing");
			expect(authStorage.pinSessionOAuthAccount(PROVIDER, "explicit", rowA.id)).toBe(true);

			remaining.a = 0.15;
			await authStorage.invalidateUsageCache(PROVIDER);
			expect(await authStorage.getApiKey(PROVIDER, "automatic")).toBe("access-b");
			expect(await authStorage.getApiKey(PROVIDER, "explicit")).toBe("access-a");
		} finally {
			authStorage.close();
		}
	});

	it("reports per-account reserve overrides in model usage health", async () => {
		const { authStorage } = createPolicyStorage({
			remaining: { a: 0.3, b: 0.3 },
			policies: [{ provider: PROVIDER, account: { email: "a@example.com" }, reservePct: 40 }],
			defaultReservePct: 10,
		});
		try {
			await authStorage.set(PROVIDER, [account("a"), account("b")]);
			const health = await authStorage.getModelUsageHealth(PROVIDER, { reserveFraction: Number.NaN });
			expect(health.accounts.map(entry => entry.state).sort()).toEqual(["healthy", "reserve"]);
			expect(health.state).toBe("healthy");
		} finally {
			authStorage.close();
		}
	});

	it("rejects a policy that matches no stored account or several", async () => {
		const unmatched = createPolicyStorage({
			remaining: {},
			policies: [{ provider: PROVIDER, account: { email: "missing@example.com" } }],
		});
		try {
			await expect(unmatched.authStorage.set(PROVIDER, [account("a")])).rejects.toThrow(
				"matches no stored OAuth account",
			);
		} finally {
			unmatched.authStorage.close();
		}
		const ambiguous = createPolicyStorage({
			remaining: {},
			policies: [{ provider: PROVIDER, account: { email: "a@example.com" } }],
		});
		try {
			await expect(
				ambiguous.authStorage.set(PROVIDER, [
					account("a"),
					{ ...account("a2"), email: "a@example.com", accountId: "other" },
				]),
			).rejects.toThrow("matches 2 stored OAuth accounts");
		} finally {
			ambiguous.authStorage.close();
		}
	});
});
