import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "./auth-storage";
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
