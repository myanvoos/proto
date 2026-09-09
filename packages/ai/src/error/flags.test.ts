import { describe, expect, it } from "bun:test";
import { rewriteCopilotError } from "../utils/http-inspector";
import { AnthropicStreamEnvelopeError, ProviderHttpError } from "./classes";
import { classify, Flag, is, isGitHubCopilotPolicyDenial, retriable } from "./flags";

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
