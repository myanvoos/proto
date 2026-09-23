import * as AIError from "../error";
import type { OAuthCredentials } from "../registry/oauth/types";

/** Default remaining quota protected for accounts without an explicit policy override. */
export const DEFAULT_USAGE_RESERVE_PCT = 10;

type AccountIdentity = Pick<OAuthCredentials, "email" | "accountId" | "projectId" | "orgId">;

export interface AuthAccountSelector {
	readonly email?: string;
	readonly accountId?: string;
	readonly projectId?: string;
	/** Optional organization/workspace qualifier; not a base identity by itself. */
	readonly orgId?: string;
}

export interface AuthAccountPolicy {
	readonly provider: string;
	readonly account: AuthAccountSelector;
	/** Higher values win after hard, plan, reserve, hot-window, and measured-usage safety checks. */
	readonly priority?: number;
	/** Protected remaining quota percentage for this account. */
	readonly reservePct?: number;
}

export type AuthAccountPolicies = readonly AuthAccountPolicy[];

const POLICY_FIELDS = new Set(["provider", "account", "priority", "reservePct"]);
const SELECTOR_FIELDS = ["email", "accountId", "projectId", "orgId"] as const;
const BASE_IDENTITY_FIELDS = ["email", "accountId", "projectId"] as const;

/** Whether every identity field set on `selector` matches `identity`. */
export function matchesAuthAccountSelector(selector: AuthAccountSelector, identity: AccountIdentity): boolean {
	return (
		(selector.email === undefined || selector.email === identity.email) &&
		(selector.accountId === undefined || selector.accountId === identity.accountId) &&
		(selector.projectId === undefined || selector.projectId === identity.projectId) &&
		(selector.orgId === undefined || selector.orgId === identity.orgId)
	);
}

/** Strictly parse `auth.accountPolicies` from untrusted config; unknown fields and bad values are errors. */
export function parseAuthAccountPolicies(value: unknown): AuthAccountPolicies {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new AIError.ConfigurationError("auth.accountPolicies must be an array");
	return value.map((entry, index) => {
		const path = `auth.accountPolicies[${index}]`;
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			throw new AIError.ConfigurationError(`${path} must be an object`);
		}
		const policy = entry as Record<string, unknown>;
		const unknownPolicyFields = Object.keys(policy).filter(key => !POLICY_FIELDS.has(key));
		if (unknownPolicyFields.length > 0) {
			throw new AIError.ConfigurationError(`${path} has unknown fields: ${unknownPolicyFields.join(", ")}`);
		}
		const account = policy.account;
		if (account === null || typeof account !== "object" || Array.isArray(account)) {
			throw new AIError.ConfigurationError(`${path}.account must be an object`);
		}
		const rawAccount = account as Record<string, unknown>;
		const unknownAccountFields = Object.keys(rawAccount).filter(
			key => !SELECTOR_FIELDS.includes(key as (typeof SELECTOR_FIELDS)[number]),
		);
		if (unknownAccountFields.length > 0) {
			throw new AIError.ConfigurationError(`${path}.account has unknown fields: ${unknownAccountFields.join(", ")}`);
		}
		const selector: { -readonly [K in keyof AuthAccountSelector]: AuthAccountSelector[K] } = {};
		for (const field of SELECTOR_FIELDS) {
			const fieldValue = rawAccount[field];
			if (fieldValue === undefined) continue;
			if (typeof fieldValue !== "string") {
				throw new AIError.ConfigurationError(`${path}.account.${field} must be a non-empty string`);
			}
			selector[field] = fieldValue;
		}
		const parsed: AuthAccountPolicy = {
			provider: policy.provider as string,
			account: selector,
			...(policy.priority === undefined ? {} : { priority: policy.priority as number }),
			...(policy.reservePct === undefined ? {} : { reservePct: policy.reservePct as number }),
		};
		validateAuthAccountPolicy(parsed, index);
		return parsed;
	});
}

function validateAuthAccountPolicy(policy: AuthAccountPolicy, index: number): void {
	const path = `auth.accountPolicies[${index}]`;
	if (
		typeof policy.provider !== "string" ||
		policy.provider.length === 0 ||
		policy.provider.trim() !== policy.provider
	) {
		throw new AIError.ConfigurationError(
			`${path}.provider must be a non-empty string without surrounding whitespace`,
		);
	}
	if (!policy.account || typeof policy.account !== "object") {
		throw new AIError.ConfigurationError(`${path}.account must be an object`);
	}
	for (const field of SELECTOR_FIELDS) {
		const value = policy.account[field];
		if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
			throw new AIError.ConfigurationError(`${path}.account.${field} must be a non-empty string`);
		}
	}
	if (!BASE_IDENTITY_FIELDS.some(field => policy.account[field] !== undefined)) {
		throw new AIError.ConfigurationError(
			`${path}.account must include at least one of email, accountId, or projectId`,
		);
	}
	if (policy.priority !== undefined && (typeof policy.priority !== "number" || !Number.isFinite(policy.priority))) {
		throw new AIError.ConfigurationError(`${path}.priority must be a finite number`);
	}
	if (
		policy.reservePct !== undefined &&
		(typeof policy.reservePct !== "number" ||
			!Number.isFinite(policy.reservePct) ||
			policy.reservePct < 0 ||
			policy.reservePct > 100)
	) {
		throw new AIError.ConfigurationError(`${path}.reservePct must be a finite number between 0 and 100`);
	}
}

/** Strictly parse `retry.usageReservePct`, defaulting when unset. */
export function parseUsageReservePct(value: unknown): number {
	const reservePct = value === undefined ? DEFAULT_USAGE_RESERVE_PCT : value;
	if (typeof reservePct !== "number" || !Number.isFinite(reservePct)) {
		throw new AIError.ConfigurationError("retry.usageReservePct must be a finite number");
	}
	return reservePct;
}

/** Validated per-account routing policies (priority/reserve) plus the global reserve fallback. */
export class AccountPolicies {
	readonly #policies: AuthAccountPolicies;
	readonly defaultReservePct: number;

	constructor(policies: AuthAccountPolicies = [], defaultReservePct?: number) {
		policies.forEach(validateAuthAccountPolicy);
		this.#policies = policies;
		this.defaultReservePct =
			typeof defaultReservePct === "number" && Number.isFinite(defaultReservePct)
				? Math.max(0, Math.min(100, defaultReservePct))
				: DEFAULT_USAGE_RESERVE_PCT;
	}

	/** Whether any policy targets `provider`. */
	has(provider: string): boolean {
		return this.#policies.some(policy => policy.provider === provider);
	}

	/** A reserve override needs a usage source for its provider; fail closed instead of silently ignoring it. */
	validateUsageCapability(provider: string, canFetchUsage: boolean): void {
		const policyIndex = this.#policies.findIndex(
			policy => policy.provider === provider && policy.reservePct !== undefined,
		);
		if (policyIndex !== -1 && !canFetchUsage) {
			throw new AIError.ConfigurationError(
				`auth.accountPolicies[${policyIndex}].reservePct requires a usage provider for ${provider}`,
			);
		}
	}

	/** Every policy for `provider` must match exactly one stored OAuth account, and no two policies the same one. */
	validateFor(provider: string, credentials: readonly { type: string }[]): void {
		const policies = this.#policies
			.map((policy, index) => ({ policy, index }))
			.filter(({ policy }) => policy.provider === provider);
		if (policies.length === 0) return;
		const oauthCredentials = credentials.filter(
			(credential): credential is { type: "oauth" } & AccountIdentity => credential.type === "oauth",
		);
		if (oauthCredentials.length === 0) return;

		const claimedCredentials = new Map<number, number>();
		for (const { policy, index } of policies) {
			const matches: number[] = [];
			for (let credentialIndex = 0; credentialIndex < oauthCredentials.length; credentialIndex += 1) {
				if (matchesAuthAccountSelector(policy.account, oauthCredentials[credentialIndex]!)) {
					matches.push(credentialIndex);
				}
			}
			const path = `auth.accountPolicies[${index}].account`;
			if (matches.length === 0) {
				throw new AIError.ConfigurationError(`${path} matches no stored OAuth account for ${provider}`);
			}
			if (matches.length > 1) {
				throw new AIError.ConfigurationError(
					`${path} matches ${matches.length} stored OAuth accounts for ${provider}; add another identity field`,
				);
			}
			const credentialIndex = matches[0]!;
			const previousPolicyIndex = claimedCredentials.get(credentialIndex);
			if (previousPolicyIndex !== undefined) {
				throw new AIError.ConfigurationError(
					`auth.accountPolicies[${previousPolicyIndex}] and auth.accountPolicies[${index}] match the same stored OAuth account for ${provider}`,
				);
			}
			claimedCredentials.set(credentialIndex, index);
		}
	}

	/** Configured policy matching an OAuth identity; read-only, same conjunctive match as routing. */
	find(provider: string, identity: AccountIdentity): AuthAccountPolicy | undefined {
		return this.#policies.find(
			policy => policy.provider === provider && matchesAuthAccountSelector(policy.account, identity),
		);
	}

	/** Configured policy for a stored credential; API keys never carry account policies. */
	forCredential(provider: string, credential: { type: string } & AccountIdentity): AuthAccountPolicy | undefined {
		return credential.type === "oauth" ? this.find(provider, credential) : undefined;
	}
}
