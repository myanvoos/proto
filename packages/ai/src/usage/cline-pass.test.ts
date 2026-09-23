import { describe, expect, it } from "bun:test";
import { ProviderHttpError } from "../error";
import type { FetchImpl } from "../types";
import { clinePassUsageProvider } from "./cline-pass";

function fetchUsage(fetch: FetchImpl) {
	return clinePassUsageProvider.fetchUsage(
		{ provider: "cline-pass", credential: { type: "api_key", apiKey: "sk_test" } },
		{ fetch },
	);
}

describe("ClinePass quota windows", () => {
	it("reports each plan window as a percent limit and resolves the account identity", async () => {
		const fetch: FetchImpl = async input => {
			const url = String(input);
			if (url.endsWith("/users/me/plan/usage-limits")) {
				return Response.json({
					data: {
						limits: [
							{ type: "five_hour", percentUsed: 92, resetsAt: "2026-09-24T05:00:00Z" },
							{ type: "weekly", percentUsed: 40 },
							{ type: "lifetime", percentUsed: 1 },
						],
					},
				});
			}
			if (url.endsWith("/users/me")) return Response.json({ data: { id: "usr_1", email: "dev@example.com" } });
			throw new Error(`unexpected ${url}`);
		};
		const report = await fetchUsage(fetch);
		expect(report?.limits.map(limit => [limit.window?.id, limit.amount.usedFraction, limit.status])).toEqual([
			["5h", 0.92, "warning"],
			["7d", 0.4, "ok"],
		]);
		expect(report?.limits[0]?.window?.resetsAt).toBe(Date.parse("2026-09-24T05:00:00Z"));
		expect(report?.metadata).toMatchObject({ email: "dev@example.com", accountId: "usr_1" });
	});

	it("throws on a rejected key so the cached report is purged", async () => {
		const fetch: FetchImpl = async () => new Response("unauthorized", { status: 401 });
		await expect(fetchUsage(fetch)).rejects.toBeInstanceOf(ProviderHttpError);
	});
});
