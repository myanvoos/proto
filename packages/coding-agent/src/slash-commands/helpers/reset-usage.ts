import type { UsageResetCreditDetail } from "@oh-my-pi/pi-ai";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome, ResetCreditTarget } from "../../session/auth-storage";
import { summarizeUsageResetCredits } from "../../utils/usage-display";

/** One selectable saved-reset account row shared by the TUI selector and ACP. */
export interface ResetUsageAccount {
	label: string;
	provider: string;
	providerLabel: string;
	/** Banked resets, including grants that cannot be spent right now. */
	availableCount: number;
	/** Resets the provider currently permits this account to spend. */
	redeemableCount: number;
	target: {
		credentialId: number;
		provider: string;
		creditId?: string;
		accountId?: string;
		email?: string;
		orgId?: string;
	};
	active: boolean;
	error?: string;
	unavailableReason?: string;
	expiresAt?: string;
	credit?: UsageResetCreditDetail;
}

const CODEX_PROVIDER_ID = "openai-codex";
const CLAUDE_PROVIDER_ID = "anthropic";

/** Provider name shown beside each exact saved-reset account option. */
export function formatResetProviderName(provider: string): string {
	if (provider === CODEX_PROVIDER_ID) return "Codex";
	if (provider === CLAUDE_PROVIDER_ID) return "Claude";
	return provider;
}

export function toResetUsageAccounts(statuses: ResetCreditAccountStatus[]): ResetUsageAccount[] {
	return statuses
		.map(status => {
			const provider = status.provider;
			const providerLabel = formatResetProviderName(provider);
			const credit = status.nextCreditId
				? status.credits.find(candidate => candidate.id === status.nextCreditId)
				: (status.credits.find(candidate => candidate.usable !== false) ?? status.credits[0]);
			const advertisedRedeemable = status.redeemableCount ?? status.availableCount;
			const summary = summarizeUsageResetCredits(status);
			// Claude's listing endpoint chooses the one grant that may be spent.
			// Never degrade a missing pin into "spend whichever grant is current".
			const redeemableCount = provider === CLAUDE_PROVIDER_ID && !status.nextCreditId ? 0 : advertisedRedeemable;
			const identity = status.email ?? status.accountId ?? "account";
			const organization = status.orgName ?? status.orgId;
			const label = organization ? `${identity} · ${organization}` : identity;
			const unavailableReason =
				summary?.unavailableReason ??
				(provider === CLAUDE_PROVIDER_ID && advertisedRedeemable > 0 && !status.nextCreditId
					? "the provider did not identify a grant that can be safely spent"
					: undefined) ??
				(status.availableCount > 0 && redeemableCount === 0 ? "not usable right now" : undefined);
			return {
				label,
				provider,
				providerLabel,
				availableCount: status.availableCount,
				redeemableCount,
				target: {
					credentialId: status.credentialId,
					provider,
					...(status.accountId ? { accountId: status.accountId } : {}),
					...(status.email ? { email: status.email } : {}),
					...(status.orgId ? { orgId: status.orgId } : {}),
					...(status.nextCreditId ? { creditId: status.nextCreditId } : {}),
				} satisfies ResetCreditTarget,
				active: status.active,
				error: status.error,
				unavailableReason,
				expiresAt: summary?.soonestExpiry,
				credit,
			};
		})
		.sort((a, b) => {
			if (a.active !== b.active) return a.active ? -1 : 1;
			if (a.redeemableCount !== b.redeemableCount) return b.redeemableCount - a.redeemableCount;
			if (a.availableCount !== b.availableCount) return b.availableCount - a.availableCount;
			if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
			return a.label.localeCompare(b.label);
		});
}

export function describeRedeemOutcome(outcome: ResetCreditRedeemOutcome, label: string): string {
	const provider = outcome.provider ? ` (${formatResetProviderName(outcome.provider)})` : "";
	const reason = outcome.reason ? ` — ${outcome.reason}` : "";
	switch (outcome.code) {
		case "reset": {
			const cleared = outcome.cleared ?? [];
			const scope =
				cleared.length === 1 && cleared[0] === "anthropic:5h"
					? "Claude's 5h session limit has been refreshed; weekly limits are unchanged"
					: cleared.length > 0
						? `the covered rate-limit window${cleared.length === 1 ? " has" : "s have"} been refreshed`
						: "your rate-limit window has been refreshed";
			return `Reset applied for ${label}${provider} — ${scope}.`;
		}
		case "already_redeemed":
			return `${label}${provider}: that reset was already redeemed.`;
		case "no_credit":
			return `${label}${provider}: no saved resets available to spend${reason}.`;
		case "credit_list_failed":
			return `${label}${provider}: couldn't load this account's saved resets (network/auth) — nothing was spent, try again.`;
		case "nothing_to_reset":
			return `${label}${provider}: nothing to reset right now — your covered limits aren't constrained, so no credit was spent.`;
		case "no_account":
			return `Could not find the stored account ${label}${provider}.`;
		case "account_unavailable":
			return `${label}${provider}: could not authenticate this account — try /login.`;
		case "offer_changed":
			return `${label}${provider}: the reset offer changed — nothing was spent; reopen /usage reset.`;
		case "reset_in_progress":
			return `${label}${provider}: a reset is already in progress.`;
		case "reset_unconfirmed":
		case "network_error":
		case "malformed_response":
			return `${label}${provider}: couldn't confirm whether the reset applied — check /usage before trying again${reason}.`;
		default:
			return `${label}${provider}: reset was not confirmed (${outcome.code})${reason}.`;
	}
}
