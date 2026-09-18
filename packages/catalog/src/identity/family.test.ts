import { describe, expect, it, spyOn } from "bun:test";
import { isQwenModelId } from "./family";

const MAX_EXPECTED_MEMO_ENTRIES = 4_096;

describe("family classifier memoization", () => {
	it("evicts externally supplied model ids instead of retaining them permanently", () => {
		const prefix = `bounded-family-cache-${crypto.randomUUID()}`;
		const probe = `${prefix}-probe`;
		let probeEvaluations = 0;
		const originalToLowerCase = String.prototype.toLowerCase;
		const lowercaseSpy = spyOn(String.prototype, "toLowerCase").mockImplementation(function (this: string): string {
			if (String(this) === probe) probeEvaluations++;
			return originalToLowerCase.call(this);
		});

		try {
			isQwenModelId(probe);
			for (let index = 0; index < MAX_EXPECTED_MEMO_ENTRIES; index++) {
				isQwenModelId(`${prefix}-${index}`);
			}
			isQwenModelId(probe);
		} finally {
			lowercaseSpy.mockRestore();
		}

		expect(probeEvaluations).toBe(2);
	});
});
