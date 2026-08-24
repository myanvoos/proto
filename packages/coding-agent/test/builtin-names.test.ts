import { describe, expect, it } from "bun:test";
import { normalizeToolName } from "../src/tools/builtin-names";

describe("normalizeToolName", () => {
	it("lowercases canonical builtins and leaves unknown names untouched", () => {
		expect(normalizeToolName("Read")).toBe("read");
		expect(normalizeToolName("search")).toBe("search");
		expect(normalizeToolName("CaseAdd")).toBe("CaseAdd");
		expect(normalizeToolName("Constructor")).toBe("Constructor");
	});
});
