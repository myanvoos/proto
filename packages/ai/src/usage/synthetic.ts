import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { parseIsoTimestamp, WEEK_MS } from "./shared";

const QUOTAS_URL = "https://api.synthetic.new/v2/quotas";

function buildUsageAmount(args: {
	used: number | undefined;
	limit: number | undefined;
	remaining: number | undefined;
	usedFraction: number | undefined;
	unit: UsageAmount["unit"];
}): UsageAmount {
	let usedFraction = args.usedFraction;
	if (usedFraction === undefined && args.used !== undefined && args.limit !== undefined && args.limit > 0) {
		usedFraction = Math.min(args.used / args.limit, 1);
	}
	const remainingFraction = usedFraction !== undefined ? Math.max(1 - usedFraction, 0) : undefined;
	return {
		...(args.used !== undefined ? { used: args.used } : {}),
		...(args.limit !== undefined ? { limit: args.limit } : {}),
		...(args.remaining !== undefined ? { remaining: args.remaining } : {}),
		...(usedFraction !== undefined ? { usedFraction } : {}),
		...(remainingFraction !== undefined ? { remainingFraction } : {}),
		unit: args.unit,
	};
}

function getUsageStatus(usedFraction: number | undefined): UsageStatus | undefined {
	if (usedFraction === undefined) return undefined;
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

/**
 * The plan's weekly credit quota, regenerated incrementally every ~202
 * minutes. Only `percentRemaining` is authoritative for usage; `nextRegenPercent`
 * (typically 2) describes the per-tick regen rate.
 */
function parsePlanWeeklyLimit(raw: unknown, provider: UsageFetchParams["provider"]): UsageLimit | null {
	if (!isRecord(raw)) return null;
	const percentRemaining = typeof raw.percentRemaining === "number" ? raw.percentRemaining : undefined;
	const nextRegenAt = parseIsoTimestamp(raw.nextRegenAt);
	const nextRegenPercent = typeof raw.nextRegenPercent === "number" ? raw.nextRegenPercent : undefined;

	if (percentRemaining === undefined) return null;

	const usedFraction = Math.min(Math.max(1 - percentRemaining / 100, 0), 1);
	const window: UsageWindow = {
		id: "7d",
		label: nextRegenPercent !== undefined ? `7d · regen ${nextRegenPercent}%/tick` : "7d",
		durationMs: WEEK_MS,
		...(nextRegenAt !== undefined ? { resetsAt: nextRegenAt, resetLabel: "regen" } : {}),
	};
	const amount = buildUsageAmount({
		used: undefined,
		limit: undefined,
		remaining: undefined,
		usedFraction,
		unit: "percent",
	});
	return {
		id: "synthetic:usd:7d",
		label: "Synthetic Credits",
		scope: { provider, windowId: "7d", shared: true },
		window,
		amount,
		status: getUsageStatus(usedFraction),
	};
}

async function fetchSyntheticUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== "synthetic") return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	let payload: unknown = null;
	try {
		const response = await ctx.fetch(QUOTAS_URL, {
			headers: {
				Authorization: `Bearer ${credential.apiKey}`,
				"Content-Type": "application/json",
			},
			signal: params.signal,
		});
		if (!response.ok) {
			ctx.logger?.warn("Synthetic usage fetch failed", { status: response.status, statusText: response.statusText });
			return null;
		}
		payload = await response.json();
	} catch (error) {
		ctx.logger?.warn("Synthetic usage fetch error", { error: String(error) });
		return null;
	}

	if (!isRecord(payload)) return null;

	const weekly = parsePlanWeeklyLimit(payload.planWeeklyLimit, params.provider);
	if (!weekly) return null;

	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits: [weekly],
		metadata: { endpoint: QUOTAS_URL },
		raw: payload,
	};
}

export const syntheticUsageProvider: UsageProvider = {
	id: "synthetic",
	fetchUsage: fetchSyntheticUsage,
	supports: params => params.provider === "synthetic" && params.credential.type === "api_key",
};
