import { describe, expect, it } from "bun:test";
import { rewriteClinePassError, rewriteCopilotError } from "../utils/http-inspector";
import { isAuthRetryableError } from "./auth-classify";
import { AnthropicApiError, AnthropicStreamEnvelopeError, ProviderHttpError } from "./classes";
import {
	classify,
	classifyMessage,
	create,
	Flag,
	is,
	isContextOverflow,
	isGitHubCopilotPolicyDenial,
	isUsageLimit,
	retriable,
} from "./flags";
import {
	calculateRateLimitBackoffMs,
	isUsageLimitOutcome,
	matchesUsageLimitText,
	parseRateLimitReason,
} from "./rate-limit";

function errorWithStatus(status: number): Error & { status: number } {
	return Object.assign(new Error(`${status} ${status === 403 ? "Forbidden" : "Unauthorized"}`), { status });
}

describe("isGitHubCopilotPolicyDenial", () => {
	it("preserves Copilot credentials for model-policy 403s identified by status", () => {
		expect(isGitHubCopilotPolicyDenial("github-copilot", 403, "403 Forbidden")).toBe(true);
	});

	it("preserves Copilot credentials when only the normalized policy-denial message survives", () => {
		const message = rewriteCopilotError("403 Forbidden", errorWithStatus(403), "github-copilot");

		expect(message).toContain("GitHub Copilot access denied (HTTP 403)");
		expect(isGitHubCopilotPolicyDenial("github-copilot", undefined, message)).toBe(true);
	});

	it("does not preserve invalid Copilot credentials rejected with 401", () => {
		const message = rewriteCopilotError("401 Unauthorized", errorWithStatus(401), "github-copilot");

		expect(message).toContain("GitHub Copilot authentication failed (HTTP 401)");
		expect(isGitHubCopilotPolicyDenial("github-copilot", 401, message)).toBe(false);
	});

	it("does not classify another provider's 403 as a Copilot policy denial", () => {
		expect(isGitHubCopilotPolicyDenial("openai", 403, "403 Forbidden")).toBe(false);
	});
});

describe("recoverable provider error classification", () => {
	it("retries an Anthropic envelope that ends before message_stop", () => {
		const id = classify(new AnthropicStreamEnvelopeError("stream ended before message_stop"));

		expect(is(id, Flag.Transient)).toBe(true);
		expect(retriable(id)).toBe(true);
	});

	it("retries Fireworks model-side NaN failures reported as HTTP 400", () => {
		const error = new ProviderHttpError(
			"Floating point NaN (not-a-number) is detected in generation. This is a model-side numerical error.",
			400,
			{ code: "invalid_request_error" },
		);
		const id = classify(error);

		expect(is(id, Flag.Transient)).toBe(true);
		expect(retriable(id)).toBe(true);
	});

	it("keeps genuine HTTP 400 request validation failures terminal", () => {
		const error = new ProviderHttpError("Invalid value for 'temperature': must be <= 2.", 400, {
			code: "invalid_request_error",
		});
		const id = classify(error);

		expect(is(id, Flag.Transient)).toBe(false);
		expect(retriable(id)).toBe(false);
	});

	it("classifies provider message-count caps as context overflow rather than transient transport failure", () => {
		const id = classify(new ProviderHttpError("Chat history exceeds the 800-message limit", 413));

		expect(is(id, Flag.ContextOverflow)).toBe(true);
		expect(is(id, Flag.Transient)).toBe(false);
	});

	it("retries auth-gateway 5xx failures without treating namespaced 4xx failures as transient", () => {
		const gatewayFailure = classify(new Error("auth-gateway 524: <none>"), "anthropic-messages");
		const missingRoute = classify(new Error("auth-gateway 404: not found"), "anthropic-messages");

		expect(is(gatewayFailure, Flag.Transient)).toBe(true);
		expect(retriable(gatewayFailure)).toBe(true);
		expect(is(missingRoute, Flag.Transient)).toBe(false);
		expect(retriable(missingRoute)).toBe(false);
	});

	it("retries a bare closed-socket transport error without matching embedded application wording", () => {
		const closedSocket = classify(new Error("Socket is closed"));
		const applicationError = classify(new Error("validation failed because socket is closed to remote control"));

		expect(is(closedSocket, Flag.Transient)).toBe(true);
		expect(retriable(closedSocket)).toBe(true);
		expect(is(applicationError, Flag.Transient)).toBe(false);
		expect(retriable(applicationError)).toBe(false);
	});
});

describe("HTTP 413 payload rejection classification", () => {
	it("treats a status-only 413 as a byte/media payload rejection, not a token overflow", () => {
		const id = classifyMessage({ errorStatus: 413, errorMessage: "413 Request Entity Too Large" });

		expect(is(id, Flag.PayloadRejected)).toBe(true);
		expect(is(id, Flag.ContextOverflow)).toBe(false);
	});

	it("keeps a 413 carrying token-context evidence a pure context overflow", () => {
		const id = classifyMessage({
			errorStatus: 413,
			errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
		});

		expect(is(id, Flag.ContextOverflow)).toBe(true);
		expect(is(id, Flag.PayloadRejected)).toBe(false);
	});

	it("never retries a payload rejection even when a gateway wraps it in transient wording", () => {
		const id = classifyMessage({ errorStatus: 413, errorMessage: "Provider returned error: 413 Payload Too Large" });

		expect(is(id, Flag.PayloadRejected)).toBe(true);
		expect(retriable(id)).toBe(false);
	});

	it("drops a status-inferred payload bit once the final error text proves token overflow", () => {
		const id = classifyMessage({
			errorId: create(Flag.PayloadRejected),
			errorStatus: 413,
			errorMessage: "This model's maximum context length is 128000 tokens. However, you requested 140000 tokens.",
		});

		expect(is(id, Flag.ContextOverflow)).toBe(true);
		expect(is(id, Flag.PayloadRejected)).toBe(false);
	});
});

describe("Anthropic organization OAuth denial", () => {
	const body =
		'{"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization.","details":{"error_code":"oauth_not_allowed_for_organization"}}}';

	it("classifies the parsed response as a rotatable account policy, not blocked content", async () => {
		const error = await AnthropicApiError.fromResponse(new Response(body, { status: 403 }));
		const id = classify(error, "anthropic-messages");

		expect(error.code).toBe("oauth_not_allowed_for_organization");
		expect(is(id, Flag.AccountPolicy)).toBe(true);
		expect(is(id, Flag.ContentBlocked)).toBe(false);
		expect(isAuthRetryableError(error)).toBe(true);
	});

	it("classifies the persisted assistant error the same way", () => {
		const failed = { provider: "anthropic", errorStatus: 403, errorMessage: `403 ${body}` };

		expect(is(classifyMessage(failed), Flag.AccountPolicy)).toBe(true);
		expect(isAuthRetryableError(failed)).toBe(true);
	});
});

describe("Anthropic credits_required entitlement wall", () => {
	it("rotates on the documented entitlement error but not on unrelated usage-credit diagnostics", () => {
		expect(
			matchesUsageLimitText(
				'400 {"type":"error","error":{"type":"invalid_request_error","message":"Usage credits are required for this model.","details":{"error_code":"credits_required"}}}',
			),
		).toBe(true);
		expect(matchesUsageLimitText("Failed to fetch usage credits from billing service")).toBe(false);
	});
});

describe("billing-cap rotation", () => {
	it("rotates on 402 account-funds exhaustion worded in the body or the error code", () => {
		expect(
			isUsageLimit(
				new ProviderHttpError("Upstream request failed: Insufficient account funds", 402, { code: "server_error" }),
			),
		).toBe(true);
		expect(isUsageLimit(new ProviderHttpError('{"error":{"code":"insufficient_account_funds"}}', 402))).toBe(true);
		expect(
			isUsageLimit(new ProviderHttpError("Upstream request failed", 402, { code: "insufficient-account-funds" })),
		).toBe(true);
		expect(isUsageLimit(new ProviderHttpError("A subscription is required for this endpoint", 402))).toBe(false);
	});

	it("rotates on Cursor prepaid-balance exhaustion but not on the changeable pricing gate", () => {
		const prepaid =
			"Cursor USAGE_PRICING_REQUIRED: Your prepaid balance is used up: Add funds or enable auto top-up in your billing settings to keep going.";
		expect(parseRateLimitReason(prepaid)).toBe("QUOTA_EXHAUSTED");
		expect(isUsageLimitOutcome(429, prepaid)).toBe(true);
		expect(isUsageLimit(new ProviderHttpError(prepaid, 429))).toBe(true);
		expect(matchesUsageLimitText("Cursor USAGE_PRICING_REQUIRED_CHANGEABLE: Switch to a different model")).toBe(
			false,
		);
	});

	it("keeps rolling-window TPM/RPM throttles in the transient lane", () => {
		const tpmExhausted =
			"429 tpm exhausted\ntpm exhausted (type=quota_exceeded_error param=8)\ntpm exhausted (type=quota_exceeded_error param=8) (type=quota_exceeded_error)";
		expect(parseRateLimitReason(tpmExhausted)).toBe("RATE_LIMIT_EXCEEDED");
		expect(calculateRateLimitBackoffMs(parseRateLimitReason(tpmExhausted))).toBeLessThanOrEqual(60_000);
		expect(matchesUsageLimitText(tpmExhausted)).toBe(false);
		expect(isUsageLimit(new ProviderHttpError(tpmExhausted, 429, { code: "quota_exceeded_error" }))).toBe(false);
		expect(isUsageLimitOutcome(429, tpmExhausted)).toBe(false);
		expect(parseRateLimitReason("429 inference exceeds tpm/rpm limit")).toBe("RATE_LIMIT_EXCEEDED");
		expect(parseRateLimitReason("429 (code=RateLimitExceeded.EndpointTPMExceeded)")).toBe("RATE_LIMIT_EXCEEDED");

		const planQuota = "429 Your plan quota is exhausted; the plan TPM is 1000 (type=quota_exceeded_error)";
		expect(parseRateLimitReason(planQuota)).toBe("QUOTA_EXHAUSTED");
		expect(isUsageLimitOutcome(429, planQuota)).toBe(true);
	});
});

describe("Strata context overflow", () => {
	it.each([
		"prompt (105522 tokens) + max tokens (25571) exceeds the context (131072); requests are never truncated",
		"prompt (131072 tokens) leaves no room to answer in the context (131072); requests are never truncated",
		"PROMPT ( 105522  TOKENS )+MAX  TOKENS( 25571 ) EXCEEDS  THE CONTEXT( 131072 )",
	])("recognizes token-context evidence without usage: %s", detail => {
		const errorMessage = `400 ${detail}\n${detail} (type=invalid_request_error)`;
		expect(isContextOverflow({ stopReason: "error", errorMessage })).toBe(true);
		const id = classifyMessage({ errorMessage, errorStatus: 400 });
		expect(is(id, Flag.ContextOverflow)).toBe(true);
		expect(is(id, Flag.PayloadRejected)).toBe(false);
	});

	it("does not treat an output-token cap as context overflow", () => {
		const errorMessage = "400 max tokens (25571) exceeds the output limit (16384)";
		expect(isContextOverflow({ stopReason: "error", errorMessage })).toBe(false);
	});
});

describe("ClinePass error handling", () => {
	it("keeps sibling credentials on a per-model surface-gate 403 but rotates on a plain 403", () => {
		const gate = Object.assign(new Error("403 This model is only available via Cline product surfaces"), {
			status: 403,
		});
		expect(isAuthRetryableError(gate)).toBe(false);
		expect(isAuthRetryableError(errorWithStatus(403))).toBe(true);
	});

	it("treats subscription-window and free-tier caps as quota exhaustion", () => {
		expect(parseRateLimitReason("ClinePass limit reached for the 5 hour window")).toBe("QUOTA_EXHAUSTED");
		expect(parseRateLimitReason("Free limit reached on model x, try again in 3h")).toBe("QUOTA_EXHAUSTED");
	});

	it("rewrites a not-subscribed rejection into the free-tier hint only for ClinePass", () => {
		const raw = "400 User is not subscribed to required model plan";
		expect(rewriteClinePassError(raw, "cline-pass")).toContain("requires a ClinePass subscription");
		expect(rewriteClinePassError(raw, "openrouter")).toBe(raw);
	});
});
