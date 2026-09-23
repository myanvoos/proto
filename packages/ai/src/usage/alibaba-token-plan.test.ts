import { describe, expect, it, vi } from "bun:test";
import {
	ALIBABA_TOKEN_PLAN_CN_BASE_URL,
	serializeAlibabaTokenPlanCredential,
} from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";
import type { FetchImpl } from "../types";
import type { UsageFetchParams } from "../usage";
import { alibabaTokenPlanRankingStrategy, alibabaTokenPlanUsageProvider } from "./alibaba-token-plan";

const CHINA_SESSION_HTML = '<script>window.ALIYUN_CONSOLE_CONFIG = { SEC_TOKEN: "cn-sec-token" };</script>';

function params(apiKey: string): UsageFetchParams {
	return { provider: "alibaba-token-plan", credential: { type: "api_key", apiKey } };
}

function gatewayData(data: Record<string, unknown>): Response {
	return Response.json({ data: { DataV2: { data: { data } } }, successResponse: true });
}

describe("Alibaba Token Plan usage", () => {
	it("queries the Beijing gateway without pinning a workspace agent", async () => {
		const bodies: string[] = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			if (bodies.push(String(init?.body ?? "")) === 1) return new Response(CHINA_SESSION_HTML);
			return gatewayData({ per1WeekPercentage: 0.79, per1WeekResetTime: 1_786_716_480_000 });
		};
		const credential = serializeAlibabaTokenPlanCredential(
			"sk-sp-cn",
			"session_id=cn",
			ALIBABA_TOKEN_PLAN_CN_BASE_URL,
		);

		const report = await alibabaTokenPlanUsageProvider.fetchUsage(params(credential), { fetch: fetchMock });

		const gatewayParams: unknown = JSON.parse(new URLSearchParams(bodies[1]).get("params") ?? "null");
		expect(gatewayParams).toMatchObject({ Data: { cornerstoneParam: { switchUserType: 3 } } });
		expect(gatewayParams).not.toHaveProperty("Data.cornerstoneParam.switchAgent");
		expect(report?.limits.map(limit => limit.id)).toEqual(["credits:7d"]);
	});

	it("returns no report and logs the gateway error code when quota access is rejected", async () => {
		let requests = 0;
		const fetchMock: FetchImpl = async () =>
			++requests === 1
				? new Response(CHINA_SESSION_HTML)
				: Response.json({
						data: { success: false, errorCode: "BailianGateway.Workspace.NotAuthorised" },
						successResponse: true,
					});
		const warn = vi.fn();
		const credential = serializeAlibabaTokenPlanCredential(
			"sk-sp-cn",
			"session_id=cn",
			ALIBABA_TOKEN_PLAN_CN_BASE_URL,
		);

		const report = await alibabaTokenPlanUsageProvider.fetchUsage(params(credential), {
			fetch: fetchMock,
			logger: { warn, debug: () => {} },
		});

		expect(report).toBeNull();
		expect(warn).toHaveBeenCalledWith("Alibaba Token Plan usage request rejected", {
			provider: "alibaba-token-plan",
			errorCode: "BailianGateway.Workspace.NotAuthorised",
		});
	});

	it("reports a monthly-only plan as a duration-less monthly window kept out of ranking", async () => {
		let requests = 0;
		const fetchMock: FetchImpl = async () =>
			++requests === 1
				? Response.json({ data: { secToken: "sec-token", accountId: "account-1" } })
				: gatewayData({ per1MonthPercentage: 0.0104, per1MonthResetTime: 1_800_200_000_000 });
		const credential = serializeAlibabaTokenPlanCredential("sk-sp-intl", "session_id=intl");

		const report = await alibabaTokenPlanUsageProvider.fetchUsage(params(credential), { fetch: fetchMock });

		expect(report?.limits).toHaveLength(1);
		expect(report?.limits[0]).toMatchObject({
			id: "credits:monthly",
			scope: { windowId: "monthly" },
			window: { id: "monthly", resetsAt: 1_800_200_000_000 },
			amount: { usedFraction: 0.0104, unit: "percent" },
		});
		expect(report?.limits[0]?.window?.durationMs).toBeUndefined();
		const windows = alibabaTokenPlanRankingStrategy.findWindowLimits(report!, { modelId: "qwen3.7-plus" });
		expect(windows.primary).toBeUndefined();
		expect(windows.secondary).toBeUndefined();
	});
});
