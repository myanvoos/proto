import { describe, expect, it } from "bun:test";
import * as AIError from "../error";
import type { UsageCredential, UsageFetchContext, UsageReport } from "../usage";
import { githubCopilotUsageProvider } from "./github-copilot";

type Route = () => Response;

function json(status: number, body: unknown): Response {
	return Response.json(body, { status });
}

function usageContext(routes: Record<string, Route>): UsageFetchContext {
	return {
		fetch: async input => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const route = routes[url.pathname];
			if (route) return route();
			return json(404, { message: "not found" });
		},
	};
}

const INTERNAL_USAGE = {
	copilot_plan: "individual",
	quota_reset_date: "2099-01-01T00:00:00Z",
	quota_snapshots: {
		premium_interactions: {
			entitlement: 300,
			remaining: 150,
			percent_remaining: 50,
			unlimited: false,
			overage_count: 0,
			overage_permitted: false,
			quota_id: "premium",
			quota_remaining: 150,
		},
	},
};

const BILLING_PATH = "/users/octocat/settings/billing/premium_request/usage";
const INTERNAL_PATH = "/copilot_internal/user";
const USER_PATH = "/user";

function apiKeyCredential(accountId?: string): UsageCredential {
	return { type: "api_key", apiKey: "copilot-token", ...(accountId ? { accountId } : {}) };
}

async function fetchUsage(credential: UsageCredential, ctx: UsageFetchContext): Promise<UsageReport | null> {
	return githubCopilotUsageProvider.fetchUsage(
		{ provider: "github-copilot", credential, signal: AbortSignal.timeout(5_000) },
		ctx,
	);
}

describe("GitHub Copilot usage auth consensus", () => {
	it("throws the auth rejection when every attempted endpoint rejects the token", async () => {
		const ctx = usageContext({
			[BILLING_PATH]: () => json(401, { message: "Bad credentials" }),
			[INTERNAL_PATH]: () => json(403, { message: "Forbidden" }),
		});

		const error = await fetchUsage(apiKeyCredential("octocat"), ctx).catch(reason => reason);
		expect(error).toBeInstanceOf(AIError.ProviderHttpError);
		expect((error as AIError.ProviderHttpError).status).toBe(403);
	});

	it("keeps the report on the transient path when a non-auth failure follows a rejection", async () => {
		const ctx = usageContext({
			[BILLING_PATH]: () => json(401, { message: "Bad credentials" }),
			[INTERNAL_PATH]: () => json(503, { message: "Unavailable" }),
		});

		expect(await fetchUsage(apiKeyCredential("octocat"), ctx)).toBeNull();
	});

	it("falls back to internal usage when only the billing endpoint rejects the token", async () => {
		const ctx = usageContext({
			[BILLING_PATH]: () => json(401, { message: "Bad credentials" }),
			[INTERNAL_PATH]: () => json(200, INTERNAL_USAGE),
		});

		const report = await fetchUsage(apiKeyCredential("octocat"), ctx);
		expect(report?.limits.map(limit => limit.id)).toEqual(["copilot:premium"]);
		expect(report?.metadata?.accountId).toBe("octocat");
	});

	it("counts a failed username lookup in the consensus", async () => {
		const rejecting = usageContext({
			[USER_PATH]: () => json(401, { message: "Bad credentials" }),
			[INTERNAL_PATH]: () => json(401, { message: "Bad credentials" }),
		});
		const rejectingError = await fetchUsage(apiKeyCredential(), rejecting).catch(reason => reason);
		expect(rejectingError).toBeInstanceOf(AIError.ProviderHttpError);

		// A transient lookup failure must keep the cached report instead of
		// purging it on the internal endpoint's rejection.
		const transient = usageContext({
			[USER_PATH]: () => json(503, { message: "Unavailable" }),
			[INTERNAL_PATH]: () => json(401, { message: "Bad credentials" }),
		});
		expect(await fetchUsage(apiKeyCredential(), transient)).toBeNull();
	});

	it("treats a malformed username response as a non-auth failure", async () => {
		const ctx = usageContext({
			[USER_PATH]: () => json(200, { message: "no login field" }),
			[INTERNAL_PATH]: () => json(401, { message: "Bad credentials" }),
		});

		expect(await fetchUsage(apiKeyCredential(), ctx)).toBeNull();
	});
});
