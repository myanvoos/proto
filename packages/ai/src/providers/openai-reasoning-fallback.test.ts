import { describe, expect, it } from "bun:test";
import { resolveOpenAIReasoningEffortFallback } from "./openai-reasoning-fallback";

function reasoningRejection(message: string): {
	error: Error;
	captured: { status: number; bodyText: string; bodyJson: { error: { message: string } } };
} {
	return {
		error: new Error(message),
		captured: {
			status: 400,
			bodyText: message,
			bodyJson: { error: { message } },
		},
	};
}

describe("resolveOpenAIReasoningEffortFallback", () => {
	it("clamps a fieldless valid-levels rejection to the lowest supported effort", () => {
		const { error, captured } = reasoningRejection(
			'level "none" not supported, valid levels: low, medium, high, xhigh, max',
		);

		expect(
			resolveOpenAIReasoningEffortFallback(
				error,
				captured,
				{ reasoning: { effort: "none" } },
				{
					explicitDisable: true,
				},
			),
		).toBe("low");
	});

	it("clamps Copilot's fieldless Supported-values rejection to the lowest supported effort", () => {
		const { error, captured } = reasoningRejection(
			"Unsupported value: 'none' is not supported with the 'gpt-6-astra' model. " +
				"Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'.",
		);

		expect(
			resolveOpenAIReasoningEffortFallback(
				error,
				captured,
				{ reasoning: { effort: "none" } },
				{
					explicitDisable: true,
				},
			),
		).toBe("low");
	});

	it("does not mistake another field's Supported-values rejection for reasoning effort", () => {
		const { error, captured } = reasoningRejection(
			"Unsupported value: 'high' for text verbosity. Supported values are: 'low', 'medium'.",
		);

		expect(resolveOpenAIReasoningEffortFallback(error, captured, { reasoning: { effort: "high" } })).toBeUndefined();
	});
});
