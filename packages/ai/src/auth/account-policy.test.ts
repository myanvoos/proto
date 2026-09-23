import { describe, expect, it } from "bun:test";
import { parseAuthAccountPolicies } from "./account-policy";

describe("parseAuthAccountPolicies", () => {
	it("accepts selector/priority/reserve policies and rejects typos and out-of-range reserves", () => {
		expect(
			parseAuthAccountPolicies([
				{ provider: "anthropic", account: { email: "a@example.com", orgId: "org" }, priority: 5, reservePct: 20 },
			]),
		).toEqual([
			{ provider: "anthropic", account: { email: "a@example.com", orgId: "org" }, priority: 5, reservePct: 20 },
		]);
		expect(() => parseAuthAccountPolicies([{ provider: "anthropic", account: { email: "a" }, priorty: 1 }])).toThrow(
			"auth.accountPolicies[0] has unknown fields: priorty",
		);
		expect(() => parseAuthAccountPolicies([{ provider: "anthropic", account: { orgId: "org" } }])).toThrow(
			"must include at least one of email, accountId, or projectId",
		);
		expect(() =>
			parseAuthAccountPolicies([{ provider: "anthropic", account: { email: "a" }, reservePct: 150 }]),
		).toThrow("reservePct must be a finite number between 0 and 100");
	});
});
