import { extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import { isAccountPolicyError, isClinePassSurfaceGateMessage, isOAuthExpiry, isUsageLimit } from "./flags";
import { OAuthError } from "./oauth";
import { isConcurrencyCapExclusion, isUsageLimitOutcome } from "./rate-limit";

export function isDefinitiveOAuthFailure(errorMsg: string): boolean {
	return isOAuthExpiry(errorMsg);
}

const INVALIDATED_OAUTH_TOKEN_PATTERN = /\binvalidated oauth token\b/i;

export function isInvalidatedOAuthTokenError(error: unknown): boolean {
	if (typeof error === "object" && error !== null && "errorMessage" in error) {
		const errorMessage =
			"errorClassificationMessage" in error ? error.errorClassificationMessage : error.errorMessage;
		if (typeof errorMessage === "string" && INVALIDATED_OAUTH_TOKEN_PATTERN.test(errorMessage)) return true;
	}
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	return message !== undefined && INVALIDATED_OAUTH_TOKEN_PATTERN.test(message);
}

export function isAuthRetryableError(error: unknown): boolean {
	if (error instanceof OAuthError && error.kind === "token-refresh") return true;
	if (isUsageLimit(error)) return true;
	if (isAccountPolicyError(error)) return true;
	if (isInvalidatedOAuthTokenError(error)) return true;
	let httpStatus = extractHttpStatusFromError(error);
	let message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	if (typeof error === "object" && error !== null) {
		if (httpStatus === undefined && "errorStatus" in error && typeof error.errorStatus === "number") {
			httpStatus = error.errorStatus;
		}
		if (message === undefined && "errorMessage" in error && typeof error.errorMessage === "string") {
			message = error.errorMessage;
		}
	}
	const embeddedStatus = message ? extractHttpStatusFromError({ message }) : undefined;
	const status = httpStatus ?? embeddedStatus;
	if (isConcurrencyCapExclusion(status, message)) return false;
	// A Cline surface-gate 403 is per-model client policy: sibling keys fail identically, so rotation only burns them.
	if (isClinePassSurfaceGateMessage(message)) return false;
	if (status === 401 || status === 403) return true;
	return isUsageLimitOutcome(status, message);
}
