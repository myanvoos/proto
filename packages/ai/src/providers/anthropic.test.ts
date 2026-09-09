import { describe, expect, it } from "bun:test";
import { isInvalidThinkingSignatureError } from "./anthropic";

describe("isInvalidThinkingSignatureError", () => {
	it("recognizes Anthropic's invalid-signature rejection", () => {
		expect(isInvalidThinkingSignatureError("messages.1.content.0: Invalid `signature` in `thinking` block")).toBe(
			true,
		);
	});

	it("recognizes both Bedrock missing-signature phrasings", () => {
		expect(
			isInvalidThinkingSignatureError(
				"ValidationException: messages.369.content.0.thinking.signature: Field required",
			),
		).toBe(true);
		expect(isInvalidThinkingSignatureError("content.2.thinking.signature is required")).toBe(true);
	});

	it("does not classify another required thinking field as a signature rejection", () => {
		expect(isInvalidThinkingSignatureError("messages.1.content.0.thinking.thinking: Field required")).toBe(false);
	});
});
