import type {
	OAuthAccountIdentity,
	ResetCreditAccountStatus,
	ResetCreditTarget,
	UsageReport,
	UsageResetCreditDetail,
} from "@oh-my-pi/pi-ai";
import type { CodexAutoRedeemMode } from "../config/settings-schema";
import { reportMatchesActiveAccount } from "../slash-commands/helpers/active-oauth-account";

const WINDOW_EXHAUSTED_MIN_FRACTION = 0.999;

const MAX_PLAUSIBLE_WEEKLY_REMAINING_MS = 7 * 24 * 3_600_000 + 60 * 60_000;

const MAX_PLAUSIBLE_PRIMARY_REMAINING_MS = 5 * 3_600_000 + 60 * 60_000;

export const SALVAGE_MIN_USED_FRACTION = 0.25;

export const REDEEM_RETRY_DEFER_MS = 30 * 60_000;

const REPORT_FRESHNESS_MS = 10 * 60_000;

const ATTEMPT_COOLDOWN_MS = 60_000;

const DEBOUNCE_BUCKET_MS = 60_000;

export const SWEEP_MIN_INTERVAL_MS = 60_000;

export function shouldEvaluateCodexAutoRedeem(mode: CodexAutoRedeemMode): boolean {
	return mode !== "no";
}

export function shouldPromptCodexAutoRedeem(mode: CodexAutoRedeemMode): boolean {
	return mode === "unset";
}

export type CodexResetTrigger = "blocked" | "sweep";

type CodexResetSkipReason =
	| "disabled"
	| "wrong-provider"
	| "spark-model"
	| "no-identity"
	| "stale-report"
	| "not-limit-reached"
	| "no-exhausted-window"
	| "deferred"
	| "no-reset-time"
	| "reset-too-soon"
	| "reset-implausible"
	| "credits-unknown"
	| "no-credits"
	| "reserve"
	| "no-expiring-credit"
	| "window-mostly-free"
	| "already-attempted"
	| "cooldown";

export interface CodexResetPlanInput {
	nowMs: number;
	trigger: CodexResetTrigger;

	provider: string;

	modelId: string;
	settings: {
		enabled: boolean;

		minBlockedMinutes: number;

		keepCredits: number;

		salvageHorizonMs: number;
	};

	identity: OAuthAccountIdentity | undefined;

	reports: UsageReport[] | null;
	attemptedKeys: ReadonlySet<string>;

	deferredUntilByKey: ReadonlyMap<string, number>;
	lastAttemptAtByAccount: ReadonlyMap<string, number>;

	activeBlockUnblockAtMs?: number;
}

export interface CodexResetAction {
	reason: "blocked-account" | "expiring-credit";
	target: ResetCreditTarget;
	accountKey: string;

	attemptKey: string;

	label: string;

	availableCount?: number;
	weeklyUsedFraction?: number;

	remainingMs?: number;

	blockedWindows?: ("5h" | "weekly")[];

	salvageWindow?: "5h" | "weekly";

	salvageUsedFraction?: number;

	expiresInMs?: number;

	active: boolean;
}

interface CodexResetSkip {
	accountKey: string;
	rule: "blocked-account" | "expiring-credit" | "account";
	reason: CodexResetSkipReason;
}

export interface CodexResetPlan {
	actions: CodexResetAction[];

	skipped: CodexResetSkip[];
}

function soonestCreditExpiryMs(
	credits: readonly UsageResetCreditDetail[] | undefined,
	nowMs: number,
): number | undefined {
	let soonest: number | undefined;
	for (const credit of credits ?? []) {
		if ((credit.status ?? "available") !== "available") continue;
		if (!credit.expiresAt) continue;
		const expiry = Date.parse(credit.expiresAt);
		if (Number.isNaN(expiry) || expiry <= nowMs) continue;
		if (soonest === undefined || expiry < soonest) soonest = expiry;
	}
	return soonest;
}

interface AccountSnapshot {
	accountKey: string;
	target: ResetCreditTarget;
	label: string;
	active: boolean;

	availableCount: number | undefined;
	primaryUsed: number | undefined;
	primaryResetsAt: number | undefined;
	weeklyUsed: number | undefined;
	weeklyResetsAt: number | undefined;
	limitReached: boolean;
	creditExpiresAtMs: number | undefined;
}

export function planCodexResetRedemptions(input: CodexResetPlanInput): CodexResetPlan {
	const { nowMs, settings } = input;
	const skipped: CodexResetSkip[] = [];
	if (!settings.enabled) return { actions: [], skipped: [{ accountKey: "*", rule: "account", reason: "disabled" }] };

	let blockedRuleActive = input.trigger === "blocked";
	if (blockedRuleActive && input.provider !== "openai-codex") {
		blockedRuleActive = false;
		skipped.push({ accountKey: "*", rule: "blocked-account", reason: "wrong-provider" });
	}
	if (blockedRuleActive && input.modelId.includes("-spark")) {
		blockedRuleActive = false;
		skipped.push({ accountKey: "*", rule: "blocked-account", reason: "spark-model" });
	}
	const salvageRuleActive = settings.salvageHorizonMs > 0;

	const snapshots: AccountSnapshot[] = [];

	let activeHasSnapshot = false;
	let activeKnownNoCredits = false;
	for (const report of input.reports ?? []) {
		if (report.provider !== "openai-codex") continue;
		const accountIdValue = report.metadata?.accountId;
		const emailValue = report.metadata?.email;
		const accountId = typeof accountIdValue === "string" && accountIdValue.trim() ? accountIdValue : undefined;
		const email = typeof emailValue === "string" && emailValue.trim() ? emailValue : undefined;

		const accountKey = (accountId ?? email)?.trim().toLowerCase();
		if (!accountKey) {
			skipped.push({ accountKey: "*", rule: "account", reason: "no-identity" });
			continue;
		}
		const isActive = reportMatchesActiveAccount(report, input.identity);
		if (nowMs - report.fetchedAt > REPORT_FRESHNESS_MS) {
			skipped.push({ accountKey, rule: "account", reason: "stale-report" });
			continue;
		}
		const available = report.resetCredits?.availableCount;

		if (available === undefined) {
			skipped.push({ accountKey, rule: "account", reason: "credits-unknown" });
			continue;
		}
		if (available < 1) {
			if (isActive) activeKnownNoCredits = true;
			skipped.push({ accountKey, rule: "account", reason: "no-credits" });
			continue;
		}
		const primary = report.limits.find(l => l.id === "openai-codex:primary");
		const weekly = report.limits.find(l => l.id === "openai-codex:secondary");
		if (isActive) activeHasSnapshot = true;
		snapshots.push({
			accountKey,
			target: { accountId, email },
			label: email ?? accountId ?? accountKey,
			active: isActive,
			availableCount: available,
			primaryUsed: primary?.amount.usedFraction,
			primaryResetsAt: primary?.window?.resetsAt,
			weeklyUsed: weekly?.amount.usedFraction,
			weeklyResetsAt: weekly?.window?.resetsAt,
			limitReached: report.metadata?.limitReached === true,
			creditExpiresAtMs: soonestCreditExpiryMs(report.resetCredits?.credits, nowMs),
		});
	}

	const cooledDown = (accountKey: string): boolean => {
		const lastAt = input.lastAttemptAtByAccount.get(accountKey);
		return lastAt !== undefined && nowMs - lastAt < ATTEMPT_COOLDOWN_MS;
	};

	let restore: CodexResetAction | undefined;
	if (blockedRuleActive) {
		interface RestoreCandidate {
			snapshot: AccountSnapshot;
			remainingMs: number;
			unblockAtMs: number;
			blockedWindows: ("5h" | "weekly")[];
		}
		const candidates: RestoreCandidate[] = [];
		for (const snapshot of snapshots) {
			const rule = "blocked-account" as const;
			const skip = (reason: CodexResetSkipReason) => skipped.push({ accountKey: snapshot.accountKey, rule, reason });

			const liveUnblockAtMs = snapshot.active ? input.activeBlockUnblockAtMs : undefined;

			if (!snapshot.limitReached && liveUnblockAtMs === undefined) {
				skip("not-limit-reached");
				continue;
			}

			const exhausted: { window: "5h" | "weekly"; resetsAt: number | undefined; plausibleMs: number }[] = [];
			if (snapshot.primaryUsed !== undefined && snapshot.primaryUsed >= WINDOW_EXHAUSTED_MIN_FRACTION) {
				exhausted.push({
					window: "5h",
					resetsAt: snapshot.primaryResetsAt,
					plausibleMs: MAX_PLAUSIBLE_PRIMARY_REMAINING_MS,
				});
			}
			if (snapshot.weeklyUsed !== undefined && snapshot.weeklyUsed >= WINDOW_EXHAUSTED_MIN_FRACTION) {
				exhausted.push({
					window: "weekly",
					resetsAt: snapshot.weeklyResetsAt,
					plausibleMs: MAX_PLAUSIBLE_WEEKLY_REMAINING_MS,
				});
			}
			let unblockAtMs: number;
			let blockedWindows: ("5h" | "weekly")[];
			if (exhausted.length > 0) {
				let latest = Number.NEGATIVE_INFINITY;
				let invalid: CodexResetSkipReason | undefined;
				for (const entry of exhausted) {
					if (entry.resetsAt === undefined) {
						invalid = "no-reset-time";
						break;
					}
					if (entry.resetsAt - nowMs > entry.plausibleMs) {
						invalid = "reset-implausible";
						break;
					}
					if (entry.resetsAt > latest) latest = entry.resetsAt;
				}
				if (invalid) {
					skip(invalid);
					continue;
				}
				unblockAtMs = latest;
				blockedWindows = exhausted.map(e => e.window);
			} else if (liveUnblockAtMs !== undefined) {
				if (liveUnblockAtMs - nowMs > MAX_PLAUSIBLE_WEEKLY_REMAINING_MS) {
					skip("reset-implausible");
					continue;
				}
				unblockAtMs = liveUnblockAtMs;
				blockedWindows = [liveUnblockAtMs - nowMs > MAX_PLAUSIBLE_PRIMARY_REMAINING_MS ? "weekly" : "5h"];
			} else {
				skip("no-exhausted-window");
				continue;
			}
			const remainingMs = unblockAtMs - nowMs;

			if (remainingMs < settings.minBlockedMinutes * 60_000) {
				skip("reset-too-soon");
				continue;
			}
			if ((snapshot.availableCount ?? 0) - Math.max(0, Math.trunc(settings.keepCredits)) < 1) {
				skip("reserve");
				continue;
			}
			if (input.attemptedKeys.has(blockedAttemptKey(snapshot.accountKey, unblockAtMs))) {
				skip("already-attempted");
				continue;
			}
			const deferredUntil = input.deferredUntilByKey.get(blockedAttemptKey(snapshot.accountKey, unblockAtMs));
			if (deferredUntil !== undefined && nowMs < deferredUntil) {
				skip("deferred");
				continue;
			}
			if (cooledDown(snapshot.accountKey)) {
				skip("cooldown");
				continue;
			}
			candidates.push({ snapshot, remainingMs, unblockAtMs, blockedWindows });
		}
		candidates.sort((a, b) => {
			if (a.snapshot.active !== b.snapshot.active) return a.snapshot.active ? -1 : 1;

			const aExpiry = a.snapshot.creditExpiresAtMs ?? Number.POSITIVE_INFINITY;
			const bExpiry = b.snapshot.creditExpiresAtMs ?? Number.POSITIVE_INFINITY;
			if (aExpiry !== bExpiry) return aExpiry - bExpiry;

			const aCount = a.snapshot.availableCount ?? 0;
			const bCount = b.snapshot.availableCount ?? 0;
			if (aCount !== bCount) {
				return bCount - aCount;
			}
			return b.remainingMs - a.remainingMs;
		});
		let best = candidates[0];

		if (!best && input.activeBlockUnblockAtMs !== undefined && !activeHasSnapshot && !activeKnownNoCredits) {
			const idValue = input.identity?.accountId;
			const emailValue = input.identity?.email;
			const accountId = typeof idValue === "string" && idValue.trim() ? idValue : undefined;
			const email = typeof emailValue === "string" && emailValue.trim() ? emailValue : undefined;
			const accountKey = (accountId ?? email)?.trim().toLowerCase();
			const unblockAtMs = input.activeBlockUnblockAtMs;
			const remainingMs = unblockAtMs - nowMs;
			const skip = (reason: CodexResetSkipReason) =>
				skipped.push({ accountKey: accountKey ?? "*", rule: "blocked-account", reason });
			if (!accountKey) {
				skip("no-identity");
			} else if (Math.max(0, Math.trunc(settings.keepCredits)) > 0) {
				skip("credits-unknown");
			} else if (remainingMs > MAX_PLAUSIBLE_WEEKLY_REMAINING_MS) {
				skip("reset-implausible");
			} else if (remainingMs < settings.minBlockedMinutes * 60_000) {
				skip("reset-too-soon");
			} else if (input.attemptedKeys.has(blockedAttemptKey(accountKey, unblockAtMs))) {
				skip("already-attempted");
			} else if ((input.deferredUntilByKey.get(blockedAttemptKey(accountKey, unblockAtMs)) ?? 0) > nowMs) {
				skip("deferred");
			} else if (cooledDown(accountKey)) {
				skip("cooldown");
			} else {
				best = {
					snapshot: {
						accountKey,
						target: { accountId, email },
						label: email ?? accountId ?? accountKey,
						active: true,
						availableCount: undefined,
						primaryUsed: undefined,
						primaryResetsAt: undefined,
						weeklyUsed: undefined,
						weeklyResetsAt: undefined,
						limitReached: true,
						creditExpiresAtMs: undefined,
					},
					remainingMs,
					unblockAtMs,
					blockedWindows: [remainingMs > MAX_PLAUSIBLE_PRIMARY_REMAINING_MS ? "weekly" : "5h"],
				};
			}
		}
		if (best) {
			restore = {
				reason: "blocked-account",
				target: best.snapshot.target,
				accountKey: best.snapshot.accountKey,
				attemptKey: blockedAttemptKey(best.snapshot.accountKey, best.unblockAtMs),
				label: best.snapshot.label,
				availableCount: best.snapshot.availableCount,
				weeklyUsedFraction: best.snapshot.weeklyUsed,
				remainingMs: best.remainingMs,
				expiresInMs:
					best.snapshot.creditExpiresAtMs === undefined ? undefined : best.snapshot.creditExpiresAtMs - nowMs,
				blockedWindows: best.blockedWindows,
				active: best.snapshot.active,
			};
		}
	}

	const salvages: CodexResetAction[] = [];
	if (salvageRuleActive) {
		for (const snapshot of snapshots) {
			if (snapshot.accountKey === restore?.accountKey) continue;
			const rule = "expiring-credit" as const;
			const skip = (reason: CodexResetSkipReason) => skipped.push({ accountKey: snapshot.accountKey, rule, reason });
			const expiresAtMs = snapshot.creditExpiresAtMs;
			if (expiresAtMs === undefined || expiresAtMs - nowMs > settings.salvageHorizonMs) {
				skip("no-expiring-credit");
				continue;
			}

			const primaryUsed = snapshot.primaryUsed ?? 0;
			const weeklyUsed = snapshot.weeklyUsed ?? 0;
			const salvageUsedFraction = Math.max(primaryUsed, weeklyUsed);
			if (salvageUsedFraction < SALVAGE_MIN_USED_FRACTION) {
				skip("window-mostly-free");
				continue;
			}
			const salvageWindow: "5h" | "weekly" = primaryUsed >= weeklyUsed ? "5h" : "weekly";
			const attemptKey = salvageAttemptKey(snapshot.accountKey, expiresAtMs);
			if (input.attemptedKeys.has(attemptKey)) {
				skip("already-attempted");
				continue;
			}
			const deferredUntil = input.deferredUntilByKey.get(attemptKey);
			if (deferredUntil !== undefined && nowMs < deferredUntil) {
				skip("deferred");
				continue;
			}
			if (cooledDown(snapshot.accountKey)) {
				skip("cooldown");
				continue;
			}
			salvages.push({
				reason: "expiring-credit",
				target: snapshot.target,
				accountKey: snapshot.accountKey,
				attemptKey,
				label: snapshot.label,
				availableCount: snapshot.availableCount,
				weeklyUsedFraction: snapshot.weeklyUsed,
				salvageWindow,
				salvageUsedFraction,
				expiresInMs: expiresAtMs - nowMs,
				active: snapshot.active,
			});
		}
		salvages.sort((a, b) => (a.expiresInMs ?? 0) - (b.expiresInMs ?? 0));
	}

	const actions = restore ? [restore, ...salvages] : salvages;
	return { actions, skipped };
}

export function blockedAttemptKey(accountKey: string, weeklyResetsAtMs: number): string {
	return `block|${accountKey}|${Math.round(weeklyResetsAtMs / DEBOUNCE_BUCKET_MS)}`;
}

export function salvageAttemptKey(accountKey: string, creditExpiresAtMs: number): string {
	return `salvage|${accountKey}|${Math.round(creditExpiresAtMs / DEBOUNCE_BUCKET_MS)}`;
}

export function overlayLiveResetCredits(
	reports: UsageReport[] | null,
	statuses: readonly ResetCreditAccountStatus[],
): UsageReport[] | null {
	if (!reports) return reports;
	return reports.map(report => {
		if (report.provider !== "openai-codex") return report;
		const status = statuses.find(
			s =>
				(!!s.accountId && s.accountId === report.metadata?.accountId) ||
				(!!s.email && s.email === report.metadata?.email),
		);
		if (!status || status.error) return { ...report, resetCredits: undefined };
		return {
			...report,
			resetCredits: {
				availableCount: status.availableCount,
				credits: status.credits
					.filter(credit => (credit.status ?? "available") === "available")
					.map(credit => ({ grantedAt: credit.grantedAt, expiresAt: credit.expiresAt, status: credit.status })),
			},
		};
	});
}

export function isTerminalRedeemOutcome(code: string): boolean {
	return code === "reset" || code === "already_redeemed" || code === "no_credit";
}

export interface CodexAutoRedeemCoordinator {
	attemptedKeys: Set<string>;
	deferredUntilByKey: Map<string, number>;
	lastAttemptAtByAccount: Map<string, number>;
	inFlightByAccount: Map<string, Promise<boolean>>;
	sweepInFlight: boolean;
	lastSweepAt: number;

	sweepPromise: Promise<void> | undefined;
	notifiedKeys: Set<string>;
}

export function createCodexAutoRedeemCoordinator(): CodexAutoRedeemCoordinator {
	return {
		attemptedKeys: new Set(),
		deferredUntilByKey: new Map(),
		lastAttemptAtByAccount: new Map(),
		inFlightByAccount: new Map(),
		sweepInFlight: false,
		lastSweepAt: 0,
		sweepPromise: undefined,
		notifiedKeys: new Set(),
	};
}

export const defaultCodexAutoRedeemCoordinator: CodexAutoRedeemCoordinator = createCodexAutoRedeemCoordinator();
