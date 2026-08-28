import { ProviderHttpError } from "../error";
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
import { isRecord } from "../utils";
import { HOUR_MS } from "./shared";

const UMANS_PROVIDER = "umans";
const DEFAULT_ENDPOINT = "https://api.code.umans.ai";
const USAGE_PATH = "/v1/usage";

interface UmansUsagePayload {
	plan?: { display_name?: string };
	limits?: {
		requests?: { limit?: number; hard_cap?: number | null; window_seconds?: number };
		concurrency?: { limit?: number; hard_cap?: number | null };
	};

	window?: { started_at?: string; resets_at?: string; remaining_minutes?: number };
	usage?: {
		requests_in_window?: number;
		remaining_requests?: number;

		weighted_in_window?: number;
		weighted_remaining_requests?: number;
		concurrent_sessions?: number;
		tokens_in?: number;
		tokens_out?: number;
		priority?: { low?: boolean };
	};
}

function normalizeBaseUrl(baseUrl?: string): string {
	if (!baseUrl?.trim()) return DEFAULT_ENDPOINT;
	const trimmed = baseUrl.trim();

	const withoutTrailingSlash = trimmed.replace(/\/+$/, "");
	return withoutTrailingSlash.replace(/\/v1$/i, "") || DEFAULT_ENDPOINT;
}

function toFiniteNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return value;
}

function resolveStatus(usedFraction: number | undefined): UsageStatus | undefined {
	if (usedFraction === undefined) return undefined;
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

function softCapStatus(usedFraction: number | undefined): UsageStatus | undefined {
	if (usedFraction === undefined) return undefined;
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

function buildAmount(args: {
	used: number | undefined;
	limit: number | undefined;
	remaining: number | undefined;
	unit: UsageAmount["unit"];
}): UsageAmount {
	const used = args.used;
	const limit = args.limit;
	const usedFraction = used !== undefined && limit !== undefined && limit > 0 ? Math.min(used / limit, 1) : undefined;
	const remainingFraction = usedFraction !== undefined ? Math.max(1 - usedFraction, 0) : undefined;
	return {
		used,
		limit,
		remaining: args.remaining,
		usedFraction,
		remainingFraction,
		unit: args.unit,
	};
}

function buildRequestsLimits(payload: UmansUsagePayload, provider: string): UsageLimit[] {
	const limit = toFiniteNumber(payload.limits?.requests?.limit);
	const hardCap = toFiniteNumber(payload.limits?.requests?.hard_cap);
	const windowSeconds = toFiniteNumber(payload.limits?.requests?.window_seconds);
	const rawUsed = toFiniteNumber(payload.usage?.requests_in_window);
	const rawRemaining = toFiniteNumber(payload.usage?.remaining_requests);
	const weightedUsed = toFiniteNumber(payload.usage?.weighted_in_window);
	const weightedRemaining = toFiniteNumber(payload.usage?.weighted_remaining_requests);
	if (limit === undefined && rawUsed === undefined && weightedUsed === undefined) return [];

	let resetsAt: number | undefined;
	if (payload.window?.resets_at) {
		const parsed = Date.parse(payload.window.resets_at);
		resetsAt = Number.isNaN(parsed) ? undefined : parsed;
	}
	const window: UsageWindow = {
		id: "5h",
		label: "rolling 5h",
		durationMs: windowSeconds ? windowSeconds * 1000 : 5 * HOUR_MS,
		...(resetsAt !== undefined ? { resetsAt, resetLabel: "tick" } : {}),
	};

	if (weightedUsed === undefined || hardCap === undefined) {
		const amount = buildAmount({
			used: weightedUsed ?? rawUsed,
			limit,
			remaining: weightedUsed !== undefined ? weightedRemaining : rawRemaining,
			unit: "requests",
		});
		return [
			{
				id: "umans:requests",
				label: "Requests (rolling 5h)",
				scope: { provider, windowId: window.id, shared: true },
				window,
				amount,
				status: resolveStatus(amount.usedFraction),
			},
		];
	}

	const softAmount = buildAmount({ used: weightedUsed, limit, remaining: weightedRemaining, unit: "requests" });
	const limits: UsageLimit[] = [
		{
			id: "umans:requests:soft",
			label: "Requests (soft cap)",
			scope: { provider, windowId: window.id, shared: true },
			window,
			amount: softAmount,
			status: softCapStatus(softAmount.usedFraction),
		},
	];
	if (hardCap !== undefined && rawUsed !== undefined) {
		const hardAmount = buildAmount({ used: rawUsed, limit: hardCap, remaining: undefined, unit: "requests" });
		limits.push({
			id: "umans:requests:hard",
			label: "Requests (burst ceiling)",
			scope: { provider, windowId: window.id, shared: true },
			window,
			amount: hardAmount,
			status: resolveStatus(hardAmount.usedFraction),
		});
	}
	return limits;
}

function buildConcurrencyLimit(payload: UmansUsagePayload, provider: string): UsageLimit | null {
	const limit = toFiniteNumber(payload.limits?.concurrency?.limit);
	const used = toFiniteNumber(payload.usage?.concurrent_sessions);
	if (limit === undefined && used === undefined) return null;
	const amount = buildAmount({ used, limit, remaining: undefined, unit: "requests" });
	return {
		id: "umans:concurrency",
		label: "Concurrency",

		scope: { provider, windowId: "concurrency" },
		amount,
		status: resolveStatus(amount.usedFraction),
	};
}

async function fetchUmansUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== UMANS_PROVIDER) return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	const baseUrl = normalizeBaseUrl(params.baseUrl);
	const url = `${baseUrl}${USAGE_PATH}`;
	const headers: Record<string, string> = {
		authorization: `Bearer ${credential.apiKey}`,
		accept: "application/json",
	};

	let payload: UmansUsagePayload | null = null;
	try {
		const response = await ctx.fetch(url, { headers, signal: params.signal });
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				throw new ProviderHttpError(
					`Umans usage endpoint returned ${response.status} ${response.statusText}`.trim(),
					response.status,
				);
			}
			ctx.logger?.warn("Umans usage fetch failed", { status: response.status, statusText: response.statusText });
			return null;
		}
		const json = (await response.json()) as unknown;
		if (!isRecord(json)) {
			ctx.logger?.warn("Umans usage response was not a JSON object");
			return null;
		}
		payload = json as unknown as UmansUsagePayload;
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("Umans usage fetch error", { error: String(error) });
		return null;
	}

	const limits: UsageLimit[] = [...buildRequestsLimits(payload, params.provider)];
	const concurrency = buildConcurrencyLimit(payload, params.provider);
	if (concurrency) limits.push(concurrency);
	if (limits.length === 0) return null;

	const notes: string[] = [];
	if (payload.usage?.priority?.low === true) {
		notes.push("Requests deprioritized after a rate-limit burst.");
	}

	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		notes: notes.length > 0 ? notes : undefined,
		metadata: {
			plan: payload.plan?.display_name,
			accountId: credential.accountId,
			email: credential.email,
			endpoint: url,
		},
		raw: payload as Record<string, unknown>,
	};
}

export const umansUsageProvider: UsageProvider = {
	id: UMANS_PROVIDER,
	fetchUsage: fetchUmansUsage,
	supports: params => params.provider === UMANS_PROVIDER && params.credential.type === "api_key",
	validatesCredentials: true,
};
