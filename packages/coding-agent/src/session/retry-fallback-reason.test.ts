import { afterEach, expect, test, vi } from "bun:test";
import { describeUsageFallback } from "./retry-fallback-reason";

afterEach(() => vi.restoreAllMocks());

test("plan-ineligible accounts are not described as exhausted quota", () => {
	// Usage health drops plan-ineligible accounts before computing the depleted state.
	const reason = describeUsageFallback({ state: "depleted", accounts: [] }, 30);
	expect(reason).toMatch(/eligible.*plan/);
	expect(reason).not.toMatch(/quota-exhausted|temporarily blocked/);
});

test("reports the earliest future reset, ignoring expired and non-finite resets", () => {
	const now = 1_900_000_000_000;
	vi.spyOn(Date, "now").mockReturnValue(now);
	const reason = describeUsageFallback(
		{
			state: "depleted",
			accounts: [now - 60_000, Infinity, NaN, now + 120_000, now + 60_000].map((resetsAt, credentialId) => ({
				credentialId,
				credentialType: "oauth" as const,
				state: "depleted" as const,
				resetsAt,
			})),
		},
		30,
	);
	expect(reason).toMatch(/quota-exhausted/);
	expect(reason).toMatch(/reset in 1m\b/);
	expect(reason).not.toMatch(/2m|0ms|NaN|Infinity/);
});
