import { describe, expect, it } from "bun:test";
import { isUsageLimit } from "./flags";
import { isUsageLimitOutcome } from "./rate-limit";

// MiniMax CN (minimax-code-cn) Token Plan exhaustion (2067) is phrased 用量上限,
// not 使用上限 like Zhipu. It is a persistent account-local cap: the account must
// rotate to a sibling credential instead of retrying the exhausted key.
const MINIMAX_CN_TOKEN_PLAN_429 =
	'{"type":"error","error":{"type":"rate_limit_error","message":"当前已达到 Token Plan 用量上限。为避免调用中断，请升级 Token Plan 套餐，或购买积分补充用量并开启积分自动消耗。 (2067)"}}';

describe("Simplified Chinese quota wording", () => {
	it("classifies MiniMax CN 用量上限 as account quota exhaustion", () => {
		expect(isUsageLimit(new Error(MINIMAX_CN_TOKEN_PLAN_429))).toBe(true);
		expect(isUsageLimitOutcome(429, MINIMAX_CN_TOKEN_PLAN_429)).toBe(true);
	});

	it("keeps 用量 rate and concurrency caps transient", () => {
		expect(isUsageLimitOutcome(429, "用量速率已达上限，请稍后重试")).toBe(false);
		expect(isUsageLimitOutcome(429, "用量并发已达上限")).toBe(false);
	});
});
