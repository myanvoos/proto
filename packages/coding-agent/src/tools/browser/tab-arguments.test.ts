import { expect, test } from "bun:test";
import { assertTabPressArgs } from "./tab-arguments";

test("tab.press rejects (selector, key) with the corrected call", () => {
	expect(() => assertTabPressArgs("#search", "Enter")).toThrow(
		'Did you mean tab.press("Enter", { selector: "#search" })?',
	);
	expect(() => assertTabPressArgs("Enter", { selector: "#search" })).not.toThrow();
	expect(() => assertTabPressArgs("Enter")).not.toThrow();
});
