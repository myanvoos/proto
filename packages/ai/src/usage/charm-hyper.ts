import { normalizeCharmHyperBaseUrl } from "@oh-my-pi/pi-catalog/wire/charm-hyper";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { ProviderHttpError } from "../error";
import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport } from "../usage";

const CHARM_HYPER_PROVIDER = "charm-hyper";
const CREDITS_PATH = "/credits";

/**
 * Charm Hyper sells prepaid credits: `/v1/credits` answers `{"balance": N}` with no allowance or reset
 * window, so the limit is remaining-only. The balance is account-wide (keys on one account drain one
 * pool) and the endpoint exposes no account identity, so the limit is `scope.shared`: consumers must
 * collapse, not sum, the per-key rows.
 */
async function fetchCharmHyperUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== CHARM_HYPER_PROVIDER) return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	// Honor a configured proxy: sending the stored key to the canonical host would fail for a
	// proxy-scoped credential and disclose it off-site.
	const creditsUrl = `${normalizeCharmHyperBaseUrl(params.baseUrl)}${CREDITS_PATH}`;

	let payload: unknown;
	try {
		const response = await ctx.fetch(creditsUrl, {
			headers: {
				Authorization: `Bearer ${credential.apiKey}`,
				Accept: "application/json",
			},
			signal: params.signal,
		});
		if (!response.ok) {
			// Only a thrown auth status purges the cached balance; `null` is the transient-failure path.
			if (response.status === 401 || response.status === 403) {
				throw new ProviderHttpError(
					`Charm Hyper credits endpoint returned ${response.status} ${response.statusText}`.trim(),
					response.status,
				);
			}
			ctx.logger?.warn("Charm Hyper usage fetch failed", {
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}
		payload = await response.json();
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("Charm Hyper usage fetch error", { error: String(error) });
		return null;
	}

	if (!isRecord(payload)) return null;
	const balance = payload.balance;
	if (typeof balance !== "number" || !Number.isFinite(balance)) return null;

	const limit: UsageLimit = {
		id: "charm-hyper:credits",
		label: "Credit balance",
		scope: { provider: params.provider, windowId: "balance", shared: true },
		amount: { remaining: balance, unit: "credits" },
	};

	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits: [limit],
		metadata: { endpoint: creditsUrl },
		raw: payload,
	};
}

export const charmHyperUsageProvider: UsageProvider = {
	id: CHARM_HYPER_PROVIDER,
	fetchUsage: fetchCharmHyperUsage,
	supports: params => params.provider === CHARM_HYPER_PROVIDER && params.credential.type === "api_key",
	validatesCredentials: true,
};
