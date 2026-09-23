import { describe, expect, it } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { formatUsageBreakdown } from "./usage-cli";

const HOUR_MS = 60 * 60 * 1000;

function report(email: string, usedFraction: number): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: 0,
		metadata: { email },
		limits: [
			{
				id: "anthropic:7d",
				label: "Weekly",
				scope: { provider: "anthropic", windowId: "7d" },
				window: { id: "7d", label: "Weekly", durationMs: 168 * HOUR_MS },
				amount: { unit: "percent", usedFraction, remainingFraction: 1 - usedFraction },
				status: "ok",
			},
		],
	};
}

describe("formatUsageBreakdown account policy diagnostics", () => {
	it("shows each policy-routed account's priority, reserve source, and reserve state", () => {
		const text = Bun.stripANSI(
			formatUsageBreakdown(
				[report("work@example.com", 0.8), report("home@example.com", 0.2)],
				[],
				0,
				undefined,
				[],
				{
					globalReservePct: 10,
					getAccountPolicy: (_provider, identity) =>
						identity.email === "work@example.com"
							? { provider: "anthropic", account: { email: "work@example.com" }, priority: 5, reservePct: 25 }
							: undefined,
				},
			),
		);
		expect(text).toContain("policy: priority 5 · reserve 25% (override) · inside reserve · 20.0% left");
		expect(text).toContain("policy: priority 0 · reserve 10% (global) · eligible · 80.0% left");
	});
});
