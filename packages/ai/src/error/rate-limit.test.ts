import { describe, expect, it } from "bun:test";
import { isBillingCapUsageLimit } from "./rate-limit";

describe("isBillingCapUsageLimit", () => {
	const lithos =
		"402 the organization is out of credit, add more to continue (type=insufficient_quota param=insufficient_quota)";

	it("recognises an out-of-credit balance on any status", () => {
		expect(isBillingCapUsageLimit(402, lithos)).toBe(true);
		expect(isBillingCapUsageLimit(undefined, lithos)).toBe(true);
		expect(isBillingCapUsageLimit(429, "Insufficient balance in account")).toBe(true);
		expect(isBillingCapUsageLimit(429, "OpenRouter: Insufficient credits")).toBe(true);
		expect(isBillingCapUsageLimit(403, "Your monthly spend limit has been reached")).toBe(true);
	});

	it("keeps a DashScope token throttle out of the billing lane", () => {
		expect(
			isBillingCapUsageLimit(
				429,
				"429 You exceeded your current quota, please check your plan and billing details. For details, see: https://help.aliyun.com/zh/model-studio/error-code#token-limit\nYou exceeded your current quota, please check your plan and billing details. For details, see: https://help.aliyun.com/zh/model-studio/error-code#token-limit (type=insufficient_quota param=insufficient_quota)",
			),
		).toBe(false);
	});

	it("keeps transient throttles and non-billing bodies out", () => {
		expect(isBillingCapUsageLimit(429, "Rate limit exceeded, too many requests")).toBe(false);
		expect(isBillingCapUsageLimit(402, "A subscription is required for this endpoint")).toBe(false);
		expect(isBillingCapUsageLimit(undefined, "503 service unavailable")).toBe(false);
	});
});
