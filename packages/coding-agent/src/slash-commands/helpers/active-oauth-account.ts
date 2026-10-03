import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { OAuthAccountIdentity } from "../../session/auth-storage";

/** Live Codex plan from the usage payload; Codex's `orgName` is the stale login-time plan, not a workspace. */
export function codexUsagePlan(report: UsageReport): string | undefined {
	if (report.provider !== "openai-codex") return undefined;
	const plan = report.metadata?.planType;
	if (typeof plan !== "string" || !plan.trim()) return undefined;
	return sanitizeText(plan.trim().replace(/[\r\n\t]+/g, " "));
}

/** Codex usage label: qualified by workspace only when another report shares the email, then the live plan. */
export function formatCodexUsageReportLabel(
	report: UsageReport,
	peers: readonly UsageReport[],
	base: string,
	redaction?: Map<string, string>,
	includePlan = true,
	orgStyle: "inline" | "parenthesized" = "parenthesized",
): string {
	const email = report.metadata?.email;
	const collision =
		typeof email === "string" && !!email && peers.some(peer => peer !== report && peer.metadata?.email === email);
	const rawOrg = collision
		? (report.metadata?.orgId ?? report.metadata?.accountId ?? `account ${peers.indexOf(report) + 1}`)
		: undefined;
	const clean = (value: string): string => sanitizeText((redaction?.get(value) ?? value).replace(/[\r\n\t]+/g, " "));
	const org =
		typeof rawOrg === "string" && rawOrg && rawOrg !== base
			? orgStyle === "inline"
				? ` · ${clean(rawOrg)}`
				: ` (${clean(rawOrg)})`
			: "";
	const plan = includePlan ? codexUsagePlan(report) : undefined;
	return `${clean(base)}${org}${plan ? ` · plan: ${plan}` : ""}`;
}

function normalizeIdentityValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

export function formatActiveAccountLabel(identity: OAuthAccountIdentity | undefined): string | undefined {
	if (!identity) return undefined;
	const base = identity.email || identity.accountId || identity.projectId;
	if (!base) return undefined;
	const org = identity.orgName || identity.orgId;
	return org && org !== base ? `${base} (${org})` : base;
}

export function limitMatchesActiveAccount(
	report: UsageReport,
	limit: UsageLimit,
	identity: OAuthAccountIdentity | undefined,
): boolean {
	if (!identity) return false;
	const metadata = report.metadata ?? {};
	const activeAccountId = normalizeIdentityValue(identity.accountId);
	const activeEmail = normalizeIdentityValue(identity.email);
	const activeProjectId = normalizeIdentityValue(identity.projectId);
	const activeOrgId = normalizeIdentityValue(identity.orgId);
	const reportOrgId = normalizeIdentityValue(metadata.orgId);

	if (activeOrgId || reportOrgId) {
		if (activeOrgId !== reportOrgId) return false;
		if (!activeAccountId && !activeEmail && !activeProjectId) return true;
	}
	if (activeAccountId) {
		const reportAccountId = normalizeIdentityValue(metadata.accountId) ?? normalizeIdentityValue(metadata.account_id);
		if (reportAccountId === activeAccountId) return true;
		if (normalizeIdentityValue(limit.scope.accountId) === activeAccountId) return true;
	}
	if (activeEmail && normalizeIdentityValue(metadata.email) === activeEmail) return true;
	if (activeProjectId) {
		if (normalizeIdentityValue(metadata.projectId) === activeProjectId) return true;
		if (normalizeIdentityValue(limit.scope.projectId) === activeProjectId) return true;
	}
	return false;
}

export function reportMatchesActiveAccount(report: UsageReport, identity: OAuthAccountIdentity | undefined): boolean {
	if (!identity) return false;
	return report.limits.some(limit => limitMatchesActiveAccount(report, limit, identity));
}
