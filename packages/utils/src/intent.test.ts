import { describe, expect, it } from "bun:test";
import { normalizeIntent } from "./intent";

describe("normalizeIntent", () => {
	it("drops trailing periods and surrounding whitespace", () => {
		expect(normalizeIntent("  Reading model role settings.  ")).toBe("Reading model role settings");
		expect(normalizeIntent("Waiting for build ...")).toBe("Waiting for build");
	});

	it("keeps interior periods and treats period-only intents as empty", () => {
		expect(normalizeIntent("Reading v1.2 config")).toBe("Reading v1.2 config");
		expect(normalizeIntent(" . ")).toBeUndefined();
		expect(normalizeIntent("   ")).toBeUndefined();
	});
});
