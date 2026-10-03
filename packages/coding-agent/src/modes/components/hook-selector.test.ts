import { describe, expect, it } from "bun:test";
import { initThemeSync } from "../theme/theme";
import { HookSelectorComponent, type HookSelectorOptions } from "./hook-selector";

initThemeSync();

function pick(options: string[], keys: string[], opts?: HookSelectorOptions): string | undefined {
	let selected: string | undefined;
	const component = new HookSelectorComponent(
		"Pick one",
		options,
		option => {
			selected = option;
		},
		() => {},
		opts,
	);
	for (const key of keys) component.handleInput(key);
	return selected;
}

describe("HookSelectorComponent digit shortcuts", () => {
	it("confirms the option whose label starts with the pressed digit", () => {
		expect(pick(["Detected item", "1. First", "2. Second", "3. Third"], ["3"])).toBe("3. Third");
	});

	it("ignores digits targeting disabled, missing, or unnumbered options", () => {
		expect(pick(["1. First", "2. Disabled", "3. Third"], ["2"], { disabledIndices: [1] })).toBeUndefined();
		expect(pick(["1. First", "2. Second"], ["9"])).toBeUndefined();
		expect(pick(["First", "Second", "Third"], ["3"])).toBeUndefined();
	});

	it("only moves the cursor on checkbox menus", () => {
		expect(pick(["1. First", "2. Second", "3. Third"], ["2"], { selectionMarker: "checkbox" })).toBeUndefined();
		expect(pick(["1. First", "2. Second", "3. Third"], ["2", "\n"], { selectionMarker: "checkbox" })).toBe(
			"2. Second",
		);
	});
});
