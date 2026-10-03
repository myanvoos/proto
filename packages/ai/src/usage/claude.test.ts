import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "../types";
import type { UsageFetchParams } from "../usage";
import { claudeUsageProvider } from "./claude";

const params: UsageFetchParams = {
	provider: "anthropic",
	credential: { type: "oauth", accessToken: "sk-ant-oat-test", accountId: "acct_1", email: "a@example.com" },
};

function usageFetch(probeStatus: () => number): FetchImpl {
	return async input => {
		const url = new URL(String(input));
		const body = {
			five_hour: { utilization: 25, resets_at: "2099-09-23T00:00:00Z" },
			cedar_ember: null,
			juniper_tide: null,
		};
		if (url.pathname.endsWith("/profile")) return Response.json({ organization: { uuid: "org_1" } });
		if (!url.searchParams.has("cedar_ember")) return Response.json(body);
		if (probeStatus() !== 200) return Response.json({ error: "rate_limited" }, { status: probeStatus() });
		return Response.json({
			...body,
			cedar_ember: {
				eligible: true,
				grants: [
					{
						id: "grant_1",
						label: "Anytime reset",
						resets_left: 1,
						usable_now: true,
						clears: ["five_hour"],
						blocking: [],
					},
				],
				next_grant_id: "grant_1",
			},
		});
	};
}

describe("Claude usage saved resets", () => {
	it("keeps the last known saved resets when a later reset probe fails", async () => {
		let status = 200;
		const fetch = usageFetch(() => status);
		const first = await claudeUsageProvider.fetchUsage(params, { fetch, retryWait: async () => {} });
		expect(first?.resetCredits).toMatchObject({ availableCount: 1, nextCreditId: "grant_1" });
		if (!first) throw new Error("expected a Claude usage report");

		// Anthropic rate-limits `/usage` per source IP: the plain read succeeds while the reset probe is refused.
		status = 429;
		const second = await claudeUsageProvider.fetchUsage(params, {
			fetch,
			retryWait: async () => {},
			previousReport: first,
		});
		expect(second?.resetCredits).toMatchObject({ availableCount: 1, nextCreditId: "grant_1" });
	});
});
