import { describe, expect, it } from "bun:test";
import { invalidModelSelectorReason } from "../config/model-resolver";

describe("subagent model selector validation", () => {
	it("rejects default/inherit selectors with thinking suffixes", () => {
		expect(invalidModelSelectorReason("default:high", "Subagent")).toContain("@default");
		expect(invalidModelSelectorReason("DEFAULT:high", "Subagent")).toContain("@default");
		expect(invalidModelSelectorReason("inherit:low", "Subagent")).toContain("@default");
		expect(invalidModelSelectorReason("@default:high", "Subagent")).toBeUndefined();
	});
});
