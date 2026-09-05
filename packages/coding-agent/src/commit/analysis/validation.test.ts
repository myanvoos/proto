import { describe, expect, test } from "bun:test";
import { validateAnalysis, validateScope, validateSummary } from "./validation";

describe("legacy commit contract validation", () => {
	test("requires a lowercase recognized past-tense summary verb", () => {
		expect(validateSummary("added parser guard", 72).valid).toBe(true);
		expect(validateSummary("Added parser guard", 72).valid).toBe(false);
		expect(validateSummary("improves parser guard", 72).valid).toBe(false);
	});

	test("rejects generic scopes and oversized detail lists", () => {
		expect(validateScope("src").valid).toBe(false);
		const analysis = {
			type: "fix" as const,
			scope: "parser",
			details: Array.from({ length: 7 }, (_, index) => ({ text: `fixed item ${index}.`, userVisible: false })),
			issueRefs: [],
		};
		expect(validateAnalysis(analysis).valid).toBe(false);
	});
});
