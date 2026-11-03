import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "../auth-storage";
import type { FetchImpl } from "../types";
import { museCodeUsageProvider } from "./muse-code";

const accessToken = JSON.stringify({ oauthAccessToken: "meta-account-access", apiKey: "LLM|subscription-key" });
const credential = { type: "oauth" as const, accessToken, email: "stored@example.com" };

function keyEndpoint(respond: (requestIndex: number) => Response): { fetch: typeof fetch; requests: () => number } {
	let requests = 0;
	const fetchImpl = Object.assign(
		(input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			// Other providers with ambient env keys fan out through the same fetch.
			if (!url.includes("/muse-code/key")) return Promise.resolve(new Response(null, { status: 503 }));
			requests += 1;
			return Promise.resolve(respond(requests));
		},
		{ preconnect: fetch.preconnect },
	);
	return { fetch: fetchImpl, requests: () => requests };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Muse Code subscription usage", () => {
	test("an idle paid subscription resets the rolling window and bounds weekly carry by its reset", async () => {
		const now = 2_000_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const previous = await museCodeUsageProvider.fetchUsage(
			{ provider: "muse-code", credential },
			{
				fetch: async () =>
					Response.json({
						is_subs_active: true,
						subs_usage: {
							window: { used_percent: 100, window_duration_mins: 300, resets_at: now / 1000 - 1 },
							weekly: { used_percent: 75, resets_at: now / 1000 + 60 },
						},
					}),
			},
		);
		if (!previous) throw new Error("Expected active report");
		const idleContext = { previousReport: previous, fetch: async () => Response.json({ is_subs_active: true }) };
		const idle = await museCodeUsageProvider.fetchUsage({ provider: "muse-code", credential }, idleContext);
		expect(idle?.limits.map(limit => limit.amount.usedFraction)).toEqual([0, 0.75]);
		expect(idle?.limits[0]?.window?.resetsAt).toBeUndefined();
		vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
		const reset = await museCodeUsageProvider.fetchUsage({ provider: "muse-code", credential }, idleContext);
		expect(reset?.limits.map(limit => limit.amount.usedFraction)).toEqual([0, 0]);
		expect(reset?.limits[1]?.window?.resetsAt).toBe(now + 60_000 + 7 * 86_400_000);
		const unbounded = { ...previous, limits: previous.limits.map(limit => ({ ...limit, window: undefined })) };
		const bounded = await museCodeUsageProvider.fetchUsage(
			{ provider: "muse-code", credential },
			{ ...idleContext, previousReport: unbounded },
		);
		expect(bounded?.limits.map(limit => limit.id)).toEqual(["300m"]);
	});

	test("missing usage with a payment action or uncertain subscription is not misreported as idle", async () => {
		for (const payload of [
			{},
			{ is_subs_active: true, require_payment: true },
			{ is_subs_active: true, action_url: "https://pay.example" },
			{ is_subs_active: true, require_payment_action_url: "https://pay.example" },
		]) {
			const report = await museCodeUsageProvider.fetchUsage(
				{ provider: "muse-code", credential },
				{ fetch: async () => Response.json(payload) },
			);
			expect(report).toBeNull();
		}
	});

	test("maps the rolling and weekly quota windows from the key endpoint", async () => {
		let authorization = "";
		let requestBody: RequestInit["body"];
		const fetchImpl: FetchImpl = (_input, init) => {
			authorization = new Headers(init?.headers).get("Authorization") ?? "";
			requestBody = init?.body;
			return Promise.resolve(
				Response.json({
					api_key: "LLM|subscription-key",
					user_email: "Muse@Example.com",
					is_subs_active: true,
					subs_tier_name: "Power Usage",
					subs_usage: {
						window: { used_percent: 42, resets_at: 1_800_000_000, window_duration_mins: 300 },
						weekly: { used_percent: 75, resets_at: "2030-01-08T00:00:00.000Z" },
					},
				}),
			);
		};

		const report = await museCodeUsageProvider.fetchUsage(
			{ provider: "muse-code", credential },
			{ fetch: fetchImpl },
		);

		expect(authorization).toBe("Bearer meta-account-access");
		expect(requestBody).toBe("{}");
		expect(report?.metadata).toMatchObject({ email: "muse@example.com", tier: "Power Usage" });
		expect(report?.raw).not.toHaveProperty("api_key");
		expect(report?.limits).toMatchObject([
			{
				id: "300m",
				label: "5 Hours",
				amount: { used: 42, usedFraction: 0.42 },
				window: { durationMs: 18_000_000, resetsAt: 1_800_000_000_000 },
			},
			{
				id: "1w",
				label: "Weekly",
				amount: { used: 75, usedFraction: 0.75 },
				window: { durationMs: 604_800_000, resetsAt: Date.parse("2030-01-08T00:00:00.000Z") },
			},
		]);
	});

	test("does not report Meta PAYG credentials as Muse subscription quota", () => {
		expect(
			museCodeUsageProvider.supports?.({
				provider: "meta",
				credential: { type: "api_key", apiKey: "LLM|payg-key" },
			}),
		).toBe(false);
	});

	test("backs off for minutes after Meta rate-limits a quota refresh", async () => {
		const startedAt = 1_800_000_000_000;
		let now = startedAt;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const endpoint = keyEndpoint(request =>
			request === 1
				? Response.json({ status: 429 }, { status: 429 })
				: Response.json({
						is_subs_active: true,
						subs_usage: { window: { used_percent: 3, window_duration_mins: 300 } },
					}),
		);
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageFetch: endpoint.fetch,
		});
		try {
			await storage.set("muse-code", [
				{ type: "oauth", access: accessToken, refresh: "meta-refresh", expires: startedAt + 3_600_000 },
			]);

			expect(await storage.fetchUsageReports()).toEqual([]);
			now += 30_000;
			expect(await storage.fetchUsageReports()).toEqual([]);
			expect(endpoint.requests()).toBe(1);
			now += 5 * 60_000;
			expect(await storage.fetchUsageReports()).toHaveLength(1);
			expect(endpoint.requests()).toBe(2);
		} finally {
			storage.close();
		}
	});

	test("fails credential validation for an inactive subscription", async () => {
		const endpoint = keyEndpoint(() => Response.json({ is_subs_active: false }));
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageFetch: endpoint.fetch,
		});
		try {
			await storage.set("muse-code", [
				{ type: "oauth", access: accessToken, refresh: "meta-refresh", expires: Date.now() + 3_600_000 },
			]);
			const [result] = await storage.checkCredentials();
			expect(result?.ok).toBe(false);
			expect(result?.reason).toContain("inactive");
		} finally {
			storage.close();
		}
	});
});
